// Walk mode (issue #15) — first-person capsule walk over the v1.1 voxel-collision sidecar.
// Physics is a port of the SuperSplat export viewer's WalkController (MIT,
// prototypes/viewer-base-playcanvas/export/index.js ~L86108-86426): fixed-dt substeps,
// 5-ray mean ground probe + spring-damper hover, capsule push-out via collision.queryCapsule.
// Three upstream bugs are fixed in this port (see enter()): a failed spawn probe FREE-FELL,
// reset was a no-op after a failed entry, and a null collision hard-crashed the step.
//
// Camera ownership: camera-controls' update() rewrites the entity transform every frame from
// its internal pose, and disabling both enableOrbit+enableFly is an engine-warned no-op — so
// walk DISABLES the script (entry) and on exit re-enables and sets cameraControls.focusPoint
// in the same synchronous block. The focusPoint SETTER is an INSTANT re-attach
// (attach(pose.look(entityPos, point), false)) that reads the position off the entity, which
// still holds the walk pose because the script's update hasn't run yet; the script's 'state'
// handler drains its buffered input on the enable flip. That sequence is what makes cycling
// script.enabled safe here — see known-issues (camera-controls entry). Do NOT swap this for
// the script's own reset() helper: its attach defaults to smooth=true and GLIDES the camera
// in from the stale pre-walk pose (caught live by walk gate g7).
//
// Input is hand-rolled and exists ONLY while walking: capture-phase window key listeners that
// claim just WASD/Space/Shift/Ctrl (camera-controls' window-level key listeners persist while
// its script is disabled and must never see walk input), pointer-lock mouselook on canvas
// click. Camera fov is left untouched (viewer default 70).
import { Vec3, Quat, math } from 'playcanvas';
import { findCylinderSpawn } from './collision.js';

// physics constants — upstream values except EYE_HEIGHT (upstream 1.3 → eye at floor+1.5;
// ours lands eye at floor + HOVER + EYE_HEIGHT = 1.55, the align_splat EYE_HEIGHT_M convention)
const CAPSULE_HEIGHT = 1.5;
const CAPSULE_RADIUS = 0.2;
const EYE_HEIGHT = 1.35;
const HOVER = 0.2;
const GRAVITY = 9.8;
const JUMP_SPEED = 4;
const MOVE_GROUND_SPEED = 7;
const MOVE_AIR_SPEED = 1;
const ROTATE_DAMPING = 0.95;
const VEL_DAMP_GROUND = 0.99;
const VEL_DAMP_AIR = 0.998;
const SPRING_STIFFNESS = 800;
const SPRING_DAMPING = 57;
const GROUND_PROBE_RANGE = 1.0;
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 10;
// input constants
const MOVE_SPEED = 4;              // m/s pre-multiplier the frame contract expects
const LOOK_DEG_PER_PX = 0.11;      // mouselook sensitivity
const CLAIMED_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space',
                               'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight']);

const damp = (damping, dt) => 1 - Math.pow(damping, dt * 1000);

// frame-rotation + angle-damping (upstream applyFrameRotation/dampAngles, with a settle
// snap added so the asymptotic damp can't keep the camera transform dirty forever under
// render-on-demand)
export function applyFrameRotation(angles, rotate) {
  angles.x -= rotate[1];
  angles.y -= rotate[0];
  angles.z = 0;
  angles.x = math.clamp(angles.x, -90, 90);
}
const mod = (n, m) => ((n % m) + m) % m;
export function dampAngles(angles, target, damping, dt) {
  if (dt <= 0) return;
  const t = damp(damping, dt);
  angles.y = mod(angles.y, 360); target.y = mod(target.y, 360);
  angles.z = mod(angles.z, 360); target.z = mod(target.z, 360);
  angles.x = math.lerpAngle(angles.x, target.x, t);
  angles.y = math.lerpAngle(angles.y, target.y, t);
  angles.z = math.lerpAngle(angles.z, target.z, t);
  if (Math.abs(math.lerpAngle(angles.x, target.x, 1) - angles.x) < 0.005 &&
      Math.abs(math.lerpAngle(angles.y, target.y, 1) - angles.y) < 0.005) {
    angles.copy(target);
  }
}

const rotQuat = new Quat();
export function setYawBasis(yaw, forward, right) {
  rotQuat.setFromEulerAngles(0, yaw, 0);
  rotQuat.transformVector(Vec3.FORWARD, forward);
  rotQuat.transformVector(Vec3.RIGHT, right);
}

// scratch (no per-frame allocation)
const out = { x: 0, y: 0, z: 0 };
const vTmp = new Vec3();
const fwdTmp = new Vec3();
const rightTmp = new Vec3();
const spawnProbe = { x: 0, y: 0, z: 0 };
const moveStep = [0, 0, 0];

// --- input layer (attached only while walk is active) ---
export class WalkInput {
  constructor(canvas) {
    this._canvas = canvas;
    this._held = new Set();
    this._mouse = [0, 0];
    this._onKeyDown = (e) => {
      if (!CLAIMED_CODES.has(e.code)) return;                 // G/R/etc. flow to main.js
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '')) return;
      e.preventDefault();
      e.stopImmediatePropagation();                            // starve camera-controls' sources
      this._held.add(e.code);
    };
    this._onKeyUp = (e) => {
      if (!CLAIMED_CODES.has(e.code)) return;
      e.stopImmediatePropagation();
      this._held.delete(e.code);
    };
    this._onClick = () => {
      if (document.pointerLockElement !== this._canvas) {
        this._canvas.requestPointerLock?.();
      }
    };
    this._onMouseMove = (e) => {
      if (document.pointerLockElement !== this._canvas) return;
      this._mouse[0] += e.movementX ?? 0;
      this._mouse[1] += e.movementY ?? 0;
    };
  }
  attach() {
    window.addEventListener('keydown', this._onKeyDown, { capture: true });
    window.addEventListener('keyup', this._onKeyUp, { capture: true });
    this._canvas.addEventListener('click', this._onClick);
    document.addEventListener('mousemove', this._onMouseMove);
  }
  detach() {
    window.removeEventListener('keydown', this._onKeyDown, { capture: true });
    window.removeEventListener('keyup', this._onKeyUp, { capture: true });
    this._canvas.removeEventListener('click', this._onClick);
    document.removeEventListener('mousemove', this._onMouseMove);
    if (document.pointerLockElement === this._canvas) document.exitPointerLock?.();
    this._held.clear();
    this._mouse[0] = this._mouse[1] = 0;
  }
  /** Frame contract: move in metres-for-this-frame, rotate in degree deltas. */
  read(dt) {
    const h = this._held;
    let mx = (h.has('KeyD') ? 1 : 0) - (h.has('KeyA') ? 1 : 0);
    let mz = (h.has('KeyW') ? 1 : 0) - (h.has('KeyS') ? 1 : 0);
    const len = Math.hypot(mx, mz);
    if (len > 0) { mx /= len; mz /= len; }
    const speed = MOVE_SPEED * (h.has('ShiftLeft') || h.has('ShiftRight') ? 2
                              : h.has('ControlLeft') || h.has('ControlRight') ? 0.5 : 1);
    const jump = h.has('Space') ? 1 : 0;   // held-state; the controller edge-detects (jumpHeld)
    const rotate = [this._mouse[0] * LOOK_DEG_PER_PX, this._mouse[1] * LOOK_DEG_PER_PX, 0];
    this._mouse[0] = this._mouse[1] = 0;
    return { move: [mx * speed * dt, jump, mz * speed * dt], rotate };
  }
}

/**
 * @param {object} o - {app, camera (Entity with cameraControls script), collision
 *   (VoxelCollision), spawn (parsed spawn.json or null), requestRender, onStatus}
 */
export function createWalk({ camera, collision, spawn, requestRender, onStatus = () => {} }) {
  const canvas = document.querySelector('canvas');
  const input = new WalkInput(canvas);

  let active = false;
  const position = new Vec3();
  const prevPosition = new Vec3();
  const angles = new Vec3();
  const targetAngles = new Vec3();
  const velocity = new Vec3();
  const pendingMove = [0, 0, 0];
  let accumulator = 0;
  let grounded = false;
  let jumping = false;
  let jumpHeld = false;
  let lastFloor = null;          // last grounded floor point this session (re-entry continuity)
  let lastGroundY = null;
  let entryFrom = null;          // 'camera' | 'last' | 'spawn' — which probe origin won (gate g5)

  const cc = () => camera.script?.cameraControls ?? null;

  function seedAnglesFromCamera() {
    const f = camera.forward;
    angles.set(
      math.clamp(Math.asin(math.clamp(f.y, -1, 1)) * math.RAD_TO_DEG, -90, 90),
      Math.atan2(-f.x, -f.z) * math.RAD_TO_DEG,
      0,
    );
    targetAngles.copy(angles);
  }

  // probe for a standable floor near an EYE-level origin. expectedFloor (scene convention:
  // spawn eye = floor + 1.55) constrains candidates to the true floor band first — interiors
  // voxelize furniture into raised standable surfaces, and an unconstrained nearest-fit would
  // stand the user on the sofa. Band miss falls back to unconstrained (never-strand wins).
  function probe(ox, oy, oz, expectedFloor = null) {
    const halfHeight = (CAPSULE_HEIGHT + HOVER) * 0.5;
    if (expectedFloor != null) {
      const banded = { floorBand: [expectedFloor - 0.35, expectedFloor + 0.35] };
      if (findCylinderSpawn(collision, ox, oy, oz, halfHeight, CAPSULE_RADIUS, spawnProbe, banded)) {
        return spawnProbe;
      }
    }
    return findCylinderSpawn(collision, ox, oy, oz, halfHeight, CAPSULE_RADIUS, spawnProbe)
      ? spawnProbe : null;
  }

  function teleportToFloor(floor) {
    position.set(floor.x, floor.y + HOVER + EYE_HEIGHT, floor.z);
    prevPosition.copy(position);
    velocity.set(0, 0, 0);
    grounded = true;
    jumping = false;
    jumpHeld = false;
    accumulator = 0;
    pendingMove[0] = pendingMove[1] = pendingMove[2] = 0;
    camera.setPosition(position);
    camera.setEulerAngles(angles.x, angles.y, 0);
    requestRender();
  }

  function enter() {
    if (active) return true;
    if (!collision) { onStatus('walk unavailable — no collision data'); return false; }
    // never-strand entry (upstream bug: a failed probe kept the pose and free-fell). Origins
    // are tried in order and the FIRST hit wins; on total failure the camera and
    // camera-controls are left completely untouched.
    //   1. the CURRENT camera pose — "drop me in where I'm looking" is the natural tour
    //      gesture, and without it G teleported an orbiting visitor back to the spawn every
    //      time, which also made gate g5 ("orbit-entry-never-strand") pass trivially: the
    //      orbit pose was simply discarded, so nothing about it was ever exercised (F-38/C-6).
    //      Banded on the scene floor convention (align_splat floor at y=0) so an overhead
    //      orbit pose can't stand the user on top of the sofa.
    //   2. the last proven standing spot, 3. the scene spawn.
    const cam = camera.getPosition();
    let floor = probe(cam.x, cam.y, cam.z, 0);
    entryFrom = floor ? 'camera' : null;
    if (!floor && lastFloor) {
      floor = probe(lastFloor.x, lastFloor.y + HOVER + EYE_HEIGHT, lastFloor.z, lastFloor.y);
      if (floor) entryFrom = 'last';
    }
    if (!floor && spawn?.position) {
      floor = probe(spawn.position[0], spawn.position[1], spawn.position[2],
                    spawn.position[1] - (HOVER + EYE_HEIGHT));
      if (floor) entryFrom = 'spawn';
    }
    if (!floor) { onStatus('walk unavailable — no standing room near spawn'); return false; }
    seedAnglesFromCamera();
    if (camera.script) camera.script.enabled = false;   // stop the per-frame pose stomp
    input.attach();
    active = true;
    teleportToFloor(floor);
    onStatus('walk — WASD move · click for mouselook · Space jump · R respawn · G exit');
    return true;
  }

  function exit() {
    if (!active) return;
    active = false;
    if (grounded && lastGroundY != null) {
      lastFloor = { x: position.x, y: lastGroundY, z: position.z };
    }
    input.detach();
    // re-enable + re-attach in ONE synchronous block. The focusPoint setter is the INSTANT
    // re-attach (attach(pose.look(entityPos, point), false)) and reads position from the
    // entity — still at the walk pose here, since the script's update hasn't run yet.
    // cc.reset() would glide (attach smooth=true) from the stale pre-walk pose instead.
    // The 'state' handler drains the script's buffered input on the enable flip.
    if (camera.script) {
      camera.script.enabled = true;
      const c = cc();
      if (c) {
        setYawBasis(angles.y, fwdTmp, rightTmp);
        const pitchRad = angles.x * math.DEG_TO_RAD;
        vTmp.set(
          position.x + fwdTmp.x * Math.cos(pitchRad) * 2,
          position.y + Math.sin(pitchRad) * 2,
          position.z + fwdTmp.z * Math.cos(pitchRad) * 2,
        );
        c.focusPoint = vTmp;
      }
    }
    onStatus('orbit — drag orbit · WASD fly');
    requestRender();
  }

  function reset() {
    if (!active || !spawn?.position) return false;
    const floor = probe(spawn.position[0], spawn.position[1], spawn.position[2],
                        spawn.position[1] - (HOVER + EYE_HEIGHT));
    if (!floor) { onStatus('respawn failed — no standing room at spawn'); return false; }
    teleportToFloor(floor);
    return true;
  }

  function probeGround() {
    if (!collision) return null;
    const oy = position.y - EYE_HEIGHT;
    let totalY = 0;
    let hits = 0;
    for (let i = 0; i < 5; i++) {
      let ox = position.x;
      let oz = position.z;
      if (i === 1) ox -= CAPSULE_RADIUS;
      else if (i === 2) ox += CAPSULE_RADIUS;
      else if (i === 3) oz += CAPSULE_RADIUS;
      else if (i === 4) oz -= CAPSULE_RADIUS;
      const hit = collision.queryRay(ox, oy, oz, 0, -1, 0, GROUND_PROBE_RANGE);
      if (hit) { totalY += hit.y; hits++; }
    }
    return hits > 0 ? totalY / hits : null;
  }

  function checkCollision() {
    if (!collision) return;                                  // upstream null-deref fixed
    const center = position.y - EYE_HEIGHT + CAPSULE_HEIGHT * 0.5;
    const half = CAPSULE_HEIGHT * 0.5 - CAPSULE_RADIUS;
    if (collision.queryCapsule(position.x, center, position.z, half, CAPSULE_RADIUS, out)) {
      position.x += out.x; position.y += out.y; position.z += out.z;
      if (out.y < 0 && velocity.y > 0) velocity.y = 0;       // ceiling
      if (!grounded && out.y > 0 && velocity.y < 0) {        // airborne floor contact
        velocity.y = 0;
        grounded = true;
      }
    }
  }

  function step(dt, move) {
    const groundY = probeGround();
    const hasGround = groundY !== null;
    if (hasGround) lastGroundY = groundY;
    if (velocity.y < 0) jumping = false;
    if (move[1] && !jumping && grounded && !jumpHeld) {
      jumping = true;
      velocity.y = JUMP_SPEED;
      grounded = false;
    }
    jumpHeld = !!move[1];
    if (hasGround && !jumping) {
      const targetY = groundY + HOVER + EYE_HEIGHT;
      const displacement = position.y - targetY;
      if (displacement > 0.1) {
        velocity.y -= GRAVITY * dt;
        const nextY = position.y + velocity.y * dt;
        if (nextY <= targetY) { position.y = targetY; velocity.y = 0; }
        grounded = false;
      } else {
        velocity.y += (-SPRING_STIFFNESS * displacement - SPRING_DAMPING * velocity.y) * dt;
        grounded = true;
      }
    } else {
      velocity.y -= GRAVITY * dt;
      grounded = false;
    }
    setYawBasis(angles.y, fwdTmp, rightTmp);
    vTmp.set(
      rightTmp.x * move[0] + fwdTmp.x * move[2],
      0,
      rightTmp.z * move[0] + fwdTmp.z * move[2],
    );
    velocity.add(vTmp.mulScalar(grounded ? MOVE_GROUND_SPEED : MOVE_AIR_SPEED));
    const alpha = damp(grounded ? VEL_DAMP_GROUND : VEL_DAMP_AIR, dt);
    velocity.x = math.lerp(velocity.x, 0, alpha);
    velocity.z = math.lerp(velocity.z, 0, alpha);
    // settle snap: below-noise velocity with no input → hold exactly (render-on-demand:
    // the camera transform must stop changing or on-demand rendering never idles)
    if (grounded && move[0] === 0 && move[2] === 0 &&
        velocity.lengthSq() < 1e-6 && Math.abs(position.y - (lastGroundY + HOVER + EYE_HEIGHT)) < 1e-3) {
      velocity.set(0, 0, 0);
      return;
    }
    position.add(vTmp.copy(velocity).mulScalar(dt));
    checkCollision();
  }

  function update(dt) {
    if (!active) return;
    const { move, rotate } = input.read(dt);
    applyFrameRotation(targetAngles, rotate);
    dampAngles(angles, targetAngles, ROTATE_DAMPING, dt);
    pendingMove[0] += move[0];
    pendingMove[1] = pendingMove[1] || move[1];
    pendingMove[2] += move[2];
    accumulator = Math.min(accumulator + dt, MAX_SUBSTEPS * FIXED_DT);
    const numSteps = Math.floor(accumulator / FIXED_DT);
    if (numSteps > 0) {
      const invSteps = 1 / numSteps;
      moveStep[0] = pendingMove[0] * invSteps;
      moveStep[1] = pendingMove[1];
      moveStep[2] = pendingMove[2] * invSteps;
      for (let i = 0; i < numSteps; i++) {
        prevPosition.copy(position);
        step(FIXED_DT, moveStep);
        accumulator -= FIXED_DT;
      }
      pendingMove[0] = pendingMove[1] = pendingMove[2] = 0;
    }
    const alpha = accumulator / FIXED_DT;
    vTmp.lerp(prevPosition, position, alpha);
    camera.setPosition(vTmp);
    camera.setEulerAngles(angles.x, angles.y, 0);
  }

  return {
    get available() { return !!collision; },
    mode: 'voxel',                                           // navwalk.js exposes 'navmesh'
    get active() { return active; },
    enter, exit, reset, update,
    setLook(yawDeg, pitchDeg) {                              // automation/test hook
      angles.set(math.clamp(pitchDeg, -90, 90), yawDeg, 0);
      targetAngles.copy(angles);
      if (active) { camera.setEulerAngles(angles.x, angles.y, 0); requestRender(); }
    },
    state() {
      return {
        available: !!collision, active, grounded, mode: 'voxel',
        entryFrom,                                   // which probe origin won (gate g5)
        eyeY: active ? +position.y.toFixed(3) : null,
      };
    },
  };
}
