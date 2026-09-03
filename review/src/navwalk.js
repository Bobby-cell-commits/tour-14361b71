// Navmesh walk (issue #16 Lane N spike, 2026-09-02) — first-person walk clamped to a Detour
// navmesh (`<base>/<scene>.navmesh.bin`, baked offline by prototypes/navmesh-probe/bake.mjs from
// the trajectory-corridor floor ± body-band obstacles). Containment is by construction: the
// agent can only ever be ON the mesh (NavMeshQuery.moveAlongSurface slides along polygon edges),
// so out-of-bounds is not a state that exists. Standing height = mesh surface + EYE (the floor
// polygons sit at the align_splat y=0 floor, so eye = 1.55 above the visual floor everywhere).
// No gravity, no capsule, no ray probes — the mesh IS the ground.
//
// Shares the input layer + camera-controls handoff with walk.js (same G/R keys, same never-strand
// entry contract: a failed spawn lookup leaves orbit untouched). Runtime: vendored
// @recast-navigation/core + wasm (importmap entries in index.html; ~1 MB, loads lazily only when a
// navmesh sidecar exists).
import { Vec3, math, Mesh, MeshInstance, Entity, StandardMaterial, BLEND_NORMAL, PRIMITIVE_TRIANGLES, Color, CULLFACE_NONE } from 'playcanvas';
import { WalkInput, applyFrameRotation, dampAngles, setYawBasis } from './walk.js';

const EYE = 1.55;                 // align_splat EYE_HEIGHT_M convention (walk.js: HOVER + EYE_HEIGHT)
const SPEED_SCALE = 0.75;         // WalkInput yields 4 m/s nominal; walk.js's damped model nets ~3 m/s
const ACCEL_TAU = 0.12;           // s — velocity approach time constant (feel knob)
const ROTATE_DAMPING = 0.95;
const MAX_DT = 0.1;
const SPAWN_HALF_EXTENTS = { x: 1.0, y: 1.5, z: 1.0 };

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

/** Fetch + import a navmesh.bin. Resolves null on 404 (no sidecar = no navmesh walk). */
export async function loadNavmesh(url) {
  const r = await fetch(url);
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
 *   spawn (parsed spawn.json or null), requestRender, onStatus, debug (initial overlay on/off)}
 */
export function createNavWalk({ app, camera, nav, spawn, requestRender, onStatus = () => {}, debug = false }) {
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
    camera.setPosition(pos.x, eyeY, pos.z);
    camera.setEulerAngles(angles.x, angles.y, 0);
    requestRender();
  }

  function enter() {
    if (active) return true;
    // entry order (never-strand): the CURRENT camera pose if its floor point is on the mesh
    // (drop in where you're looking, within the spawn search box), else the last on-mesh
    // point, else the scene spawn. A total miss leaves orbit untouched.
    const cp = camera.getPosition();
    let hit = locate(cp.x, cp.y - EYE, cp.z);
    entryFrom = hit ? 'camera' : null;
    if (!hit && lastPos) { hit = locate(lastPos.x, lastPos.y, lastPos.z); if (hit) entryFrom = 'last'; }
    if (!hit && spawn?.position) { hit = locate(spawn.position[0], spawn.position[1] - EYE, spawn.position[2]); if (hit) entryFrom = 'spawn'; }
    if (!hit) { onStatus('walk unavailable — no navmesh under the camera or the spawn'); return false; }
    seedAnglesFromCamera();
    if (camera.script) camera.script.enabled = false;
    input.attach();
    active = true;
    place(hit);
    onStatus('walk (navmesh) — WASD move · click for mouselook · R respawn · M mesh overlay · G exit');
    return true;
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
    if (vel.lengthSq() > 0 && ref) {
      const target = { x: pos.x + vel.x * dt, y: pos.y, z: pos.z + vel.z * dt };
      const r = query.moveAlongSurface(ref, pos, target);
      if (r.success) {
        pos.x = r.resultPosition.x; pos.y = r.resultPosition.y; pos.z = r.resultPosition.z;
        if (r.visited.length) ref = r.visited[r.visited.length - 1];
        pos.y = surfaceY(ref, pos);
      }
    }
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

  return {
    mode: 'navmesh',
    get available() { return true; },
    get active() { return active; },
    enter, exit, reset, update,
    toggleDebug() { setDebug(!debugOn); return debugOn; },
    setLook(yawDeg, pitchDeg) {
      angles.set(math.clamp(pitchDeg, -90, 90), yawDeg, 0);
      targetAngles.copy(angles);
      if (active) { camera.setEulerAngles(angles.x, angles.y, 0); requestRender(); }
    },
    state() {
      return {
        available: true, mode: 'navmesh', active, onMesh: !!ref, debug: debugOn, entryFrom,
        eyeY: active ? +eyeY.toFixed(3) : null,
        surfaceY: active ? +pos.y.toFixed(3) : null,
        navmesh: { file: nav._file, tris: nav.tris, area_m2: nav.area_m2, bytes: nav.bytes },
      };
    },
  };
}
