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

const params = new URLSearchParams(location.search);
const status = document.getElementById('status');
const stateEl = document.getElementById('state');
const hudEl = document.getElementById('hud');
if (params.get('hud') === '0') { hudEl.style.display = 'none'; stateEl.style.display = 'none'; }
if (params.get('mobile') === '1') stateEl.style.cssText += 'font-size:22px;font-weight:700;color:#0f0';

// #b= (fragment — never reaches any server; the deploy_share.sh link shape) wins over ?base= (dev knob)
const hashParams = new URLSearchParams(location.hash.slice(1));
const BASE = (hashParams.get('b') || params.get('base') || 'assets').replace(/\/+$/, '');
const sceneName = params.get('scene') || 'living';
// a ?scene= containing '/' is a URL scene (streamed lod-meta.json etc.); relative forms are
// BASE-relative, absolute (scheme://, //, /-rooted) pass through. ?spawnas= names the
// sidecars (spawn/lighting/staging) the URL form can't derive
const isUrlScene = sceneName.includes('/');
const isAbsUrl = s => /^([a-z][a-z0-9+.-]*:)?\/\//i.test(s) || s.startsWith('/');
const resolveAsset = s => (s == null || isAbsUrl(s)) ? s : `${BASE}/${s}`;
const sceneUrl = isUrlScene ? resolveAsset(sceneName) : `${BASE}/${sceneName}.sog`;
const sidecarName = params.get('spawnas') ?? (isUrlScene ? 'living' : sceneName);
const glbUrl = resolveAsset(params.get('asset'));
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
const dprParam = parseFloat(params.get('dpr') ?? '');
if (Number.isFinite(dprParam)) device.maxPixelRatio = Math.min(Math.max(dprParam, 0.25), window.devicePixelRatio || 3);
const app = new Application(canvas, { graphicsDevice: device });
app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
app.setCanvasResolution(RESOLUTION_AUTO);
// ?budget= before the scene asset loads (read once at GSplatWorld construction) —
// scales STREAMED (octree) scenes only; a flat .sog is counted as fixed cost, and a
// single-LOD streamed export gives it nothing to drop (8T-verified inert). Tier default
// (mobile 1M / desktop 3M) future-proofs for multi-LOD assets; URL always wins.
const coarsePointer = matchMedia('(pointer: coarse)').matches;
const budgetParam = parseInt(params.get('budget') ?? '', 10);
app.scene.gsplat.splatBudget = Number.isFinite(budgetParam) ? budgetParam : (coarsePointer ? 1_000_000 : 3_000_000);
app.start();
window.addEventListener('resize', () => { app.resizeCanvas(); requestRender(); });

// --- render-on-demand (docs-sweep rider): render only when something changed. The gsplat
// director keeps sorting on skipped frames ('framerender' fires regardless) and asks for
// repaints via 'frame:request' while the async sort settles. ?continuous=1 restores
// render-every-rAF (use it to measure real fps).
const continuous = !!params.get('continuous');
app.autoRender = continuous;
function requestRender() { app.renderNextFrame = true; }
app.systems.gsplat.on('frame:request', requestRender);
for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup',
                  'touchstart', 'touchmove', 'touchend'])
  window.addEventListener(ev, requestRender, { passive: true });

// --- assets ---
const assetList = [
  new Asset('camera-controls', 'script', {
    url: 'https://cdn.jsdelivr.net/npm/playcanvas@2.21.4/scripts/esm/camera-controls.mjs',
  }),
  new Asset(sceneName, 'gsplat', { url: sceneUrl }),
];
if (glbUrl) assetList.push(new Asset('glb', 'container', { url: glbUrl }));
const loader = new AssetListLoader(assetList, app.assets);
await new Promise(resolve => loader.load(resolve));
const failed = assetList.filter(a => !a.loaded);
let loaded = failed.length === 0;
if (!loaded) {
  status.textContent = `load FAILED: ${failed.map(a => a.name).join(', ')}`;
  window.__lastError = status.textContent;
  console.error('[viewer] load failed', failed.map(a => a.name));
}

// --- camera (spawn from <base>/<scene>.spawn.json — same frame as the pipeline emits) ---
const camera = new Entity('Camera');
camera.addComponent('camera', { nearClip: 0.05, farClip: 200, fov: 70, clearColor: new Color(0.10, 0.10, 0.12) });
let spawn = null;
try { spawn = await fetch(`${BASE}/${sidecarName}.spawn.json`).then(r => r.ok ? r.json() : null); } catch {}
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
const rot = (params.get('rot') || '0,0,0').split(',').map(Number);
const splat = new Entity(sceneName);
splat.addComponent('gsplat', { asset: assetList[1] });
splat.setEulerAngles(...rot);
app.root.addChild(splat);
app.once('postrender', () => { ttfrS = +((performance.now() - T0) / 1000).toFixed(2); requestRender(); });
requestRender();

// --- staged object: box control + optional generated GLB ---
let assetTemplate = null, assetMeta = null;
if (glbUrl && loaded) {
  const norm = normalizeGlb(app, assetList.find(a => a.name === 'glb'), parseFloat(params.get('h') ?? '0.8'), glbUrl);
  assetTemplate = norm.entity;
  assetMeta = norm.meta;
}
let shape = assetTemplate ? 'asset' : 'box';
let obj = assetTemplate ?? buildBox();
obj.setPosition(1.5, 0, -0.5);
// ?obj=x,y,z + ?yaw=deg — shareable staged placement (viewerApi parity)
const objP = params.get('obj')?.split(',').map(Number);
if (objP?.length === 3 && objP.every(Number.isFinite)) obj.setPosition(...objP);
const yawP = parseFloat(params.get('yaw') ?? '');
if (Number.isFinite(yawP)) obj.setEulerAngles(0, yawP, 0);
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
const opRaw = params.get('op');
if (opRaw != null) catcher.set({ strength: parseFloat(opRaw) });   // ?op= is a shadow knob — applies with or without lighting.json
const shadowParam = params.get('shadow') ?? (glbUrl ? 'screen' : 'off');
if (shadowParam !== 'off') catcher.setMode(shadowParam);   // warm-frame gate defers internally

// --- staging document (issue #5): saved placements load in the customer path;
// ?staging=0 skips (pure review-link mode). Catalog + staging.json ride the same
// flat <base>/ dir as lighting.json.
const doc = createStagingDoc(app, catcher, { requestRender, base: BASE });
const wantStaging = params.get('staging') !== '0';
let stagingState = { loaded: false, file: null };

// --- lighting.json consumer (issue #4): auto-apply when the file exists (?lighting=0
// disables, ?lighting=1 forces + warns if missing). ?sun= / ?op= override params win.
let lightingJson = null, lightingApplied = false;
function applyLighting(o = {}) {
  if (!lightingJson) { console.warn('[viewer] no lighting.json loaded'); return; }
  const sunOverride = params.get('sun')?.split(',').map(Number) ?? null;
  const opRaw = params.get('op');
  const plan = lightingPlan(lightingJson, {
    sunOverride, opacityOverride: opRaw != null ? parseFloat(opRaw) : null,
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
// lighting + staging load together so the apply order is deterministic:
// lighting first (advisory strength), then staging.shadow.strength, with ?op= above both.
const docReady = Promise.all([
  params.get('lighting') !== '0' ? loadLighting(BASE, sidecarName) : Promise.resolve(null),
  wantStaging ? loadStaging(BASE, sidecarName) : Promise.resolve(null),
  wantStaging ? loadCatalog(BASE) : Promise.resolve(null),
]).then(async ([lj, sj, cj]) => {
  lightingJson = lj;
  if (lj) applyLighting();
  else if (params.get('lighting') === '1') console.warn('[viewer] ?lighting=1 but no lighting.json found');
  if (cj) doc.catalog = cj;
  if (sj) {
    await doc.loadFrom(sj, cj);
    stagingState = { loaded: true, file: sj._file, count: doc.placements.length };
    if (params.get('op') == null && sj.shadow?.strength != null) catcher.set({ strength: sj.shadow.strength });
    // saved placements want their shadows even with no ?asset= (the boot default was 'off')
    if (params.get('shadow') == null && doc.placements.length && catcher.state().mode === 'off' && catcher.state().pending === null) {
      catcher.setMode('screen');
    }
    console.log('[viewer] staging.json applied', JSON.stringify(stagingState));
  }
  requestRender();
}).catch(err => {
  stagingState = { loaded: false, file: null, error: String(err) };
  console.error('[viewer] lighting/staging load failed', err);
});

// --- keys ---
addEventListener('keydown', e => {
  if (e.code === 'KeyB') setShape(shape === 'box' && assetTemplate ? 'asset' : 'box');
  if (e.code === 'KeyV') ghost.set(obj, !ghost.on);
  if (e.code === 'KeyN') { obj.enabled = !obj.enabled; catcher.refreshCasters(); }
  if (e.code === 'KeyH') catcher.setMode({ off: 'plane', plane: 'screen', screen: 'off' }[catcher.state().mode]);
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
      splats: assetList[1].resource?.numSplats ?? null,
      autoRender: app.autoRender,
      camera: [c.x, c.y, c.z].map(v => +v.toFixed(3)),
      object: { shape, pos: [o.x, o.y, o.z].map(v => +v.toFixed(3)),
                scale: +obj.getLocalScale().x.toFixed(3), visible: obj.enabled, ghost: ghost.on },
      asset: assetMeta,
      shadow: catcher.state(),
      lighting: { loaded: !!lightingJson, file: lightingJson?._file ?? null,
                  azimuth: lightingJson?.sun_azimuth_deg ?? null, applied: lightingApplied },
      staging: stagingState,
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
app.on('update', () => {
  // camera-controls damping moves the camera without input events — diff the transform
  const m = camera.getWorldTransform();
  if (!lastCamMat.equals(m)) { lastCamMat.copy(m); requestRender(); }
  ghost.sync();
  catcher.update();
  if (hudEl.style.display === 'none') return;
  const c = camera.getPosition(), o = obj.getPosition(), sh = catcher.state();
  stateEl.textContent =
    `cam  ${c.x.toFixed(2)} ${c.y.toFixed(2)} ${c.z.toFixed(2)}   fps ${renderFps}${continuous ? '' : ' (on-demand)'}   ${app.graphicsDevice.deviceType}   dpr ${+app.graphicsDevice.maxPixelRatio.toFixed(2)}   ${app.graphicsDevice.width}x${app.graphicsDevice.height}${ttfrS != null ? `   ttfr ${ttfrS}s` : ''}\n` +
    `obj  ${o.x.toFixed(2)} ${o.y.toFixed(2)} ${o.z.toFixed(2)}   ${shape}${obj.enabled ? '' : ' [hidden]'}${ghost.on ? ' [ghost]' : ''}${sh.mode !== 'off' ? ` [shadow:${sh.mode}]` : ''}${lightingApplied ? ' [lit]' : ''}`;
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
