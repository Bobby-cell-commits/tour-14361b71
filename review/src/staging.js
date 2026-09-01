// Staged-object helpers — GLB auto-normalize (l1 idiom, ported via the spike rig) and the
// ghost wireframe proof (evidence tool: draws the object through occluders to prove the
// splat is really hiding it, not that the object is missing).
import {
  Entity, StandardMaterial, Color, BoundingBox, Vec3, LAYERID_IMMEDIATE,
  RENDERSTYLE_WIREFRAME,
} from 'playcanvas';

export function buildBox() {
  const e = new Entity('box');
  const mat = new StandardMaterial();
  mat.diffuse = new Color(0.17, 0.88, 0.43);
  mat.gloss = 0.4;
  mat.update();
  e.addComponent('render', { type: 'box', material: mat });
  e.setLocalScale(0.6, 0.6, 0.6);
  e.setLocalPosition(0, 0.3, 0);   // base on floor
  const wrap = new Entity('box-wrap');
  wrap.addChild(e);
  return wrap;
}

export function entityAabb(e) {
  const aabb = new BoundingBox();
  let first = true;
  for (const r of e.findComponents('render')) {
    for (const mi of r.meshInstances) {
      if (first) { aabb.copy(mi.aabb); first = false; } else aabb.add(mi.aabb);
    }
  }
  return first ? null : aabb;
}

// measure raw at identity, then wrap: base-center re-pivot + uniform scale to targetH
export function normalizeGlb(app, containerAsset, targetH, url = '') {
  const inner = containerAsset.resource.instantiateRenderEntity();
  app.root.addChild(inner);
  inner.syncHierarchy();
  const box = entityAabb(inner);
  app.root.removeChild(inner);
  const size = box ? new Vec3(box.halfExtents.x * 2, box.halfExtents.y * 2, box.halfExtents.z * 2) : new Vec3(1, 1, 1);
  const min = box ? new Vec3().sub2(box.center, box.halfExtents) : new Vec3();
  const s = targetH / size.y;
  inner.setLocalPosition(-box.center.x, -min.y, -box.center.z);
  const scaler = new Entity('scaler');
  scaler.addChild(inner);
  scaler.setLocalScale(s, s, s);
  const wrap = new Entity('asset-wrap');
  wrap.addChild(scaler);
  const meta = {
    url, rawDims: [size.x, size.y, size.z].map(v => +v.toFixed(3)),
    normScale: +s.toFixed(4), targetH,
  };
  console.log('[viewer] asset normalized', JSON.stringify(meta));
  return { entity: wrap, meta };
}

export function createGhost(app) {
  const ghostMat = new StandardMaterial();
  ghostMat.emissive = new Color(1, 1, 0);
  ghostMat.diffuse = new Color(0, 0, 0);
  ghostMat.useLighting = false;
  ghostMat.depthTest = false;
  ghostMat.depthWrite = false;
  ghostMat.update();
  let ghost = null, target = null;
  return {
    set(obj, on) {
      if (ghost) { app.root.removeChild(ghost); ghost = null; }
      target = on ? obj : null;
      if (!target) return;
      ghost = target.clone();
      ghost.enabled = true;
      app.root.addChild(ghost);
      for (const r of ghost.findComponents('render')) {
        r.layers = [LAYERID_IMMEDIATE];
        r.material = ghostMat;
        r.renderStyle = RENDERSTYLE_WIREFRAME;
      }
    },
    sync() {
      if (!ghost || !target) return;
      ghost.setPosition(target.getPosition());
      ghost.setEulerAngles(target.getEulerAngles());
      ghost.setLocalScale(target.getLocalScale());
    },
    get on() { return !!ghost; },
  };
}
