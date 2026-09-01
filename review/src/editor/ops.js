// Editor ops over the staging document. A placement transform is {pos:[x,0,z],
// yaw, scale} — y is pinned to the floor by construction (the v1 scoping decision).
// TransformOp holds a REFERENCE to newT that the drag/key gesture mutates in place
// (the SuperSplat idiom: one op per gesture, no per-frame allocation).
export const cloneT = t => ({ pos: [t.pos[0], 0, t.pos[2]], yaw: t.yaw, scale: t.scale });
export const sameT = (a, b) =>
  a.pos[0] === b.pos[0] && a.pos[2] === b.pos[2] && a.yaw === b.yaw && a.scale === b.scale;
export const placementT = p => cloneT(p);

export function applyT(doc, id, t) {
  const p = doc.get(id);
  if (!p) return;
  p.pos = [t.pos[0], 0, t.pos[2]];
  p.yaw = t.yaw;
  p.scale = t.scale;
  doc.applyPlacement(p);
}

export function transformOp(doc, id, oldT, newT) {
  return {
    name: 'transform', id, oldT, newT,
    do() { applyT(doc, id, this.newT); },
    undo() { applyT(doc, id, this.oldT); },
  };
}

// Spawn flow constructs the entity first (template load is async), then pushes;
// doc.restore is idempotent so the immediate do() is a no-op.
export function addOp(doc, placement, entity) {
  return {
    name: 'add', id: placement.id,
    do() { doc.restore(placement, entity); },
    undo() { doc.remove(placement.id); },
  };
}

// Keeps the detached entity alive for undo (bounded leak, accepted for v1 — the
// entity is only destroyed if the browser tab is).
export function removeOp(doc, id) {
  let saved = null;
  return {
    name: 'remove', id,
    do() { const r = doc.remove(id); if (r) saved = r; },
    undo() { if (saved) doc.restore(saved.placement, saved.entity); },
  };
}

export function shadowOp(catcher, oldStrength, newStrength) {
  return {
    name: 'shadow',
    do() { catcher.set({ strength: newStrength }); },
    undo() { catcher.set({ strength: oldStrength }); },
  };
}
