// Rails tour (F-13) — the PILOT-SAFE mode: the camera rides the filmed capture path with
// ZERO collision surface. No voxel grid, no navmesh, no capsule, no gravity, no ray probes —
// the only input is `<base>/<sidecar>.path.json` (`scripts/build_viewer_meta.py`:
// {spacing_m, samples:[[x,y,z]…], look:[[x,y,z]…]}, the same aligned frame as spawn.json;
// living = 690 samples / 74.9 m raw). `look` entries are unit DIRECTIONS, not points.
// Ported from the ~90-line renderer-agnostic player in viewer/index.html (three.js): the
// camera math (cumulative arc length, binary-search sample + lerp, gap snap, look easing with
// a user-look override) is unchanged; the camera OWNERSHIP model is not — see below.
//
// Camera ownership — the OPPOSITE of walk.js/navwalk.js, deliberately:
//   walk DISABLES camera-controls because it must own the camera every frame (mouselook,
//   physics). Rails does NOT: it leaves the script ENABLED for the whole tour and moves the
//   camera by (a) writing the entity position and (b) assigning `cc.focusPoint`, whose setter
//   is the INSTANT re-attach `attach(this._pose.look(entityPosition, point), false)` —
//   it reads the position straight off the entity we just moved, so the script's own update
//   writes exactly that pose back next frame. Two consequences we want:
//     * WHILE PAUSED rails touches nothing at all, so orbit / fly / pan / pinch-zoom keep
//       working untouched — "drag to look around at any stop" needs no special case.
//     * EXIT is a pure state flip: camera-controls' internal `_pose` already equals the
//       camera pose, so there is nothing to hand back and nothing to glide (the `reset()`
//       glide trap in .claude/rules/known-issues.md cannot fire here).
//   `enter()` may still have to re-ENABLE the script (viewerApi.setPose disables it). That is
//   the one sanctioned form of the banned `script.enabled` cycle: the enable is followed in
//   the SAME synchronous block by the instant `focusPoint` re-attach, so the script's buffered
//   input drains onto the pose we chose rather than snapping to a stale one.
//
// Touch: unlike walk (desktop-only until #12), rails is fully usable on a phone — the tour
// plays itself and ◀ ▶ ⏸ are real on-screen buttons. That is the point of the pilot mode.
import { Vec3 } from 'playcanvas';

const PLAY_SPEED = 0.5;      // m/s along the path — owner feel pass 2026-09-03: 1.0 was "definitely too fast"
// One-pass tour (owner 2026-09-03): an interior capture is the SAME route walked 2–3 times at
// different heights (docs/CAPTURE.md), so the raw path is 2–3× the tour. The tour ends
// where the first pass ends: the first point after which ≥ FIRST_PASS_REVISIT of the remaining
// samples lie within FIRST_PASS_R of the path already walked (living: 30.4 of 65.7 m — the crouch
// pass starts right there; bedroom, one loop: no cut). A cut must drop ≥ FIRST_PASS_MIN_DROP of
// the path or it is noise (a loop's final approach is a revisit too). Override: path.json
// `tour.end_m` (operator) or the `endM` option (?tour_end=).
const FIRST_PASS_R = 0.6;          // m — "the same route" tolerance (= the navmesh corridor half-width)
const FIRST_PASS_REVISIT = 0.97;   // fraction of the remaining samples that must be revisits
const FIRST_PASS_MIN_M = 8;        // never cut a tour shorter than this
const FIRST_PASS_MIN_DROP = 0.15;  // a cut must remove at least this fraction of the raw path
const STEP_M = 1.0;          // ◀ / ▶ / ArrowLeft / ArrowRight step, metres of path
const LOOK_EASE = 1.8;       // per-second lerp rate easing the aim back to the filmed look
const LOOK_HOLD_MS = 2500;   // after any look input, keep the user's aim this long
const FOCUS_DIST = 2;        // camera-controls focus distance (same convention as walk exit)
const REPEAT_MS = 120;       // held-arrow scrub throttle (~8 m/s), so key repeat can't teleport
const CLAIMED_CODES = new Set(['ArrowLeft', 'ArrowRight', 'Space']);

const isVec3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);

/**
 * Cumulative-arc-length model over the resampled path.
 * A gap larger than 3× spacing is an unbridged jump in the source trajectory (living has two,
 * 3.71 m and 3.93 m): it costs ONE spacing of tour distance and is crossed by snapping, never
 * by gliding through a wall.
 */
export function buildPath(json, file = null) {
  const spacing = Number(json.spacing_m) > 0 ? Number(json.spacing_m) : 0.1;
  const jumpGap = 3 * spacing;
  const pts = json.samples.map(a => new Vec3(a[0], a[1], a[2]));
  const dirs = json.look.map((a, i) => {
    const v = new Vec3(a[0], a[1], a[2]);
    if (v.lengthSq() > 1e-12) return v.normalize();
    // degenerate look entry: fall back to the polyline tangent, then to -Z
    const nxt = json.samples[i + 1] ?? json.samples[i - 1];
    if (nxt) {
      const t = new Vec3(nxt[0] - a[0], nxt[1] - a[1], nxt[2] - a[2]);
      if (t.lengthSq() > 1e-12) return t.normalize();
    }
    return new Vec3(0, 0, -1);
  });
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].distance(pts[i - 1]);
    cum[i] = cum[i - 1] + (d > jumpGap ? spacing : d);
  }
  const rawLen = cum[pts.length - 1];
  const tourEnd = firstPassEnd(pts, cum);
  const operatorEnd = Number(json.tour?.end_m);
  const tourLen = Number.isFinite(operatorEnd) && operatorEnd > 0 ? Math.min(operatorEnd, rawLen) : tourEnd;
  return { pts, dirs, cum, spacing, jumpGap, file, count: pts.length, len: rawLen,
           tourLen, tourCut: tourLen < rawLen - 1e-6 ? (Number.isFinite(operatorEnd) && operatorEnd > 0 ? 'operator' : 'first-pass') : null };
}

/**
 * Metres along the path where the FIRST pass ends (see the constants above). O(n²) in XZ on
 * the resampled path — ~700 samples for a flat, once at load. Returns the raw length when no
 * cut qualifies.
 */
export function firstPassEnd(pts, cum) {
  const n = pts.length;
  const rawLen = cum[n - 1];
  if (rawLen < FIRST_PASS_MIN_M * 2) return rawLen;
  const r2 = FIRST_PASS_R * FIRST_PASS_R;
  // nearest-before-cut distance² for every sample, updated incrementally as the cut advances
  const near = new Float64Array(n).fill(Infinity);
  let c = 0;
  while (c < n - 1 && cum[c] < FIRST_PASS_MIN_M) c++;
  for (let j = 0; j < c; j++) {                       // prime with everything before the first candidate
    const pj = pts[j];
    for (let i = j + 1; i < n; i++) {
      const dx = pts[i].x - pj.x, dz = pts[i].z - pj.z, d2 = dx * dx + dz * dz;
      if (d2 < near[i]) near[i] = d2;
    }
  }
  for (; c < n - 1; c++) {
    let hits = 0;
    for (let i = c; i < n; i++) if (near[i] <= r2) hits++;
    if (hits / (n - c) >= FIRST_PASS_REVISIT) {
      const cutLen = cum[c];
      return (rawLen - cutLen) / rawLen >= FIRST_PASS_MIN_DROP ? cutLen : rawLen;
    }
    const pc = pts[c];                                // sample c joins the "walked" set
    for (let i = c + 1; i < n; i++) {
      const dx = pts[i].x - pc.x, dz = pts[i].z - pc.z, d2 = dx * dx + dz * dz;
      if (d2 < near[i]) near[i] = d2;
    }
  }
  return rawLen;
}

/**
 * Fetch + validate a path.json.
 * @returns {Promise<object|null>} null when there is no sidecar (404 / network) — F-13 wants
 *   NO button and NO error in that case. A sidecar that EXISTS but is malformed does warn
 *   (operator data, F-35 convention: never fail silently on something someone authored).
 */
export async function loadPath(url, { warn = () => {} } = {}) {
  let json;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    json = await r.json();
  } catch {
    return null;
  }
  const ok = json && Array.isArray(json.samples) && Array.isArray(json.look) &&
             json.samples.length >= 2 && json.samples.length === json.look.length &&
             json.samples.every(isVec3) && json.look.every(isVec3);
  if (!ok) {
    warn(`${url} is malformed (need samples[] and look[] of equal length, ≥2 [x,y,z] entries) — tour disabled`);
    return null;
  }
  return buildPath(json, url);
}

// scratch — no per-frame allocation
const posTmp = new Vec3();
const dirTmp = new Vec3();
const focusTmp = new Vec3();

/**
 * @param {object} o - {camera (Entity with the cameraControls script), path (buildPath result),
 *   requestRender, onStatus, onBeforeEnter (main.js: exit walk first — mutual exclusion)}
 */
export function createRails({ camera, path, requestRender, onStatus = () => {}, onBeforeEnter = () => {},
                              eyeY = null, endM = null }) {
  const canvas = document.querySelector('canvas');
  const { pts, dirs, cum, jumpGap } = path;
  // tour length: ?tour_end= (endM) > path.json tour.end_m / first-pass cut (path.tourLen) > raw
  const len = Number.isFinite(endM) && endM > 0 ? Math.min(endM, path.len) : path.tourLen;
  // Fixed eye height (owner 2026-09-03): the filmed height (0.84–2.23 m on living) is how the
  // capture was made, not how a tour should feel — "very jarring". The camera rides the path in
  // XZ at eyeY (main.js passes the spawn eye, the same height the walk stands at); null = filmed.
  const fixedY = Number.isFinite(eyeY) ? eyeY : null;

  let active = false;
  let playing = false;
  let s = 0;                       // metres along the tour
  let lookHoldUntil = 0;           // performance.now() until which the user's own aim wins
  let lastStepAt = 0;
  let aimed = true;                // did the last frame aim along the path (vs hold the user's)?
  const smoothDir = new Vec3(0, 0, -1);

  const cc = () => camera.script?.cameraControls ?? null;

  // --- path sampling -------------------------------------------------------------------
  /** @param {number} dist - metres along the tour; writes pos + unit look dir into the outs */
  function sampleAt(dist, outPos, outDir) {
    const d = Math.min(Math.max(dist, 0), len);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid; else hi = mid;
    }
    const span = cum[hi] - cum[lo];
    const f = span > 0 ? Math.min(1, Math.max(0, (d - cum[lo]) / span)) : 0;
    if (pts[lo].distance(pts[hi]) > jumpGap) {
      outPos.copy(f < 0.5 ? pts[lo] : pts[hi]);        // unbridged gap: snap, don't glide
    } else {
      outPos.lerp(pts[lo], pts[hi], f);
    }
    outDir.lerp(dirs[lo], dirs[hi], f);
    if (outDir.lengthSq() > 1e-12) outDir.normalize(); else outDir.copy(dirs[lo]);
    return lo;
  }
  function indexAt(dist) {
    const d = Math.min(Math.max(dist, 0), len);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    return d - cum[lo] < cum[hi] - d ? lo : hi;
  }

  /**
   * Aim the camera along `dir` from wherever it stands. Sets the entity euler AND the
   * camera-controls focus point: the euler makes the pose correct for THIS frame's render,
   * the focusPoint setter re-attaches the script instantly at the same pose so its own
   * update writes the identical transform back next frame instead of stomping ours.
   */
  function aimAlong(dir) {
    const p = camera.getPosition();
    focusTmp.set(p.x + dir.x * FOCUS_DIST, p.y + dir.y * FOCUS_DIST, p.z + dir.z * FOCUS_DIST);
    camera.lookAt(focusTmp);
    const c = cc();
    if (c) c.focusPoint = focusTmp;
  }

  /** Put the camera on the rail at `s`, aiming along the filmed look direction. */
  function place() {
    sampleAt(s, posTmp, dirTmp);
    if (fixedY != null) posTmp.y = fixedY;
    smoothDir.copy(dirTmp);
    camera.setPosition(posTmp);
    aimAlong(smoothDir);
    aimed = true;
    sync();
    requestRender();
  }

  // --- input claimed only while the tour is active ---------------------------------------
  // Space / ArrowLeft / ArrowRight are the tour transport. The arrows must be TAKEN from
  // camera-controls (its desktop source maps them onto the fly axis, key[RIGHT]-key[LEFT]),
  // so these are capture-phase window listeners with stopImmediatePropagation — the same
  // idiom walk.js's WalkInput uses for WASD. Everything else (drag, wheel, WASD fly) is
  // deliberately left to camera-controls: "orbit/fly stay usable" is the contract.
  const onKeyDown = (e) => {
    if (!CLAIMED_CODES.has(e.code)) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === 'Space') { if (!e.repeat) toggle(); return; }
    const now = performance.now();
    if (e.repeat && now - lastStepAt < REPEAT_MS) return;   // held-arrow scrub throttle
    lastStepAt = now;
    step(e.code === 'ArrowRight' ? 1 : -1);
  };
  const onKeyUp = (e) => { if (CLAIMED_CODES.has(e.code)) e.stopImmediatePropagation(); };
  // any look gesture (drag / touch drag / wheel) hands the aim to the user for LOOK_HOLD_MS;
  // while paused this is moot (camera-controls owns everything), while playing it stops the
  // tour from fighting the drag — position keeps advancing, orientation is theirs.
  const holdLook = () => { lookHoldUntil = performance.now() + LOOK_HOLD_MS; };
  const onPointerMove = (e) => { if (e.buttons) holdLook(); };

  function attachInput() {
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    canvas?.addEventListener('pointermove', onPointerMove);
    canvas?.addEventListener('wheel', holdLook, { passive: true });
  }
  function detachInput() {
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    window.removeEventListener('keyup', onKeyUp, { capture: true });
    canvas?.removeEventListener('pointermove', onPointerMove);
    canvas?.removeEventListener('wheel', holdLook);
  }

  // --- UI: one root of its own, so ?hud=0 cannot hide the tour transport ------------------
  const coarse = matchMedia('(pointer: coarse)').matches;
  const root = document.createElement('div');
  root.id = 'rails-ui';
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:13;';
  const bar = document.createElement('div');
  bar.style.cssText =
    'pointer-events:auto;position:absolute;left:50%;bottom:14px;transform:translateX(-50%);' +
    'display:flex;align-items:center;gap:8px;background:#1c1c1ee6;border:1px solid #555;' +
    `border-radius:999px;padding:${coarse ? '8px 12px' : '6px 10px'};` +
    `font:${coarse ? 15 : 13}px system-ui,sans-serif;color:#eee;white-space:nowrap;` +
    // a narrow phone must never push the transport off-screen: the bar is capped to the
    // viewport; it holds buttons only (the metres counter was removed 2026-09-05 — owner G2:
    // with a number showing, a repeated pass reads as a loop; without it, as a tour)
    'max-width:calc(100vw - 16px);box-sizing:border-box;';
  root.appendChild(bar);

  function mkBtn(label, title, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.cssText =
      `flex:0 0 auto;min-width:${coarse ? 46 : 34}px;min-height:${coarse ? 44 : 30}px;padding:0 10px;` +
      'font:inherit;color:#eee;background:#333;border:1px solid #666;border-radius:999px;' +
      'cursor:pointer;touch-action:manipulation;';
    b.addEventListener('click', (e) => { e.preventDefault(); fn(); b.blur(); });
    return b;
  }
  const enterBtn = mkBtn('▶ Tour (T)', 'start the waypoint tour', () => enter());
  const prevBtn = mkBtn('◀', `back ${STEP_M} m (ArrowLeft)`, () => step(-1));
  const playBtn = mkBtn('⏸', 'play / pause (Space)', () => toggle());
  const nextBtn = mkBtn('▶', `forward ${STEP_M} m (ArrowRight)`, () => step(1));
  const exitBtn = mkBtn('✕', 'leave the tour (T)', () => exit());

  function sync() {
    bar.textContent = '';
    if (!active) {
      bar.appendChild(enterBtn);
      return;
    }
    playBtn.textContent = playing ? '⏸' : '▶';
    for (const el of [prevBtn, playBtn, nextBtn, exitBtn]) bar.appendChild(el);
  }
  function syncGlyph() {   // per-frame path: only the play/pause glyph can change (progress is
    playBtn.textContent = playing ? '⏸' : '▶';   // still in state().s_m for the headless gates)
  }
  document.body.appendChild(root);
  sync();

  // --- transport -------------------------------------------------------------------------
  function enter() {
    if (active) return true;
    onBeforeEnter();                          // mutual exclusion: walk and rails never coexist
    // rails RELIES on camera-controls (look-around while paused), and viewerApi.setPose
    // disables it. Re-enable + instant re-attach in ONE synchronous block (place() below
    // assigns focusPoint) — the sanctioned form of the script.enabled cycle.
    if (camera.script) camera.script.enabled = true;
    active = true;
    // Re-entry (owner decision 2026-09-05, option C): resume from where the tour was left,
    // playing — `s` is deliberately NOT reset by exit(). If the previous pass had finished,
    // start over (same rule as ▶ at the end), otherwise T after "tour complete" dead-ends.
    if (s >= len - 1e-6) s = 0;
    playing = true;                           // F-13: the tour auto-plays on entry
    lookHoldUntil = 0;
    attachInput();                            // arrows/Space are claimed ONLY while touring
    place();
    onStatus('tour — ◀ ▶ step 1 m · Space pause · drag to look around · T exit');
    return true;
  }

  function exit() {
    if (!active) return;
    active = false;
    playing = false;
    detachInput();
    sync();
    // NOTHING to hand back: camera-controls stayed enabled and its internal pose was
    // re-attached at this exact camera pose on the last frame we moved. No glide, no snap.
    onStatus('orbit — drag orbit · WASD fly');
    requestRender();
  }

  function play() {
    if (!active) return false;
    if (s >= len - 1e-6) s = 0;               // ▶ at the end restarts the tour
    playing = true;
    lookHoldUntil = 0;
    place();                                  // resume from the SAME index, back on the rail
    return true;
  }
  function pause() {
    if (!active) return false;
    playing = false;
    sync();
    requestRender();
    return true;
  }
  const toggle = () => (playing ? pause() : play());

  /** Seek to `metres` along the tour and aim along the filmed look there. */
  function seek(metres) {
    if (!active) return false;
    const v = Number(metres);
    if (!Number.isFinite(v)) return false;
    s = Math.min(Math.max(v, 0), len);
    lookHoldUntil = 0;                        // an explicit stop re-aims along the path
    place();
    return true;
  }
  const step = (n = 1) => seek(s + (Number(n) || 0) * STEP_M);

  // --- per-frame -------------------------------------------------------------------------
  // Paused → we do NOTHING, so camera-controls owns orbit/fly/pan/zoom outright. Playing →
  // we own the position every frame and (unless the user is mid-look) ease the aim toward
  // the filmed direction.
  function update(dt) {
    if (!active || !playing) return;
    s = Math.min(len, s + PLAY_SPEED * Math.min(dt, 0.1));
    sampleAt(s, posTmp, dirTmp);
    if (fixedY != null) posTmp.y = fixedY;
    camera.setPosition(posTmp);
    if (performance.now() < lookHoldUntil) {
      smoothDir.copy(camera.forward);         // hold the user's aim; keep advancing the position
      aimed = false;
    } else {
      smoothDir.lerp(smoothDir, dirTmp, Math.min(1, LOOK_EASE * dt));
      if (smoothDir.lengthSq() > 1e-12) smoothDir.normalize(); else smoothDir.copy(dirTmp);
      aimed = true;
    }
    aimAlong(smoothDir);
    if (s >= len - 1e-6) { playing = false; onStatus('tour complete — ▶ replays · T exit'); }
    syncGlyph();
    requestRender();
  }

  return {
    mode: 'rails',
    get available() { return true; },
    get active() { return active; },
    get playing() { return playing; },
    enter, exit, play, pause, step, seek, update,
    state() {
      const c = camera.getPosition();
      let offPath = null;
      if (active) { sampleAt(s, posTmp, dirTmp); if (fixedY != null) posTmp.y = fixedY; offPath = +posTmp.distance(c).toFixed(3); }
      return {
        available: true, mode: 'rails', active, playing,
        s_m: +s.toFixed(2), length_m: +len.toFixed(2), raw_length_m: +path.len.toFixed(2),
        cut: len < path.len - 1e-6 ? (Number.isFinite(endM) && endM > 0 ? 'url' : path.tourCut) : null,
        eye_y: fixedY, play_speed: PLAY_SPEED,
        index: indexAt(s), samples: path.count, spacing_m: path.spacing,
        file: path.file, aimed, offPath_m: offPath,
        camera: [c.x, c.y, c.z].map(v => +v.toFixed(3)),
      };
    },
  };
}
