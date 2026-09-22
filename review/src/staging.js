// Staged-object helpers — GLB auto-normalize (l1 idiom, ported via the spike rig) and the
// ghost wireframe proof (evidence tool: draws the object through occluders to prove the
// splat is really hiding it, not that the object is missing).
import {
  Entity, StandardMaterial, Color, BoundingBox, Vec3, Mat4, LAYERID_IMMEDIATE,
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

// EXACT world-space bounds from the transformed vertices. `meshInstance.aabb` is the
// mesh's LOCAL box re-fitted through the node's world matrix — for a mesh whose canonical
// pose is a node ROTATION (the Pixal3D canonicaliser writes a wrapper-node quaternion so
// the PBR maps survive) that box is bloated by up to ~30 % per axis, which under-scaled
// every Pixal3D sofa vs the Tripo one (rotation-free) in the 2026-09-05 A/B and floated
// its base above y=0. Falls back to `mi.aabb` only when the vertex data is unreadable.
const _v = new Vec3();
const _min = new Vec3();
const _max = new Vec3();
// World matrix as the product of the LOCAL transforms up to (not including) the scene root —
// independent of the engine's lazy world-matrix sync. The editor's photo tool once measured a
// freshly cloned placement at the right SIZE in the wrong PLACE (2026-09-05: a clone read before
// its first sync, in a hidden tab with no update tick). Local transforms are what
// setPosition/setEulerAngles/setLocalScale write, so this chain is always current.
const _wm = new Mat4();
function worldFromLocals(node) {
  const chain = [];
  for (let n = node; n && n.parent; n = n.parent) chain.push(n);
  const m = new Mat4();
  for (let i = chain.length - 1; i >= 0; i--) { _wm.copy(m); m.mul2(_wm, chain[i].getLocalTransform()); }
  return m;
}
export function entityAabb(e, { fromLocals = false } = {}) {
  const aabb = new BoundingBox();
  let first = true;
  let exact = 0, approx = 0;
  for (const r of e.findComponents('render')) {
    for (const mi of r.meshInstances) {
      const pos = [];
      const n = (mi.mesh && mi.mesh.getPositions) ? mi.mesh.getPositions(pos) : 0;
      if (n > 0) {
        const wt = fromLocals ? worldFromLocals(mi.node) : mi.node.getWorldTransform();
        _min.set(Infinity, Infinity, Infinity); _max.set(-Infinity, -Infinity, -Infinity);
        for (let i = 0; i < n; i++) {
          _v.set(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
          wt.transformPoint(_v, _v);
          if (_v.x < _min.x) _min.x = _v.x; if (_v.x > _max.x) _max.x = _v.x;
          if (_v.y < _min.y) _min.y = _v.y; if (_v.y > _max.y) _max.y = _v.y;
          if (_v.z < _min.z) _min.z = _v.z; if (_v.z > _max.z) _max.z = _v.z;
        }
        const box = new BoundingBox();
        box.setMinMax(_min, _max);
        if (first) { aabb.copy(box); first = false; } else aabb.add(box);
        exact++;
      } else {
        if (first) { aabb.copy(mi.aabb); first = false; } else aabb.add(mi.aabb);
        approx++;
      }
    }
  }
  if (approx) console.warn(`[viewer] entityAabb: ${approx} mesh(es) without readable positions, ${exact} exact`);
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
  // #18: orange = the occupancy check flagged the selection; #5 collide (2026-09-14): red = a drop here would be REFUSED
  const TINTS = { ok: new Color(1, 1, 0), warn: new Color(1, 0.45, 0.1), bad: new Color(1, 0.15, 0.15) };
  let tint = 'ok';
  let ghost = null, target = null;
  return {
    setTint(name) {
      const next = TINTS[name] ? name : 'ok';
      if (next === tint) return;
      tint = next;
      ghostMat.emissive = TINTS[tint];
      ghostMat.update();
    },
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
