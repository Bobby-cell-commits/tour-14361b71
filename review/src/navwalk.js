// Navmesh walk (issue #16 Lane N spike, 2026-09-02) — first-person walk clamped to a Detour
// navmesh (`<base>/<scene>.navmesh.bin`, baked offline by prototypes/navmesh-probe/bake.mjs from
// the trajectory-corridor floor ± body-band obstacles). Containment is by construction: the
// agent can only ever be ON the mesh (NavMeshQuery.moveAlongSurface slides along polygon edges),
// so out-of-bounds is not a state that exists. Standing height = mesh surface + EYE (the floor
// polygons sit at the align_splat y=0 floor, so eye = 1.55 above the visual floor everywhere).
// No gravity, no capsule, no ray probes — the mesh IS the ground.
//
// Placed pieces (the staging document's boxes) are RUNTIME obstacles (#16 rider, 2026-09-14,
// walk-obstacles.js): every sub-step's Detour slide is tested as a segment against the placements'
// XZ AABBs expanded by BODY_RADIUS_M, and a move that would ENTER a piece is refused or slid along
// its face. Not baked: a placed piece stands on the walked corridor, so a bake cuts the mesh
// (research/2026-09-14-placement-obstacles-runtime-vs-bake.md). Leave-only per box: a walker that
// starts inside a piece (a covered spawn) walks out — never strands.
//
// Shares the input layer + camera-controls handoff with walk.js (same G/R keys, same never-strand
// entry contract: a failed spawn lookup leaves orbit untouched). Runtime: vendored
// @recast-navigation/core + wasm (importmap entries in index.html; ~1 MB, loads lazily only when a
// navmesh sidecar exists).
import { Vec3, math, Mesh, MeshInstance, Entity, StandardMaterial, BLEND_NORMAL, PRIMITIVE_TRIANGLES, Color, CULLFACE_NONE } from 'playcanvas';
import { WalkInput, applyFrameRotation, dampAngles, setYawBasis } from './walk.js';
import { resolveMove, insideOf } from './walk-obstacles.js';

const EYE = 1.55;                 // align_splat EYE_HEIGHT_M convention (walk.js: HOVER + EYE_HEIGHT)
const SPEED_SCALE = 0.75;         // WalkInput yields 4 m/s nominal; walk.js's damped model nets ~3 m/s
const ACCEL_TAU = 0.12;           // s — velocity approach time constant (feel knob)
const ROTATE_DAMPING = 0.95;
const MAX_DT = 0.1;
const SPAWN_HALF_EXTENTS = { x: 1.0, y: 1.5, z: 1.0 };
// The walker's body radius against PLACED pieces = the bake's agent_radius_m (0.2, H18): one body, one
// radius, against baked obstacles and staged furniture alike. Measured 2026-09-14 (r ∈ {0, 0.1, 0.2, 0.3}
// on the living chair, research/2026-09-14-walk-obstacles-radius.md) before this constant was fixed.
export const BODY_RADIUS_M = 0.2;
const SUB_STEP_M = 0.1;           // every move is sub-stepped at this length (update() and step() alike)

const vTmp = new Vec3();
const fwdTmp = new Vec3();
const rightTmp = new Vec3();

let recastReady = null;
async function recast() {
  const core = await import('@recast-navigation/core');
  if (!recastReady) recastReady = core.init();
  await recastReady;
  return core;
}

/** Fetch + import a navmesh.bin. Resolves null on 404 (no sidecar = no navmesh walk).
 *  `init` reaches fetch — pass { cache: 'reload' } after a re-bake (Chrome's heuristic cache
 *  serves a python http.server sidecar stale for hours, known-issues 2026-09-03). */
export async function loadNavmesh(url, init = undefined) {
  const r = await fetch(url, init);
  if (!r.ok) return null;
  const buf = new Uint8Array(await r.arrayBuffer());
  const core = await recast();
  const { navMesh } = core.importNavMesh(buf);
  const query = new core.NavMeshQuery(navMesh);
  const [positions, indices] = core.getNavMeshPositionsAndIndices(navMesh);
  let area = 0;
  for (let t = 0; t < indices.length / 3; t++) {
    const [a, b, c] = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
    area += Math.abs((positions[b * 3] - positions[a * 3]) * (positions[c * 3 + 2] - positions[a * 3 + 2]) -
                     (positions[c * 3] - positions[a * 3]) * (positions[b * 3 + 2] - positions[a * 3 + 2])) * 0.5;
  }
  return { navMesh, query, positions, indices, _file: url, bytes: buf.byteLength, tris: indices.length / 3, area_m2: +area.toFixed(2) };
}

function createDebugEntity(app, nav) {
  const mesh = new Mesh(app.graphicsDevice);
  const pos = new Float32Array(nav.positions.length);
  for (let i = 0; i < pos.length; i++) pos[i] = nav.positions[i] + (i % 3 === 1 ? 0.03 : 0);   // lift 3 cm off the floor
  mesh.setPositions(pos);
  // WebGPU needs every attribute the material's vertex state declares: a StandardMaterial reads normals
  // (slot 1), and a mesh without them is an INVALID pipeline on WebGPU (silent on WebGL2) — flat up-normals.
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  mesh.setNormals(nrm);
  mesh.setIndices(nav.indices);
  mesh.update(PRIMITIVE_TRIANGLES);
  const mat = new StandardMaterial();
  mat.diffuse = new Color(0, 0, 0);
  mat.emissive = new Color(0.2, 1.0, 0.3);
  mat.opacity = 0.35;
  mat.blendType = BLEND_NORMAL;
  mat.depthWrite = false;
  mat.cull = CULLFACE_NONE;
  mat.update();
  const e = new Entity('navmesh-debug');
  e.addComponent('render', { meshInstances: [new MeshInstance(mesh, mat)] });
  e.enabled = false;
  app.root.addChild(e);
  return e;
}

/**
 * @param {object} o - {app, camera (Entity with cameraControls script), nav (loadNavmesh result),
 *   spawn (parsed spawn.json or null), requestRender, onStatus, debug (initial overlay on/off),
 *   obstacles: () => [{id, min:[x,y,z], max:[x,y,z]}] — a LIVE getter (the walk mounts before the
 *   placements load; the document memoises), bodyRadius (m, default BODY_RADIUS_M)}
 */
export function createNavWalk({ app, camera, nav, spawn, requestRender, onStatus = () => {}, debug = false,
                                obstacles = () => [], bodyRadius = BODY_RADIUS_M }) {
  const canvas = document.querySelector('canvas');
  const input = new WalkInput(canvas);
  const { query } = nav;

  let active = false;
  let ref = 0;                                   // current poly ref (0 = off mesh)
  const pos = { x: 0, y: 0, z: 0 };              // agent point ON the mesh
  const vel = new Vec3();
  const angles = new Vec3();
  const targetAngles = new Vec3();
  let eyeY = 0;
  let lastPos = null;                            // last on-mesh point (re-entry continuity)
  let debugEntity = null;
  let debugOn = false;
  let entryFrom = null;                          // 'camera' | 'last' | 'spawn' — how the last enter() landed
  let lastBlockedBy = null;                      // the placement the last advance() ran into (null = clear)

  const cc = () => camera.script?.cameraControls ?? null;

  function seedAnglesFromCamera() {
    const f = camera.forward;
    angles.set(math.clamp(Math.asin(math.clamp(f.y, -1, 1)) * math.RAD_TO_DEG, -90, 90),
               Math.atan2(-f.x, -f.z) * math.RAD_TO_DEG, 0);
    targetAngles.copy(angles);
  }

  function surfaceY(r, p) {
    const h = query.getPolyHeight(r, p);
    return h.success ? h.height : p.y;
  }

  /** nearest on-mesh point to a FLOOR-level point; null when none within the search box */
  function locate(x, y, z) {
    const n = query.findNearestPoly({ x, y, z }, { halfExtents: SPAWN_HALF_EXTENTS });
    if (!n.success || !n.nearestRef) return null;
    return { ref: n.nearestRef, point: n.nearestPoint };
  }

  function place(hit) {
    ref = hit.ref;
    pos.x = hit.point.x; pos.y = hit.point.y; pos.z = hit.point.z;
    eyeY = surfaceY(ref, pos) + EYE;
    vel.set(0, 0, 0);
    lastBlockedBy = null;
    camera.setPosition(pos.x, eyeY, pos.z);
    camera.setEulerAngles(angles.x, angles.y, 0);
    requestRender();
  }

  /** the placed pieces covering an on-mesh point (body radius included) */
  const coveredBy = (p) => insideOf({ x: p.x, z: p.z }, obstacles(), bodyRadius);

  const WALK_STATUS = 'walk (navmesh) — WASD move · click for mouselook · R respawn · M mesh overlay · G exit';
  function enter() {
    if (active) return true;
    // entry order (never-strand): the CURRENT camera pose if its floor point is on the mesh
    // (drop in where you're looking, within the spawn search box) AND not inside a placed piece,
    // else the last on-mesh point, else the scene spawn. A total miss leaves orbit untouched.
    // `last` and `spawn` ACCEPT a point inside a piece (a covered spawn must not read "walk
    // unavailable" for every visitor — leave-only lets them walk out; the status names it).
    const cp = camera.getPosition();
    let hit = locate(cp.x, cp.y - EYE, cp.z);
    if (hit && coveredBy(hit.point).length) hit = null;
    entryFrom = hit ? 'camera' : null;
    if (!hit && lastPos) { hit = locate(lastPos.x, lastPos.y, lastPos.z); if (hit) entryFrom = 'last'; }
    if (!hit && spawn?.position) { hit = locate(spawn.position[0], spawn.position[1] - EYE, spawn.position[2]); if (hit) entryFrom = 'spawn'; }
    if (!hit) { onStatus('walk unavailable — no navmesh under the camera or the spawn'); return false; }
    seedAnglesFromCamera();
    if (camera.script) camera.script.enabled = false;
    input.attach();
    active = true;
    place(hit);
    const inside = coveredBy(pos);
    onStatus(inside.length ? `${WALK_STATUS} · inside a placed piece (${inside.join(', ')}) — walk out` : WALK_STATUS);
    return true;
  }

  // Detour slide as a stateless candidate probe: nothing is committed until resolveMove accepts one.
  function slide(target) {
    const r = query.moveAlongSurface(ref, pos, target);
    return r.success ? { x: r.resultPosition.x, y: r.resultPosition.y, z: r.resultPosition.z, visited: r.visited } : null;
  }

  /** one sub-step of (dx, dz) against the mesh AND the placed pieces → {moved, blocked_by, slid} */
  function advance(dx, dz) {
    if (!ref) return { moved: false, blocked_by: null, slid: false };
    const { result, candidate, blocked_by } = resolveMove(slide, pos, dx, dz, obstacles(), bodyRadius);
    if (result) {
      pos.x = result.x; pos.y = result.y; pos.z = result.z;
      if (result.visited?.length) ref = result.visited[result.visited.length - 1];
      pos.y = surfaceY(ref, pos);
    }
    lastBlockedBy = blocked_by;
    return { moved: !!result, blocked_by, slid: !!result && candidate !== 'full' };
  }

  /** a metre-wise move sub-stepped at SUB_STEP_M; stops at the first fully blocked sub-step */
  function travel(dx, dz) {
    const len = Math.hypot(dx, dz);
    const n = Math.max(1, Math.ceil(len / SUB_STEP_M));
    let blocked = null, slid = false;
    for (let i = 0; i < n; i++) {
      const a = advance(dx / n, dz / n);
      blocked = blocked ?? a.blocked_by;
      slid = slid || a.slid;
      if (!a.moved) break;
    }
    return { sub_steps: n, blocked_by: blocked, slid };
  }

  function exit() {
    if (!active) return;
    active = false;
    lastPos = { x: pos.x, y: pos.y, z: pos.z };
    input.detach();
    // same re-attach contract as walk.js: enable + INSTANT focusPoint re-attach in one block
    if (camera.script) {
      camera.script.enabled = true;
      const c = cc();
      if (c) {
        setYawBasis(angles.y, fwdTmp, rightTmp);
        const pitchRad = angles.x * math.DEG_TO_RAD;
        vTmp.set(pos.x + fwdTmp.x * Math.cos(pitchRad) * 2, eyeY + Math.sin(pitchRad) * 2, pos.z + fwdTmp.z * Math.cos(pitchRad) * 2);
        c.focusPoint = vTmp;
      }
    }
    onStatus('orbit — drag orbit · WASD fly');
    requestRender();
  }

  function reset() {
    if (!active || !spawn?.position) return false;
    const hit = locate(spawn.position[0], spawn.position[1] - EYE, spawn.position[2]);
    if (!hit) { onStatus('respawn failed — spawn is not on the navmesh'); return false; }
    place(hit);
    return true;
  }

  function update(dt) {
    if (!active) return;
    dt = Math.min(dt, MAX_DT);
    const { move, rotate } = input.read(dt);
    applyFrameRotation(targetAngles, rotate);
    dampAngles(angles, targetAngles, ROTATE_DAMPING, dt);
    // desired horizontal velocity in the yaw basis (move is metres-this-frame → m/s)
    setYawBasis(angles.y, fwdTmp, rightTmp);
    const inv = dt > 0 ? SPEED_SCALE / dt : 0;
    vTmp.set((rightTmp.x * move[0] + fwdTmp.x * move[2]) * inv, 0, (rightTmp.z * move[0] + fwdTmp.z * move[2]) * inv);
    const k = 1 - Math.exp(-dt / ACCEL_TAU);
    vel.lerp(vel, vTmp, k);
    if (vel.lengthSq() < 1e-6) vel.set(0, 0, 0);
    if (vel.lengthSq() > 0 && ref) travel(vel.x * dt, vel.z * dt);
    const targetEye = pos.y + EYE;
    eyeY += (targetEye - eyeY) * Math.min(1, dt * 12);        // soften any step in the surface
    if (Math.abs(targetEye - eyeY) < 1e-3) eyeY = targetEye;
    camera.setPosition(pos.x, eyeY, pos.z);
    camera.setEulerAngles(angles.x, angles.y, 0);
  }

  function setDebug(on) {
    if (on && !debugEntity) debugEntity = createDebugEntity(app, nav);
    debugOn = !!on;
    if (debugEntity) debugEntity.enabled = debugOn;
    requestRender();
  }
  if (debug) setDebug(true);

  // dispose: the reload path (viewerApi.walk.reload, 1b) swaps the whole walk for one built on the
  // re-baked mesh — detach input, drop the overlay entity, free the Detour objects when the vendored
  // core exposes destroy(); the caller must exit() first (exit re-attaches camera-controls at the pose).
  function dispose() {
    if (active) exit();
    if (debugEntity) { app.root.removeChild(debugEntity); debugEntity.destroy?.(); debugEntity = null; }
    try { nav.query?.destroy?.(); nav.navMesh?.destroy?.(); } catch (err) { console.warn('[walk] navmesh dispose', err); }
  }

  return {
    mode: 'navmesh',
    get available() { return true; },
    get active() { return active; },
    enter, exit, reset, update, dispose,
    toggleDebug() { setDebug(!debugOn); return debugOn; },
    setLook(yawDeg, pitchDeg) {
      angles.set(math.clamp(pitchDeg, -90, 90), yawDeg, 0);
      targetAngles.copy(angles);
      if (active) { camera.setEulerAngles(angles.x, angles.y, 0); requestRender(); }
    },
    // step: a deterministic metre-wise move for the eyes tool (P19 slice 2) — the SAME travel()
    // update() runs per frame (Detour slide + placed-piece obstacles, sub-stepped at SUB_STEP_M),
    // so wall clamping and furniture blocking match the keyed walk; no accel ramp, no eye smoothing
    // (a snapshot pose, not a feel). null when inactive. `blocked_by` names the piece the move ran
    // into (a slide along its face still reports it), `slid` says the walker went around.
    step(forwardM = 0, strafeM = 0) {
      if (!active || !ref) return null;
      setYawBasis(angles.y, fwdTmp, rightTmp);
      const dx = fwdTmp.x * forwardM + rightTmp.x * strafeM, dz = fwdTmp.z * forwardM + rightTmp.z * strafeM;
      const len = Math.hypot(dx, dz);
      const x0 = pos.x, z0 = pos.z;
      const t = travel(dx, dz);
      vel.set(0, 0, 0);
      eyeY = pos.y + EYE;
      camera.setPosition(pos.x, eyeY, pos.z);
      camera.setEulerAngles(angles.x, angles.y, 0);
      requestRender();
      return { moved_m: +Math.hypot(pos.x - x0, pos.z - z0).toFixed(4), requested_m: +len.toFixed(4), onMesh: !!ref,
               sub_steps: t.sub_steps, blocked_by: t.blocked_by, slid: t.slid };
    },
    state() {
      return {
        available: true, mode: 'navmesh', active, onMesh: !!ref, debug: debugOn, entryFrom,
        eyeY: active ? +eyeY.toFixed(3) : null,
        surfaceY: active ? +pos.y.toFixed(3) : null,
        navmesh: { file: nav._file, tris: nav.tris, area_m2: nav.area_m2, bytes: nav.bytes },
        // the placed-piece obstacle set is a WALK-TIME fact: null at rest, so a golden shot in orbit keeps
        // its facts.json (diffFacts: null ≡ missing — the same rule that let `annotations` grow, 2026-09-10)
        obstacles: active ? { n: obstacles().length, radius_m: bodyRadius, inside: coveredBy(pos) } : null,
        blocked_by: lastBlockedBy,
      };
    },
  };
}
