// Voxel-collision consumer (issue #15) — reads the pipeline's canonical v1.1 sparse-octree
// artifact (<scene>.voxel.json + .voxel.bin, CollisionStage) directly: y-up, no flip.
// Port of the SuperSplat export viewer's VoxelCollision + findCylinderSpawn (MIT,
// prototypes/viewer-base-playcanvas/export/index.js ~L80868-82456, 85697), verified against
// scripts/voxel_report.py by tests/test_collision_js_parity.py.
//
// Zero imports by design: node-runnable for the parity test, and this module is also the
// future operator-editor occupancy surface (#5 rider) — isFreeAt/queryRay answer "is this
// spot occupied" without any engine type.
//
// ⚠ Semantics that containment depends on: isFreeAt() returns FALSE outside the grid
// (out-of-grid = solid — the authored containment relies on it). isVoxelSolid() takes
// GRID indices and returns false out-of-range; world-space callers use isFreeAt.
// ⚠ queryRay does NOT normalize dir — pass unit vectors, or maxDist is in |dir| units.

/** Fully-solid subtree sentinel: childMask 0xFF + baseOffset 0 (BFS layout makes it unambiguous). */
export const SOLID_LEAF_MARKER = 0xff000000 >>> 0;

/** Minimum penetration depth to report (avoids floating-point noise). */
const PENETRATION_EPSILON = 1e-4;
/** Maximum iterations for iterative capsule resolution. */
const MAX_RESOLVE_ITERATIONS = 4;

function popcount(n) {
  n = n - ((n >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  return (((n + (n >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

// Iteratively resolve penetrations: repeatedly query the deepest overlap, project the push
// off previously recorded constraint normals (≤3 — this is what makes corners slide), and
// accumulate. `out` is written only on a significant total push.
function resolveIterative(cx, cy, cz, findPenetration, constraintNormals, scratch, out) {
  let resolvedX = cx, resolvedY = cy, resolvedZ = cz;
  let totalPushX = 0, totalPushY = 0, totalPushZ = 0;
  let hadCollision = false;
  let numNormals = 0;
  for (let iter = 0; iter < MAX_RESOLVE_ITERATIONS; iter++) {
    if (!findPenetration(resolvedX, resolvedY, resolvedZ, scratch)) break;
    hadCollision = true;
    let px = scratch.x, py = scratch.y, pz = scratch.z;
    for (let i = 0; i < numNormals; i++) {
      const n = constraintNormals[i];
      const dot = px * n.x + py * n.y + pz * n.z;
      if (dot < 0) { px -= dot * n.x; py -= dot * n.y; pz -= dot * n.z; }
    }
    const len = Math.sqrt(scratch.x * scratch.x + scratch.y * scratch.y + scratch.z * scratch.z);
    if (len > PENETRATION_EPSILON && numNormals < 3) {
      const invLen = 1.0 / len;
      const n = constraintNormals[numNormals];
      n.x = scratch.x * invLen; n.y = scratch.y * invLen; n.z = scratch.z * invLen;
      numNormals++;
    }
    resolvedX += px; resolvedY += py; resolvedZ += pz;
    totalPushX += px; totalPushY += py; totalPushZ += pz;
  }
  const totalPushSq = totalPushX * totalPushX + totalPushY * totalPushY + totalPushZ * totalPushZ;
  const significant = hadCollision && totalPushSq > PENETRATION_EPSILON * PENETRATION_EPSILON;
  if (significant) { out.x = totalPushX; out.y = totalPushY; out.z = totalPushZ; }
  return significant;
}

export class VoxelCollision {
  /**
   * @param {object} meta - parsed <scene>.voxel.json (gridBounds, voxelResolution, leafSize,
   *   treeDepth, nodeCount, leafDataCount)
   * @param {Uint32Array} u32 - the whole .voxel.bin as one LE u32 stream:
   *   nodes[0..nodeCount) then leafData[nodeCount..nodeCount+leafDataCount)
   */
  constructor(meta, u32) {
    this._gridMinX = meta.gridBounds.min[0];
    this._gridMinY = meta.gridBounds.min[1];
    this._gridMinZ = meta.gridBounds.min[2];
    const res = meta.voxelResolution;
    this._numVoxelsX = Math.round((meta.gridBounds.max[0] - meta.gridBounds.min[0]) / res);
    this._numVoxelsY = Math.round((meta.gridBounds.max[1] - meta.gridBounds.min[1]) / res);
    this._numVoxelsZ = Math.round((meta.gridBounds.max[2] - meta.gridBounds.min[2]) / res);
    this._voxelResolution = res;
    this._leafSize = meta.leafSize;
    this._treeDepth = meta.treeDepth;
    this._nodes = u32.slice(0, meta.nodeCount);
    this._leafData = u32.slice(meta.nodeCount, meta.nodeCount + meta.leafDataCount);
    // pre-allocated scratch (no per-frame allocation on the physics path)
    this._push = { x: 0, y: 0, z: 0 };
    this._constraintNormals = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  }

  get gridMinX() { return this._gridMinX; }
  get gridMinY() { return this._gridMinY; }
  get gridMinZ() { return this._gridMinZ; }
  get numVoxelsX() { return this._numVoxelsX; }
  get numVoxelsY() { return this._numVoxelsY; }
  get numVoxelsZ() { return this._numVoxelsZ; }
  get voxelResolution() { return this._voxelResolution; }

  /** Solid test by GRID index (out-of-range → false; world-space callers use isFreeAt). */
  isVoxelSolid(ix, iy, iz) {
    if (this._nodes.length === 0 ||
        ix < 0 || iy < 0 || iz < 0 ||
        ix >= this._numVoxelsX || iy >= this._numVoxelsY || iz >= this._numVoxelsZ) {
      return false;
    }
    const leafSize = this._leafSize, treeDepth = this._treeDepth;
    const blockX = Math.floor(ix / leafSize);
    const blockY = Math.floor(iy / leafSize);
    const blockZ = Math.floor(iz / leafSize);
    let nodeIndex = 0;
    for (let level = treeDepth - 1; level >= 0; level--) {
      const node = this._nodes[nodeIndex] >>> 0;
      if (node === SOLID_LEAF_MARKER) return true;
      const childMask = (node >>> 24) & 0xff;
      if (childMask === 0) return this._checkLeaf(node, ix, iy, iz);   // mixed leaf
      const bitX = (blockX >>> level) & 1;
      const bitY = (blockY >>> level) & 1;
      const bitZ = (blockZ >>> level) & 1;
      const octant = (bitZ << 2) | (bitY << 1) | bitX;
      if ((childMask & (1 << octant)) === 0) return false;
      const baseOffset = node & 0x00ffffff;
      nodeIndex = baseOffset + popcount(childMask & ((1 << octant) - 1));
    }
    const node = this._nodes[nodeIndex] >>> 0;
    if (node === SOLID_LEAF_MARKER) return true;
    return this._checkLeaf(node, ix, iy, iz);
  }

  _checkLeaf(node, ix, iy, iz) {
    const leafDataIndex = node & 0x00ffffff;
    const bitIndex = (iz & 3) * 16 + (iy & 3) * 4 + (ix & 3);
    if (bitIndex < 32) return (((this._leafData[leafDataIndex * 2] >>> 0) >>> bitIndex) & 1) === 1;
    return (((this._leafData[leafDataIndex * 2 + 1] >>> 0) >>> (bitIndex - 32)) & 1) === 1;
  }

  /** World-space free test. Out-of-grid (or empty data) → FALSE — containment depends on it. */
  isFreeAt(x, y, z) {
    if (this._nodes.length === 0) return false;
    const res = this._voxelResolution;
    const ix = Math.floor((x - this._gridMinX) / res);
    const iy = Math.floor((y - this._gridMinY) / res);
    const iz = Math.floor((z - this._gridMinZ) / res);
    if (ix < 0 || iy < 0 || iz < 0 ||
        ix >= this._numVoxelsX || iy >= this._numVoxelsY || iz >= this._numVoxelsZ) {
      return false;
    }
    return !this.isVoxelSolid(ix, iy, iz);
  }

  /**
   * 3D DDA voxel march. Returns the world-space entry point {x,y,z} of the first solid cell
   * (the origin itself when starting inside solid), or null. dir must be unit-length.
   */
  queryRay(ox, oy, oz, dx, dy, dz, maxDist) {
    if (this._nodes.length === 0) return null;
    const res = this._voxelResolution;
    const gMinX = this._gridMinX, gMinY = this._gridMinY, gMinZ = this._gridMinZ;
    const gMaxX = gMinX + this._numVoxelsX * res;
    const gMaxY = gMinY + this._numVoxelsY * res;
    const gMaxZ = gMinZ + this._numVoxelsZ * res;
    const EPS = 1e-12;
    let tNear = 0, tFar = maxDist;
    if (Math.abs(dx) > EPS) {
      let t1 = (gMinX - ox) / dx, t2 = (gMaxX - ox) / dx;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tNear) tNear = t1;
      tFar = Math.min(tFar, t2);
      if (tNear > tFar) return null;
    } else if (ox < gMinX || ox >= gMaxX) return null;
    if (Math.abs(dy) > EPS) {
      let t1 = (gMinY - oy) / dy, t2 = (gMaxY - oy) / dy;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tNear) tNear = t1;
      tFar = Math.min(tFar, t2);
      if (tNear > tFar) return null;
    } else if (oy < gMinY || oy >= gMaxY) return null;
    if (Math.abs(dz) > EPS) {
      let t1 = (gMinZ - oz) / dz, t2 = (gMaxZ - oz) / dz;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tNear) tNear = t1;
      tFar = Math.min(tFar, t2);
      if (tNear > tFar) return null;
    } else if (oz < gMinZ || oz >= gMaxZ) return null;
    const entryX = ox + dx * tNear, entryY = oy + dy * tNear, entryZ = oz + dz * tNear;
    let ix = Math.max(0, Math.min(Math.floor((entryX - gMinX) / res), this._numVoxelsX - 1));
    let iy = Math.max(0, Math.min(Math.floor((entryY - gMinY) / res), this._numVoxelsY - 1));
    let iz = Math.max(0, Math.min(Math.floor((entryZ - gMinZ) / res), this._numVoxelsZ - 1));
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const invDx = Math.abs(dx) > EPS ? 1.0 / dx : 0;
    const invDy = Math.abs(dy) > EPS ? 1.0 / dy : 0;
    const invDz = Math.abs(dz) > EPS ? 1.0 / dz : 0;
    let tMaxX = Math.abs(dx) > EPS ? (gMinX + (ix + (dx > 0 ? 1 : 0)) * res - ox) * invDx : Infinity;
    let tMaxY = Math.abs(dy) > EPS ? (gMinY + (iy + (dy > 0 ? 1 : 0)) * res - oy) * invDy : Infinity;
    let tMaxZ = Math.abs(dz) > EPS ? (gMinZ + (iz + (dz > 0 ? 1 : 0)) * res - oz) * invDz : Infinity;
    const tDeltaX = Math.abs(dx) > EPS ? res * Math.abs(invDx) : Infinity;
    const tDeltaY = Math.abs(dy) > EPS ? res * Math.abs(invDy) : Infinity;
    const tDeltaZ = Math.abs(dz) > EPS ? res * Math.abs(invDz) : Infinity;
    let currentT = tNear;
    const maxSteps = this._numVoxelsX + this._numVoxelsY + this._numVoxelsZ;
    for (let step = 0; step < maxSteps; step++) {
      if (this.isVoxelSolid(ix, iy, iz)) {
        return { x: ox + dx * currentT, y: oy + dy * currentT, z: oz + dz * currentT };
      }
      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) { currentT = tMaxX; ix += stepX; tMaxX += tDeltaX; }
        else { currentT = tMaxZ; iz += stepZ; tMaxZ += tDeltaZ; }
      } else if (tMaxY < tMaxZ) { currentT = tMaxY; iy += stepY; tMaxY += tDeltaY; }
      else { currentT = tMaxZ; iz += stepZ; tMaxZ += tDeltaZ; }
      if (ix < 0 || iy < 0 || iz < 0 ||
          ix >= this._numVoxelsX || iy >= this._numVoxelsY || iz >= this._numVoxelsZ ||
          currentT > maxDist) {
        return null;
      }
    }
    return null;
  }

  /**
   * Vertical-capsule push-out (segment cy±halfHeight swept by radius), corner-aware via
   * resolveIterative. Writes the total push into `out` and returns true only when significant.
   */
  queryCapsule(cx, cy, cz, halfHeight, radius, out) {
    if (this._nodes.length === 0) return false;
    return resolveIterative(
      cx, cy, cz,
      (rx, ry, rz, push) => this._deepestCapsulePenetration(rx, ry, rz, halfHeight, radius, push),
      this._constraintNormals, this._push, out,
    );
  }

  _deepestCapsulePenetration(cx, cy, cz, halfHeight, radius, out) {
    const res = this._voxelResolution;
    const gMinX = this._gridMinX, gMinY = this._gridMinY, gMinZ = this._gridMinZ;
    const radiusSq = radius * radius;
    const segBottomY = cy - halfHeight;
    const segTopY = cy + halfHeight;
    const ixMin = Math.floor((cx - radius - gMinX) / res);
    const iyMin = Math.floor((segBottomY - radius - gMinY) / res);
    const izMin = Math.floor((cz - radius - gMinZ) / res);
    const ixMax = Math.floor((cx + radius - gMinX) / res);
    const iyMax = Math.floor((segTopY + radius - gMinY) / res);
    const izMax = Math.floor((cz + radius - gMinZ) / res);
    let bestPushX = 0, bestPushY = 0, bestPushZ = 0;
    let bestPenetration = PENETRATION_EPSILON;
    let found = false;
    for (let iz = izMin; iz <= izMax; iz++) {
      for (let iy = iyMin; iy <= iyMax; iy++) {
        for (let ix = ixMin; ix <= ixMax; ix++) {
          if (!this.isVoxelSolid(ix, iy, iz)) continue;
          const vMinX = gMinX + ix * res, vMinY = gMinY + iy * res, vMinZ = gMinZ + iz * res;
          const vMaxX = vMinX + res, vMaxY = vMinY + res, vMaxZ = vMinZ + res;
          // closest Y on the vertical segment to this voxel AABB
          let segY;
          if (segTopY < vMinY) segY = segTopY;
          else if (segBottomY > vMaxY) segY = segBottomY;
          else segY = Math.max(segBottomY, Math.min(segTopY, (vMinY + vMaxY) * 0.5));
          // sphere-AABB penetration from (cx, segY, cz)
          const nearX = Math.max(vMinX, Math.min(cx, vMaxX));
          const nearY = Math.max(vMinY, Math.min(segY, vMaxY));
          const nearZ = Math.max(vMinZ, Math.min(cz, vMaxZ));
          const dx = cx - nearX, dy = segY - nearY, dz = cz - nearZ;
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq >= radiusSq) continue;
          let px, py, pz, penetration;
          if (distSq > 1e-12) {
            const dist = Math.sqrt(distSq);
            penetration = radius - dist;
            const invDist = 1.0 / dist;
            px = dx * invDist * penetration;
            py = dy * invDist * penetration;
            pz = dz * invDist * penetration;
          } else {
            // segment point inside the voxel: escape via nearest face + radius
            const distNegX = cx - vMinX, distPosX = vMaxX - cx;
            const distNegY = segY - vMinY, distPosY = vMaxY - segY;
            const distNegZ = cz - vMinZ, distPosZ = vMaxZ - cz;
            const escapeX = distNegX < distPosX ? -(distNegX + radius) : distPosX + radius;
            const escapeY = distNegY < distPosY ? -(distNegY + radius) : distPosY + radius;
            const escapeZ = distNegZ < distPosZ ? -(distNegZ + radius) : distPosZ + radius;
            const absX = Math.abs(escapeX), absY = Math.abs(escapeY), absZ = Math.abs(escapeZ);
            px = 0; py = 0; pz = 0;
            if (absX <= absY && absX <= absZ) { px = escapeX; penetration = absX; }
            else if (absY <= absZ) { py = escapeY; penetration = absY; }
            else { pz = escapeZ; penetration = absZ; }
          }
          if (penetration > bestPenetration) {
            bestPenetration = penetration;
            bestPushX = px; bestPushY = py; bestPushZ = pz;
            found = true;
          }
        }
      }
    }
    if (found) { out.x = bestPushX; out.y = bestPushY; out.z = bestPushZ; }
    return found;
  }
}

/** Ray budget when probing for ground/ceiling under or above a candidate column. */
const RAY_MAX_DIST = 1000;

/**
 * Find the closest standable cylinder placement to (ox, oy, oz); writes the FLOOR point the
 * cylinder rests on into `out`, returns true on success. Chebyshev-shell lattice search
 * (step = voxelResolution) over free voxels, then an XZ footprint ray fan: every footprint
 * column must have ground below (floor = highest down-hit) and the cylinder must fit under
 * the lowest up-hit. Cylinder math (flat ends) matches the carve's separable dilation.
 *
 * Port fixes vs upstream: shell count capped (opts.maxCells, default 30 ≈ 3 m at res 0.1) —
 * the upstream uncapped failed search is a multi-second main-thread freeze; probe only on
 * walk entry, never per frame. And opts.floorBand=[minY,maxY] rejects candidates whose floor
 * lands outside the band — real interiors voxelize furniture/fuzz into raised standable
 * surfaces (measured 0.4-0.9 m over the metric floor at the living spawn), and the scene
 * convention (spawn eye = floor + 1.55) tells us where the true floor is; without the band
 * the "nearest standable spot" is the top of the sofa.
 */
export function findCylinderSpawn(collision, ox, oy, oz, halfHeight, radius, out, opts = {}) {
  const step = collision.voxelResolution;
  const searchRadius = opts.searchRadius ?? 5;
  const maxCells = Math.min(Math.ceil(searchRadius / step), opts.maxCells ?? 30);
  const searchRadiusSq = searchRadius * searchRadius;
  const floorBand = opts.floorBand ?? null;
  const footCells = Math.ceil(radius / step);
  const radiusSq = radius * radius;
  let bestDistSq = Infinity;
  let found = false;
  for (let r = 0; r <= maxCells; r++) {
    const shellMinDistSq = r * step * (r * step);
    if (shellMinDistSq >= bestDistSq) break;
    for (let dy = -r; dy <= r; dy++) {
      const absDy = dy < 0 ? -dy : dy;
      for (let dz = -r; dz <= r; dz++) {
        const absDz = dz < 0 ? -dz : dz;
        for (let dx = -r; dx <= r; dx++) {
          const absDx = dx < 0 ? -dx : dx;
          if (absDx < r && absDy < r && absDz < r) continue;   // shell cells only
          const distSq = (dx * dx + dy * dy + dz * dz) * step * step;
          if (distSq >= bestDistSq || distSq > searchRadiusSq) continue;
          const cx = ox + dx * step;
          const cy = oy + dy * step;
          const cz = oz + dz * step;
          if (!collision.isFreeAt(cx, cy, cz)) continue;
          // footprint ray fan: floor = max down-hit, ceiling = min up-hit; every column
          // must be supported or the cylinder would hang over a hole
          let floor = -Infinity;
          let ceiling = Infinity;
          let supported = true;
          for (let i = -footCells; i <= footCells && supported; i++) {
            const fxOff = i * step;
            const fxOffSq = fxOff * fxOff;
            for (let j = -footCells; j <= footCells; j++) {
              const fzOff = j * step;
              if (fxOffSq + fzOff * fzOff > radiusSq) continue;
              const fx = cx + fxOff;
              const fz = cz + fzOff;
              const down = collision.queryRay(fx, cy, fz, 0, -1, 0, RAY_MAX_DIST);
              if (!down) { supported = false; break; }
              if (down.y > floor) floor = down.y;
              const up = collision.queryRay(fx, cy, fz, 0, 1, 0, RAY_MAX_DIST);
              if (up && up.y < ceiling) ceiling = up.y;
            }
          }
          if (!supported) continue;
          if (floor + 2 * halfHeight > ceiling) continue;
          if (floorBand && (floor < floorBand[0] || floor > floorBand[1])) continue;
          bestDistSq = distSq;
          out.x = cx;
          out.y = floor;
          out.z = cz;
          found = true;
        }
      }
    }
  }
  return found;
}

/**
 * Load <name>.voxel.json (+ inferred .voxel.bin sibling). Accepts ONLY version "1.1":
 * v1.0 files in the wild are flip-hacked export-viewer twins whose payload is canonical —
 * a version-faithful flip would be wrong, so refuse rather than guess. Returns
 * {collision, meta} or null (missing sidecar is a normal no-walk scene, warn-and-null).
 */
export async function loadCollisionSidecar(jsonUrl) {
  // The WHOLE body is guarded (F-35): only the json fetch used to be, so a truncated .bin
  // (RangeError in the Uint32Array view) or a malformed gridBounds (TypeError in the
  // VoxelCollision ctor) REJECTED — and this loader is one arm of main.js's Promise.all, so a
  // bad walk-mode file took lighting.json and the whole staging document down with it.
  // Contract: this function never throws. Absent/broken sidecar => null => walk unavailable.
  try {
    let meta;
    const r = await fetch(jsonUrl);
    if (!r.ok) return null;                    // no sidecar = walk unavailable, not an error
    meta = await r.json();
    if (meta?.version !== '1.1') {
      console.warn(`[collision] ${jsonUrl}: version ${meta?.version} unsupported (need 1.1) — walk disabled`);
      return null;
    }
    const binUrl = jsonUrl.replace('.voxel.json', '.voxel.bin');
    const rb = await fetch(binUrl);
    if (!rb.ok) {
      console.warn(`[collision] missing bin sibling ${binUrl} — walk disabled`);
      return null;
    }
    const buf = await rb.arrayBuffer();
    if (buf.byteLength % 4 !== 0) {
      console.warn(`[collision] ${binUrl}: ${buf.byteLength} bytes is not a whole number of u32 words — walk disabled`);
      return null;
    }
    const u32 = new Uint32Array(buf);
    if (u32.length !== meta.nodeCount + meta.leafDataCount) {
      console.warn(`[collision] ${binUrl}: ${u32.length} words != nodeCount+leafDataCount — walk disabled`);
      return null;
    }
    return { collision: new VoxelCollision(meta, u32), meta };
  } catch (err) {
    console.warn(`[collision] ${jsonUrl}: unreadable sidecar — walk disabled`, err);
    return null;
  }
}
