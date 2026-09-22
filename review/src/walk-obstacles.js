// walk-obstacles.js — placed pieces as RUNTIME walk obstacles (issue #16 rider, 2026-09-14;
// research/2026-09-14-placement-obstacles-runtime-vs-bake.md). ZERO imports by design: node-runnable
// (tests/test_walk_obstacles_js.py), same discipline as collision.js / editor/occupancy.js.
//
// Why runtime and not the bake: a placed piece stands ON the walked corridor (that is what staging a tour
// is), so baking it cuts the navmesh in two (living: 57 walked cells, containment 0.85), the pipeline's
// navmesh stage runs before staging is authored, and a re-bake is 1.1 s against 0.05 µs for this test.
// The walk consults the placements' exact world XZ AABBs per sub-step: the walker is a disc of radius r
// (BODY_RADIUS_M in navwalk.js = the bake's agent_radius_m — the body has ONE radius, against baked
// obstacles and against placed pieces alike), the box is expanded by r, and a sub-step is blocked only when
// its SEGMENT (from → the point Detour's slide returned) crosses a box the from-point is OUTSIDE of:
//   - segment, not endpoint: a 0.3 m frame move cannot tunnel through a thin expanded edge;
//   - per-box leave-only: a walker already inside a box (a covered spawn, a piece dropped on it while
//     walking) may move freely with respect to THAT box — it walks out, it never strands — while every
//     other box still blocks;
//   - an epsilon on the boundary: a walker resting at distance r after a block reads OUTSIDE, so a
//     tangential move along the face is not "entering".
// A blocked full move falls back to the axis-split targets (x-only, z-only); the longer clear one wins
// (no x-then-z bias), so the walker slides along the piece's face; a corner jam stays put.

export const EPS_M = 1e-4;          // boundary epsilon (m): at exactly distance r the walker is outside

/** the closed expanded box's XZ extent, shrunk by eps (the "strict interior") */
function extent(box, r, eps) {
  return [box.min[0] - r + eps, box.max[0] + r - eps, box.min[2] - r + eps, box.max[2] + r - eps];
}

/** is the XZ point strictly inside the box expanded by r (eps-shrunk)? */
export function insideExpanded(p, box, r, eps = EPS_M) {
  const [x0, x1, z0, z1] = extent(box, r, eps);
  return p.x > x0 && p.x < x1 && p.z > z0 && p.z < z1;
}

/** does the XZ segment a → b enter the (eps-shrunk) box expanded by r? Liang–Barsky slab clipping. */
export function segmentEntersExpanded(a, b, box, r, eps = EPS_M) {
  const [x0, x1, z0, z1] = extent(box, r, eps);
  if (x1 <= x0 || z1 <= z0) return false;              // a degenerate (thinner than 2·eps) box never blocks
  const dx = b.x - a.x, dz = b.z - a.z;
  let t0 = 0, t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q > 0;                          // parallel: inside the slab only if strictly inside
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, a.x - x0) && clip(dx, x1 - a.x) && clip(-dz, a.z - z0) && clip(dz, z1 - a.z) && t0 < t1;
}

/** the id of the first box the move from → to ENTERS (boxes `from` is already inside are skipped), else null */
export function blockedBy(from, to, boxes, r, eps = EPS_M) {
  for (const b of boxes) {
    if (insideExpanded(from, b, r, eps)) continue;      // leave-only, per box
    if (segmentEntersExpanded(from, to, b, r, eps)) return b.id;
  }
  return null;
}

/** ids of every box the XZ point is inside (expanded by r) — the entry-ladder / status question */
export function insideOf(p, boxes, r, eps = EPS_M) {
  return boxes.filter(b => insideExpanded(p, b, r, eps)).map(b => b.id);
}

/**
 * One sub-step against the obstacle set.
 *   slide(target) → {x, y, z, ...} | null  — the caller's Detour moveAlongSurface wrapper (stateless: it
 *                                            takes the current ref/pos and returns the slid point; nothing
 *                                            is committed until a candidate is accepted)
 *   pos            {x, y, z}                — the current on-mesh point
 *   dx, dz                                  — the requested XZ move
 * Returns {result, candidate, blocked_by}: `result` is the accepted slid point (null = stay), `candidate`
 * 'full' | 'x' | 'z' | null, `blocked_by` the first box the FULL move (or every candidate) ran into.
 */
export function resolveMove(slide, pos, dx, dz, boxes, r, eps = EPS_M) {
  const cands = [['full', dx, dz], ['x', dx, 0], ['z', 0, dz]];
  let blocked = null, best = null;
  for (const [name, cx, cz] of cands) {
    if (Math.hypot(cx, cz) < 1e-6) continue;
    const res = slide({ x: pos.x + cx, y: pos.y, z: pos.z + cz });
    if (!res) continue;
    const hit = boxes.length ? blockedBy(pos, res, boxes, r, eps) : null;
    if (hit) { blocked = blocked ?? hit; continue; }
    const moved = Math.hypot(res.x - pos.x, res.z - pos.z);
    if (name === 'full') { best = { name, res, moved }; break; }   // clear full move: no split needed
    if (moved < 1e-6) continue;                                      // a split the mesh itself refused
    if (!best || moved > best.moved) best = { name, res, moved };
  }
  return { result: best?.res ?? null, candidate: best?.name ?? null, blocked_by: blocked };
}
