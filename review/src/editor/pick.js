// Picking — the two probe-validated paths (research/2026-08-28-picker-derisk-probes.md):
// floorPick = analytic camera ray ∩ y=0 (P1: exact at working range; amp quantifies
// the glancing-angle error multiplier for the spawn warning);
// selectPick = GPU pc.Picker at quarter resolution (P3: the unified splat never
// enters the pick buffer, so no filtering is needed — a hit either parent-walks to
// a document placement or it's background).
import { Picker, LAYERID_WORLD } from 'playcanvas';

export function floorPick(cameraEntity, x, y) {
  const c = cameraEntity.camera;
  const near = c.screenToWorld(x, y, c.nearClip);
  const far = c.screenToWorld(x, y, c.farClip);
  const dir = far.sub(near).normalize();
  if (dir.y >= -1e-6) return null;                    // ray must descend
  const amp = Math.hypot(dir.x, dir.z) / Math.abs(dir.y);
  const t = -near.y / dir.y;
  const p = near.add(dir.mulScalar(t));
  return { point: [p.x, 0, p.z], amp, dist: t };
}

export function createSelectPicker(app, cameraEntity, doc) {
  const SCALE = 4;
  let picker = null, pw = 0, ph = 0;
  return {
    pick(x, y) {
      const d = app.graphicsDevice;
      const w = Math.max(1, Math.floor(d.width / SCALE));
      const h = Math.max(1, Math.floor(d.height / SCALE));
      if (!picker || w !== pw || h !== ph) { picker = new Picker(app, w, h); pw = w; ph = h; }
      const worldLayer = app.scene.layers.getLayerById(LAYERID_WORLD);
      picker.prepare(cameraEntity.camera, app.scene, [worldLayer]);
      // css px -> device px -> picker px
      const sx = Math.floor((x * (d.width / d.canvas.clientWidth)) / SCALE);
      const sy = Math.floor((y * (d.height / d.canvas.clientHeight)) / SCALE);
      const sel = picker.getSelection(sx, sy, 2, 2);
      for (const mi of sel) {
        let n = mi?.node;
        while (n && n.parent && n.parent !== app.root) n = n.parent;
        const id = n ? doc.idFor(n) : null;
        if (id) return id;
      }
      return null;
    },
  };
}
