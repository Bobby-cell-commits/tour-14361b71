// Lean shipped viewer (ADR 0001 Path B) — boot + orchestration.
// Engine idioms ported from prototypes/viewer-base-playcanvas/ (Sessions A–C).
import {
  Application, Asset, AssetListLoader, Entity, FILLMODE_FILL_WINDOW, RESOLUTION_AUTO,
  Color, Mat4, Vec3, createGraphicsDevice, DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2,
} from 'playcanvas';
import { createCatcher } from './catcher.js';
import { buildBox, normalizeGlb, createGhost } from './staging.js';
import { loadLighting, lightingPlan } from './lighting.js';
import { loadStaging, loadCatalog, createStagingDoc } from './staging-doc.js';
import { loadCollisionSidecar } from './collision.js';
import { createWalk } from './walk.js';
import { loadNavmesh, createNavWalk } from './navwalk.js';
import { loadPath, createRails } from './rails.js';
import { createUrlGuard } from './urlguard.js';

const params = new URLSearchParams(location.search);
const status = document.getElementById('status');
const stateEl = document.getElementById('state');
const hudEl = document.getElementById('hud');
if (params.get('hud') === '0') { hudEl.style.display = 'none'; stateEl.style.display = 'none'; }
if (params.get('mobile') === '1') stateEl.style.cssText += 'font-size:22px;font-weight:700;color:#0f0';

// --- visible refusal/error surface, own root (F-29/F-35). #status lives inside #hud, which
// ?hud=0 hides wholesale — a refused base or a malformed sidecar must never fail silently.
window.__warnings = [];
let warnEl = null;
function showWarning(text) {
  console.warn('[viewer]', text);
  window.__warnings.push(text);
  if (!warnEl) {
    warnEl = document.createElement('div');
    warnEl.id = 'viewer-warning';
    warnEl.style.cssText =
      'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:30;' +
      'max-width:min(92vw,640px);background:#3a1414;color:#ffd9d9;border:1px solid #a33;' +
      'border-radius:8px;padding:8px 12px;font:12.5px/1.45 system-ui,sans-serif;white-space:pre-wrap;';
    document.body.appendChild(warnEl);
  }
  warnEl.textContent = warnEl.textContent ? `${warnEl.textContent}\n${text}` : text;
}

// --- numeric URL params (F-35): a NaN must never reach an entity transform or a shader
// uniform (?op=abc used to render the WHOLE splat black, silently). Absent -> null so the
// caller keeps its default; present-but-not-a-number -> null + a visible warning.
function numParam(name, { min = -Infinity, max = Infinity } = {}) {
  const raw = params.get(name);
  if (raw == null || raw === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) { showWarning(`?${name}=${raw} is not a number — ignored`); return null; }
  return Math.min(Math.max(v, min), max);
}
function vec3Param(name) {
  const raw = params.get(name);
  if (raw == null || raw === '') return null;
  const v = raw.split(',').map(Number);
  if (v.length !== 3 || !v.every(Number.isFinite)) {
    showWarning(`?${name}=${raw} is not x,y,z — ignored`); return null;
  }
  return v;
}
const isVec3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);

// #b= (fragment — never reaches any server; the deploy_share.sh link shape) wins over ?base= (dev knob).
// A bare slug (no '/' or ':') expands to the shares prefix — keeps partner links short while the
// slug itself stays in the fragment, never in the public page repo (the host alone is not secret).
const SHARES_BASE = 'https://bvvhngyjxuxxlataigfn.supabase.co/storage/v1/object/public/shares';
const guard = createUrlGuard({ sharesBase: SHARES_BASE });
const hashParams = new URLSearchParams(location.hash.slice(1));
const rawB = hashParams.get('b');
const expandedB = rawB && !/[/:]/.test(rawB) ? `${SHARES_BASE}/${rawB}` : rawB;
// F-29: anything containing '/' or ':' used to pass through verbatim — a crafted #b= rendered
// attacker-controlled SOG/GLB/JSON on the operator's own origin (and delivered the F-30 XSS).
let BASE = (expandedB || params.get('base') || 'assets').replace(/\/+$/, '');
if (!guard.isAllowed(BASE)) {
  showWarning(`refused asset base "${BASE}" — only this origin, the shares host (${guard.sharesOrigin}) ` +
              'and localhost (dev) are allowed. Falling back to the packaged assets/.');
  BASE = 'assets';
}
// window.VIEWER_DEFAULTS: deploy-injected page defaults (review page only; absent on dev + customer)
const sceneName = params.get('scene') || window.VIEWER_DEFAULTS?.scene || 'living';
// a ?scene= containing '/' is a URL scene (streamed lod-meta.json etc.); relative forms are
// BASE-relative, absolute (scheme://, //, /-rooted) pass through the join but NOT the allowlist.
// ?spawnas= names the sidecars (spawn/lighting/staging) the URL form can't derive
const isUrlScene = sceneName.includes('/');
const isAbsUrl = s => /^([a-z][a-z0-9+.-]*:)?\/\//i.test(s) || s.startsWith('/');
const resolveAsset = s => (s == null || isAbsUrl(s)) ? s : `${BASE}/${s}`;
// allowlisted or refused outright — a refused scene/asset is NOT loaded (no silent fallback
// to a different scene: the operator must see that the link was rejected)
function guardedUrl(url, what) {
  if (url == null) return null;
  if (guard.isAllowed(url)) return url;
  showWarning(`refused ${what} "${url}" — not this origin or the shares host. Not loaded.`);
  return null;
}
const sceneUrl = guardedUrl(isUrlScene ? resolveAsset(sceneName) : `${BASE}/${sceneName}.sog`, 'scene');
const sidecarName = params.get('spawnas') ?? (isUrlScene ? 'living' : sceneName);
const glbUrl = guardedUrl(resolveAsset(params.get('asset')), '?asset=');
// ?nav=0 disables the navmesh walk (voxel walk if its sidecar exists); ?nav=<name> picks
// <base>/<name>.navmesh.bin (A/B builds); default <sidecar>.navmesh.bin. Navmesh wins over voxel.
const navParam = params.get('nav');
const navName = navParam === '0' ? null : (navParam && navParam !== '1' ? navParam : sidecarName);
// ?mode=rails is the pilot-safe waypoint tour (F-13) — zero collision surface. ?rails=0 opts
// the sidecar out entirely (no fetch, no button); any other ?mode= value is simply not rails.
const wantRails = params.get('rails') !== '0';
const railsAutoEnter = params.get('mode') === 'rails';
const T0 = performance.now();
let ttiS = null;
let ttfrS = null;

// --- app boot: tutorial shape, device via createGraphicsDevice (WebGPU-first; the
// engine auto-appends WEBGL2 + NULL fallbacks). ?edit=1 forces webgl2 — the sync
// Picker returns [] on WebGPU. A GLSL→WGSL transpile fallback exists (pass
// glslangUrl/twgslUrl wasm URLs in the options) but is NOT wired — the catcher ships
// native WGSL twin chunks instead (catcher.js).
const canvas = document.createElement('canvas');
// without this the browser owns touch gestures — a drag scrolls/zooms the PAGE and the
// camera gets only the first few pixels before pointercancel (2026-08-31 phone session)
canvas.style.touchAction = 'none';
document.body.appendChild(canvas);
const editRequested = params.get('edit') === '1';
const deviceParam = params.get('device');           // 'webgpu' | 'webgl2'
let deviceTypes;
if (editRequested) {
  deviceTypes = [DEVICETYPE_WEBGL2];
  if (deviceParam === 'webgpu') console.warn('[viewer] ?edit=1 forces webgl2 (sync Picker)');
} else if (deviceParam === 'webgl2') deviceTypes = [DEVICETYPE_WEBGL2];
else deviceTypes = [DEVICETYPE_WEBGPU];             // fresh array per boot — createGraphicsDevice mutates it
const device = await createGraphicsDevice(canvas, { deviceTypes, antialias: false });
if (device.deviceType === 'null') {
  status.textContent = 'no graphics device (webgpu + webgl2 both unavailable)';
  window.__lastError = status.textContent;
  throw new Error(`[viewer] ${status.textContent}`);
}
// ?dpr= AFTER the await — WebGPU re-sets maxPixelRatio to 1 during device creation
const dprParam = numParam('dpr', { min: 0.25, max: window.devicePixelRatio || 3 });
if (dprParam != null) device.maxPixelRatio = dprParam;
const app = new Application(canvas, { graphicsDevice: device });
app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
app.setCanvasResolution(RESOLUTION_AUTO);
// ?budget= before the scene asset loads (read once at GSplatWorld construction) —
// scales STREAMED (octree) scenes only; a flat .sog is counted as fixed cost, and a
// single-LOD streamed export gives it nothing to drop (8T-verified inert). Tier default
// (mobile 1M / desktop 3M) future-proofs for multi-LOD assets; URL always wins.
const coarsePointer = matchMedia('(pointer: coarse)').matches;
const budgetParam = numParam('budget', { min: 50_000, max: 100_000_000 });
app.scene.gsplat.splatBudget = budgetParam != null ? Math.round(budgetParam) : (coarsePointer ? 1_000_000 : 3_000_000);
app.start();
window.addEventListener('resize', () => { app.resizeCanvas(); requestRender(); });

// --- render-on-demand (docs-sweep rider): render only when something changed. The gsplat
// director keeps sorting on skipped frames ('framerender' fires regardless) and asks for
// repaints via 'frame:request' while the async sort settles. ?continuous=1 restores
// render-every-rAF (use it to measure real fps). Only the literal '1' enables it — the
// old `!!params.get(...)` made the documented off-switch ?continuous=0 turn it ON (F-38).
const continuous = params.get('continuous') === '1';
app.autoRender = continuous;
function requestRender() { app.renderNextFrame = true; }
app.systems.gsplat.on('frame:request', requestRender);
for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup',
                  'touchstart', 'touchmove', 'touchend'])
  window.addEventListener(ev, requestRender, { passive: true });

// --- assets ---
// camera-controls is VENDORED (F-28) — absolute-ised against the document base because the
// engine's ESM script handler resolves a relative asset url against location.origin+pathname,
// which differs between /viewer-pc/index.html and a directory-style /review/ page.
const CC_URL = new URL('vendor/playcanvas/camera-controls.mjs', document.baseURI).href;
const ccAsset = new Asset('camera-controls', 'script', { url: CC_URL });
// a refused ?scene= / ?asset= (F-29) is simply absent — never silently swapped for another URL
const sceneAsset = sceneUrl ? new Asset(sceneName, 'gsplat', { url: sceneUrl }) : null;
const glbAsset = glbUrl ? new Asset('glb', 'container', { url: glbUrl }) : null;
const assetList = [ccAsset, sceneAsset, glbAsset].filter(Boolean);
const loader = new AssetListLoader(assetList, app.assets);
await new Promise(resolve => loader.load(resolve));
const failed = assetList.filter(a => !a.loaded);
let loaded = failed.length === 0 && !!sceneAsset;
if (!loaded) {
  status.textContent = `load FAILED: ${failed.map(a => a.name).join(', ')}`;
  window.__lastError = status.textContent;
  console.error('[viewer] load failed', failed.map(a => a.name));
}

// --- camera (spawn from <base>/<scene>.spawn.json — same frame as the pipeline emits) ---
const camera = new Entity('Camera');
camera.addComponent('camera', { nearClip: 0.05, farClip: 200, fov: 70, clearColor: new Color(0.10, 0.10, 0.12) });
// spawn.json is operator-supplied data: a missing/short/stringy position or lookAt used to
// produce a NaN camera matrix and a black screen with no error at all (F-35)
let spawn = null;
try {
  const sj = await fetch(`${BASE}/${sidecarName}.spawn.json`).then(r => r.ok ? r.json() : null);
  if (sj && isVec3(sj.position) && isVec3(sj.lookAt)) spawn = sj;
  else if (sj) showWarning(`${sidecarName}.spawn.json is malformed (need position + lookAt as [x,y,z] numbers) — using the default camera pose`);
} catch {}
camera.setPosition(...(spawn ? spawn.position : [0, 1.6, 3]));
app.root.addChild(camera);
if (spawn) camera.lookAt(...spawn.lookAt);
camera.addComponent('script');
camera.script.create('cameraControls');   // official ESM script (event.code-based — no keyCode shim needed)
// the script re-aims the camera at the WORLD ORIGIN on init (pose.look(position, Vec3.ZERO),
// camera-controls.mjs:604) — restore the spawn view by pointing its focus at the spawn lookAt
if (spawn) camera.script.cameraControls.focusPoint = new Vec3(...spawn.lookAt);

// --- lights: affect only overlay meshes — the splat is baked radiance ---
app.scene.ambientLight = new Color(0.45, 0.38, 0.30);
const sun = new Entity('sun');
sun.addComponent('light', { type: 'directional', color: new Color(1, 0.78, 0.52), intensity: 1.6, castShadows: false });
sun.setEulerAngles(50, -100, 0);   // fallback; lighting.json overrides below
app.root.addChild(sun);

// --- splat (unified rendering is the 2.21.4 default; scenes are canonical-upright) ---
const rot = vec3Param('rot') ?? [0, 0, 0];
const splat = new Entity(sceneName);
if (sceneAsset) splat.addComponent('gsplat', { asset: sceneAsset });
splat.setEulerAngles(...rot);
app.root.addChild(splat);
app.once('postrender', () => { ttfrS = +((performance.now() - T0) / 1000).toFixed(2); requestRender(); });
requestRender();

// --- staged object: box control + optional generated GLB ---
let assetTemplate = null, assetMeta = null;
if (glbUrl && loaded) {
  const norm = normalizeGlb(app, glbAsset, numParam('h', { min: 0.01, max: 100 }) ?? 0.8, glbUrl);
  assetTemplate = norm.entity;
  assetMeta = norm.meta;
}
let shape = assetTemplate ? 'asset' : 'box';
let obj = assetTemplate ?? buildBox();
obj.setPosition(1.5, 0, -0.5);
// ?obj=x,y,z + ?yaw=deg — shareable staged placement (viewerApi parity)
const objP = vec3Param('obj');
if (objP) obj.setPosition(...objP);
const yawP = numParam('yaw', { min: -3600, max: 3600 });
if (yawP != null) obj.setEulerAngles(0, yawP, 0);
app.root.addChild(obj);
const ghost = createGhost(app);
function setShape(name) {
  const p = obj.getPosition().clone(), r0 = obj.getEulerAngles().clone(), sc = obj.getLocalScale().clone(), vis = obj.enabled;
  app.root.removeChild(obj);
  shape = name;
  obj = (name === 'asset' && assetTemplate) ? assetTemplate : buildBox();
  obj.setPosition(p); obj.setEulerAngles(r0); obj.setLocalScale(sc); obj.enabled = vis;
  app.root.addChild(obj);
  ghost.set(obj, ghost.on);
  catcher.setCasterEntity(obj);
}

// --- contact-shadow catcher (issue #3) ---
const catcher = createCatcher(app, camera, { requestRender });
catcher.setCasterEntity(obj);
// ?op= is a shadow knob — applies with or without lighting.json. Clamped 0..1: an unclamped
// NaN reached uShadowStrength and mix(1.0, s.r, NaN) rendered the WHOLE splat black (F-35).
const opOverride = numParam('op', { min: 0, max: 1 });
if (opOverride != null) catcher.set({ strength: opOverride });
// F-34 (owner-measured 2026-09-03, OnePlus 8T, landscape, ?continuous=1): screen catcher ON
// 23–25 fps vs OFF 37–39 fps — the shadow pass costs ~35 % of the frame on a 2020 mid-range
// phone, over the 30 % line the run-sheet pre-committed. Default OFF on coarse pointers;
// ?shadow= still forces any mode on any device (the A/B links stay valid).
const shadowDefaultOn = matchMedia('(pointer: fine)').matches;
const shadowParam = params.get('shadow') ?? (glbUrl && shadowDefaultOn ? 'screen' : 'off');
if (shadowParam !== 'off') catcher.setMode(shadowParam);   // warm-frame gate defers internally

// --- staging document (issue #5): saved placements load in the customer path;
// ?staging=0 skips (pure review-link mode). Catalog + staging.json ride the same
// flat <base>/ dir as lighting.json.
const doc = createStagingDoc(app, catcher, { requestRender, base: BASE, allowUrl: guard.isAllowed });
const wantStaging = params.get('staging') !== '0';
let stagingState = { loaded: false, file: null };

// --- lighting.json consumer (issue #4): auto-apply when the file exists (?lighting=0
// disables, ?lighting=1 forces + warns if missing). ?sun= / ?op= override params win.
let lightingJson = null, lightingApplied = false;
function applyLighting(o = {}) {
  if (!lightingJson) { console.warn('[viewer] no lighting.json loaded'); return; }
  const plan = lightingPlan(lightingJson, {
    sunOverride: vec3Param('sun'), opacityOverride: opOverride,
  });
  for (const ent of [sun]) { ent.setPosition(...plan.position); ent.lookAt(...plan.lookAt); }
  catcher.setSun({ position: plan.position, lookAt: plan.lookAt });   // azimuth authoritative
  if (o.applyOpacity !== false) catcher.set({ strength: plan.strength });   // advisory default (or ?op= override)
  lightingApplied = true;
  console.log('[viewer] lighting.json applied', JSON.stringify({
    file: plan.file, azimuth: plan.azimuth, elev: plan.elevation,
    strength: plan.strength, override: plan.strengthIsOverride, advisory: plan.advisory,
  }));
  requestRender();
}
// A document whose major version we don't know is REFUSED, the way collision.js already
// refuses a non-1.1 voxel sidecar — a silently-ignored version field is not versioning (F-35).
const SUPPORTED_DOC_VERSION = 1;
function versionOk(json, what) {
  if (!json) return false;
  const v = Number(json.version);
  if (!Number.isFinite(v)) { showWarning(`${what} has no numeric "version" — refusing to apply it`); return false; }
  if (Math.floor(v) !== SUPPORTED_DOC_VERSION) {
    showWarning(`${what} is version ${json.version}; this viewer reads major ${SUPPORTED_DOC_VERSION} — refusing to apply it`);
    return false;
  }
  return true;
}

// lighting + staging load together so the apply order is deterministic:
// lighting first (advisory strength), then staging.shadow.strength, with ?op= above both.
// EVERY arm carries its own .catch (F-35): a truncated .voxel.bin used to reject the whole
// Promise.all, taking lighting AND the staged furniture down with walk mode.
const orNull = (p, what) => p.catch(err => { showWarning(`${what} failed to load — ${err}`); return null; });
const docReady = Promise.all([
  params.get('lighting') !== '0' ? orNull(loadLighting(BASE, sidecarName), 'lighting.json') : Promise.resolve(null),
  wantStaging ? orNull(loadStaging(BASE, sidecarName), 'staging.json') : Promise.resolve(null),
  wantStaging ? orNull(loadCatalog(BASE), 'catalog.json') : Promise.resolve(null),
  params.get('collision') !== '0'
    ? orNull(loadCollisionSidecar(`${BASE}/${sidecarName}.voxel.json`), 'collision sidecar') : Promise.resolve(null),
  navName
    ? orNull(loadNavmesh(`${BASE}/${navName}.navmesh.bin`), 'navmesh') : Promise.resolve(null),
  // rails tour (F-13). NOT wrapped in orNull: a scene with no .path.json must produce no
  // button AND no error — loadPath resolves null for that case and warns only when the
  // sidecar exists but is malformed.
  wantRails ? loadPath(`${BASE}/${sidecarName}.path.json`, { warn: showWarning }).catch(() => null)
            : Promise.resolve(null),
]).then(async ([lj, sj, cj, vj, nj, pj]) => {
  if (pj) {
    console.log('[viewer] path.json loaded', JSON.stringify({ file: pj.file, samples: pj.count, raw_length_m: +pj.len.toFixed(2), tour_length_m: +pj.tourLen.toFixed(2), cut: pj.tourCut }));
    mountRails(pj);
  }
  if (vj) window.__collision = vj.collision;   // debug/automation handle (walk gates, #5 occupancy poking)
  if (nj) {
    console.log('[viewer] navmesh loaded', JSON.stringify({ file: nj._file, tris: nj.tris, area_m2: nj.area_m2, bytes: nj.bytes }));
    mountWalk(createNavWalk({ app, camera, nav: nj, spawn, requestRender, debug: params.get('navdebug') === '1',
                              onStatus: s => { status.textContent = s; } }));
  } else if (vj) initWalk(vj.collision);
  lightingJson = lj;
  if (lj) applyLighting();
  else if (params.get('lighting') === '1') console.warn('[viewer] ?lighting=1 but no lighting.json found');
  if (cj && versionOk(cj, 'catalog.json')) doc.catalog = cj;
  if (sj && versionOk(sj, `${sj._file ?? 'staging.json'}`)) {
    await doc.loadFrom(sj, cj);
    stagingState = { loaded: true, file: sj._file, count: doc.placements.length };
    if (opOverride == null && sj.shadow?.strength != null) catcher.set({ strength: sj.shadow.strength });   // coerced in catcher.set (F-30)
    // saved placements want their shadows even with no ?asset= (the boot default was 'off')
    if (params.get('shadow') == null && shadowDefaultOn && doc.placements.length && catcher.state().mode === 'off' && catcher.state().pending === null) {
      catcher.setMode('screen');
    }
    if (params.get('shadow') == null && !shadowDefaultOn && doc.placements.length) console.log('[viewer] contact shadows default OFF on a coarse pointer (F-34: ~35 % of the frame on a 2020 phone) — ?shadow=screen to force');
    console.log('[viewer] staging.json applied', JSON.stringify(stagingState));
  }
  requestRender();
}).catch(err => {
  stagingState = { loaded: false, file: null, error: String(err) };
  console.error('[viewer] lighting/staging load failed', err);
});

// --- walk mode (issue #15): built once the voxel sidecar loads; absent sidecar = no walk ---
let walk = null;
let walkBtn = null;
function initWalk(collision) {
  mountWalk(createWalk({
    app, camera, collision, spawn, requestRender,
    onStatus: s => { status.textContent = s; },
  }));
}
// Walk is keyboard + pointer-lock only (both walk.js and navwalk.js share WalkInput), and
// pointer lock does not exist on mobile browsers: a phone visitor who tapped "Walk" lost
// orbit too and was stranded in a frozen first-person view (F-31). Gate the whole UI surface
// — button, ?walk=1 and the G key — on a fine pointer until the touch controller (#12)
// lands. viewerApi.walk.* stays open: it is the automation/gate surface, not a user path.
const walkUiAllowed = matchMedia('(pointer: fine)').matches;
function mountWalk(w) {
  walk = w;
  if (!walkUiAllowed) {
    status.textContent = 'walk mode needs a mouse + keyboard — touch controls are not built yet';
    if (params.get('walk') === '1') console.warn('[viewer] ?walk=1 ignored — coarse pointer (no touch walk controls yet)');
    return;
  }
  // toggle button in its own root — #hud is hidden wholesale by ?hud=0 (the button survives)
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:12;';
  walkBtn = document.createElement('button');
  walkBtn.textContent = 'Walk (G)';
  walkBtn.style.cssText =
    'pointer-events:auto;position:absolute;right:14px;bottom:14px;padding:7px 14px;' +
    'font:13px system-ui;color:#eee;background:#222a;border:1px solid #555;border-radius:6px;cursor:pointer;';
  walkBtn.onclick = () => toggleWalk();
  root.appendChild(walkBtn);
  document.body.appendChild(root);
  if (params.get('walk') === '1') { status.textContent = 'entering walk…'; toggleWalk(); }
}
function syncWalkBtn() {
  if (walkBtn) walkBtn.textContent = walk?.active ? 'Exit walk (G)' : 'Walk (G)';
}
function toggleWalk() {
  if (!walk || !walkBtn) return;
  if (walk.active) walk.exit();
  else { rails?.exit(); walk.enter(); }   // walk and rails never coexist
  syncWalkBtn();
  requestRender();
}

// --- rails tour (F-13): the pilot-safe mode. Built only when <sidecar>.path.json exists;
// no sidecar = no button and no error. Unlike walk this is NOT gated on a fine pointer —
// the tour plays itself and its transport is on-screen buttons, so it is the mode a phone
// visitor actually gets. rails.js owns its own UI root (survives ?hud=0).
let rails = null;
function mountRails(path) {
  rails = createRails({
    camera, path, requestRender,
    eyeY: spawn?.position?.[1] ?? null,                       // fixed tour height = the spawn eye (owner 2026-09-03)
    endM: numParam('tour_end', { min: 1, max: 10_000 }),      // metres; overrides the first-pass cut for A/Bs
    onStatus: s => { status.textContent = s; },
    // whoever calls enter() — key, button or viewerApi — leaves walk off
    onBeforeEnter: () => { if (walk?.active) { walk.exit(); syncWalkBtn(); } },
  });
  // the tour bar sits bottom-centre; lift the diagnostic state line clear of it
  if (stateEl.style.display !== 'none') stateEl.style.bottom = '62px';
  if (railsAutoEnter) { status.textContent = 'starting tour…'; rails.enter(); }
}
function toggleRails() {
  if (!rails) return;
  if (rails.active) rails.exit(); else rails.enter();
  requestRender();
}

// --- keys ---
addEventListener('keydown', e => {
  if (e.code === 'KeyB') setShape(shape === 'box' && assetTemplate ? 'asset' : 'box');
  if (e.code === 'KeyV') ghost.set(obj, !ghost.on);
  if (e.code === 'KeyN') { obj.enabled = !obj.enabled; catcher.refreshCasters(); }
  if (e.code === 'KeyH') catcher.setMode({ off: 'plane', plane: 'screen', screen: 'off' }[catcher.state().mode]);
  if (e.code === 'KeyG') toggleWalk();
  if (e.code === 'KeyT') toggleRails();
  if (e.code === 'KeyR' && walk?.active) walk.reset();
  if (e.code === 'KeyM' && walk?.toggleDebug) walk.toggleDebug();
});

// --- automation API (evidence workflow + the operator tool build on this) ---
window.viewerApi = {
  setPose(pos, lookAt) {
    if (camera.script) camera.script.enabled = false;
    camera.setPosition(...pos);
    if (lookAt) camera.lookAt(...lookAt);
    requestRender();
  },
  controls(on) { if (camera.script) camera.script.enabled = !!on; },
  setObject(o = {}) {
    if (o.shape) setShape(o.shape);
    if (o.pos) obj.setPosition(...o.pos);
    if (o.yaw !== undefined) obj.setEulerAngles(0, o.yaw, 0);
    if (o.scale !== undefined) obj.setLocalScale(o.scale, o.scale, o.scale);
    if (o.visible !== undefined) { obj.enabled = o.visible; catcher.refreshCasters(); }
    if (o.ghost !== undefined) ghost.set(obj, o.ghost);
    requestRender();
  },
  setShadow: o => catcher.set(o),
  setLighting: applyLighting,
  walk: {
    enter: () => { rails?.exit(); const ok = walk?.enter() ?? false; syncWalkBtn(); return ok; },
    exit: () => { walk?.exit(); syncWalkBtn(); },
    reset: () => walk?.reset() ?? false,
    setLook: (yaw, pitch) => walk?.setLook(yaw, pitch),
    toggleDebug: () => walk?.toggleDebug?.() ?? null,
  },
  // rails tour (F-13) — enter/exit mirror walk's contract; step(n) is in ±1 m units of path
  // length, seek(m) is absolute metres along the tour.
  rails: {
    enter: () => rails?.enter() ?? false,
    exit: () => rails?.exit(),
    play: () => rails?.play() ?? false,
    pause: () => rails?.pause() ?? false,
    step: (n = 1) => rails?.step(n) ?? false,
    seek: (m) => rails?.seek(m) ?? false,
    state: () => rails?.state() ?? { available: false },
  },
  getState() {
    const c = camera.getPosition(), o = obj.getPosition();
    return {
      loaded, fps: renderFps, tti_s: ttiS, ttfr_s: ttfrS,
      device: app.graphicsDevice.deviceType,
      dpr: app.graphicsDevice.maxPixelRatio,
      res: [app.graphicsDevice.width, app.graphicsDevice.height],
      budget: app.scene.gsplat.splatBudget,
      stream: isUrlScene, scene: sceneUrl,
      textureFloatFilterable: app.graphicsDevice.textureFloatFilterable ?? null,
      splats: sceneAsset?.resource?.numSplats ?? null,
      autoRender: app.autoRender,
      camera: [c.x, c.y, c.z].map(v => +v.toFixed(3)),
      object: { shape, pos: [o.x, o.y, o.z].map(v => +v.toFixed(3)),
                scale: +obj.getLocalScale().x.toFixed(3), visible: obj.enabled, ghost: ghost.on },
      asset: assetMeta,
      shadow: catcher.state(),
      lighting: { loaded: !!lightingJson, file: lightingJson?._file ?? null,
                  azimuth: lightingJson?.sun_azimuth_deg ?? null, applied: lightingApplied },
      staging: stagingState,
      walk: walk ? { ...walk.state(), ui: walkUiAllowed } : { available: false, ui: walkUiAllowed },
      rails: rails ? rails.state() : { available: false },
      warnings: window.__warnings.slice(),
      placements: doc.snapshot(),
    };
  },
  tick(dt = 1 / 60) { app.update(dt); app.render(); },   // hidden tabs pause rAF
  requestRender,
};
window.__app = app;

// --- per-frame: catcher params, ghost sync, camera-motion render requests, HUD ---
let renderCount = 0, renderFps = 0;
app.on('postrender', () => renderCount++);
setInterval(() => { renderFps = renderCount; renderCount = 0; }, 1000);
const lastCamMat = new Mat4();
app.on('update', (dt) => {
  // BEFORE the camera diff — walk/rails motion drives render requests for free. Both run in
  // the app 'update' event, which fires AFTER the script system, so camera-controls has
  // already written its pose for this frame and rails' re-attach lands on top of it.
  walk?.update(dt);
  rails?.update(dt);
  // camera-controls damping moves the camera without input events — diff the transform
  const m = camera.getWorldTransform();
  if (!lastCamMat.equals(m)) { lastCamMat.copy(m); requestRender(); }
  ghost.sync();
  catcher.update();
  if (hudEl.style.display === 'none') return;
  const c = camera.getPosition(), o = obj.getPosition(), sh = catcher.state();
  const rs = rails?.active ? rails.state() : null;
  stateEl.textContent =
    `cam  ${c.x.toFixed(2)} ${c.y.toFixed(2)} ${c.z.toFixed(2)}   fps ${renderFps}${continuous ? '' : ' (on-demand)'}   ${app.graphicsDevice.deviceType}   dpr ${+app.graphicsDevice.maxPixelRatio.toFixed(2)}   ${app.graphicsDevice.width}x${app.graphicsDevice.height}${ttfrS != null ? `   ttfr ${ttfrS}s` : ''}\n` +
    `obj  ${o.x.toFixed(2)} ${o.y.toFixed(2)} ${o.z.toFixed(2)}   ${shape}${obj.enabled ? '' : ' [hidden]'}${ghost.on ? ' [ghost]' : ''}${sh.mode !== 'off' ? ` [shadow:${sh.mode}]` : ''}${lightingApplied ? ' [lit]' : ''}${walk?.active ? ` [walk${walk.mode === 'navmesh' ? ':nav' : ''}]` : ''}${rs ? ` [tour ${rs.s_m.toFixed(1)}/${rs.length_m.toFixed(1)}m${rs.playing ? '' : ' paused'}]` : ''}`;
});

if (loaded) {
  ttiS = +((performance.now() - T0) / 1000).toFixed(2);
  status.textContent = `${sceneName} loaded in ${ttiS}s — drag orbit · WASD fly`;
  console.log('[viewer] loaded', sceneName, 'tti_s', ttiS);
}

// --- operator editor (issue #5): lazy overlay, never in the customer path without the flag
if (params.get('edit') === '1') {
  if (!glbUrl) { obj.enabled = false; catcher.refreshCasters(); }   // clean canvas: document only
  import('./editor.js').then(m => m.initEditor({
    // sidecarName, not raw ?scene= — a URL-scene path would poison the Ctrl+S
    // filename (`${sceneName}.staging.json`) and the panel title
    app, camera, catcher, doc, docReady, requestRender, sceneName: sidecarName,
    params, getLegacyObj: () => obj,
  })).catch(err => { console.error('[viewer] editor failed to load', err); });
}
requestRender();
