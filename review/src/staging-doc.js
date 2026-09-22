// Staging document — the multi-object placement layer (issue #5).
//
// The placements array is the SOURCE OF TRUTH; engine entities are a disposable
// projection. Every entity write goes through applyPlacement() so editor ops keep
// do/undo symmetric and a re-sync is always possible. This module is PURE in the
// lighting.js sense: loaders fetch + return (absence = null, never an error), the
// doc mutates only its own entities and the catcher's caster LIST — never shared
// config, never the gsplatModifyPS chunk (catcher-owned).
//
// The legacy single ?asset= object stays OUTSIDE the document (review-link override,
// evidence workflows read getState().object); the catcher's two caster slots keep
// the two paths from clobbering each other.
import { Asset } from 'playcanvas';
import { normalizeGlb, entityAabb } from './staging.js';

export async function loadStaging(base, scene) {
  for (const name of [`${scene}.staging.json`, `urban-grove-${scene}.staging.json`]) {
    try {
      const r = await fetch(`${base}/${name}`);
      if (r.ok) { const j = await r.json(); j._file = name; return j; }
    } catch {}
  }
  return null;
}

export async function loadCatalog(base) {
  try {
    const r = await fetch(`${base}/catalog.json`);
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

export function createStagingDoc(app, catcher, { requestRender = () => {}, base = 'assets',
                                                 allowUrl = () => true } = {}) {
  const placements = [];          // [{id, asset, pos:[x,0,z], yaw, scale}] — runtime id, not serialized
  const entities = new Map();     // id -> wrap entity
  const owners = new Map();       // wrap entity -> id (picker parent-walk lookup)
  const templates = new Map();    // catalog asset id -> Promise<{entity, meta} | null>
  let catalog = null;
  let nextId = 1;
  let revision = 0;               // bumped on every placement write — boxes() memo + the walk's obstacle set key on it
  const boxCache = new Map();     // placement id -> { key, min, max } — keyed on the document transform
  let boxesCached = { revision: -1, list: [] };

  // catalog entries are operator-supplied data: an absolute glb/thumb url used to pass
  // straight through, so a crafted catalog.json could pull cross-origin content onto the
  // page. Same allowlist as the base itself (F-29); a refused url resolves to null.
  const resolveUrl = (rel) => {
    if (rel == null) return null;
    const url = /^(https?:)?\//.test(rel) ? rel : `${base}/${rel}`;
    if (allowUrl(url)) return url;
    console.warn('[staging] refused cross-origin catalog url', url);
    return null;
  };

  // placement numerics are data too — a string or a NaN here becomes a NaN entity transform
  const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);

  function ensureTemplate(assetId) {
    if (templates.has(assetId)) return templates.get(assetId);
    const entry = catalog?.assets?.find(a => a.id === assetId);
    const p = !entry
      ? Promise.resolve(null)
      : new Promise(resolve => {
        const glbUrl = resolveUrl(entry.glb);
        if (!glbUrl) { console.warn('[staging] catalog asset has no loadable glb url', assetId); resolve(null); return; }
        const asset = new Asset(`catalog-${assetId}`, 'container', { url: glbUrl });
        asset.once('load', () => resolve(normalizeGlb(app, asset, entry.targetH ?? 0.8, entry.glb)));
        asset.once('error', err => { console.warn('[staging] asset load failed', assetId, err); resolve(null); });
        app.assets.add(asset);
        app.assets.load(asset);
      });
    templates.set(assetId, p);
    return p;
  }

  function applyPlacement(p) {
    const e = entities.get(p.id);
    if (!e) return;
    e.setPosition(p.pos[0], 0, p.pos[2]);
    e.setEulerAngles(0, p.yaw, 0);
    e.setLocalScale(p.scale, p.scale, p.scale);
    revision++;
    requestRender();
  }

  // Exact world boxes of every placement (entityAabb fromLocals — sync-independent, so a just-spawned or
  // just-moved wrap measures right without an update tick), memoised on the document transform: the SAME
  // array comes back while nothing changed (the walk asks per sub-step). Hoisted here from editor/pick.js
  // (2026-09-14) because the VIEW page needs them too — placed pieces are runtime walk obstacles (#16 rider,
  // walk-obstacles.js). A `lift` (verifier perturbation) moves the entity without the document: the box
  // keeps y = 0, which is what the walk and the pick gate want.
  function boxes() {
    if (boxesCached.revision === revision) return boxesCached.list;
    const out = [];
    const live = new Set();
    for (const p of placements) {
      live.add(p.id);
      const key = `${p.pos[0]},${p.pos[2]},${p.yaw},${p.scale}`;
      let c = boxCache.get(p.id);
      if (!c || c.key !== key) {
        const e = entities.get(p.id);
        const aabb = e ? entityAabb(e, { fromLocals: true }) : null;
        if (!aabb) continue;
        const mn = aabb.getMin(), mx = aabb.getMax();
        c = { key, min: [mn.x, mn.y, mn.z], max: [mx.x, mx.y, mx.z] };
        boxCache.set(p.id, c);
      }
      out.push({ id: p.id, min: c.min, max: c.max });
    }
    for (const id of [...boxCache.keys()]) if (!live.has(id)) boxCache.delete(id);
    boxesCached = { revision, list: out };
    return out;
  }

  function syncCasters() {
    catcher.setCasters([...entities.values()]);
  }

  // Attach an existing (placement, entity) pair — idempotent so an editor AddOp's
  // immediate do() after a live spawn is a no-op (the SuperSplat re-apply idiom).
  function restore(placement, entity) {
    if (entities.has(placement.id)) return;
    placements.push(placement);
    entities.set(placement.id, entity);
    owners.set(entity, placement.id);
    app.root.addChild(entity);
    applyPlacement(placement);   // bumps revision
    syncCasters();
  }

  // Detach; returns the pair so a RemoveOp can undo (entity kept alive by the op).
  function remove(id) {
    const i = placements.findIndex(p => p.id === id);
    if (i < 0) return null;
    const [placement] = placements.splice(i, 1);
    const entity = entities.get(id);
    entities.delete(id);
    owners.delete(entity);
    if (entity) app.root.removeChild(entity);
    revision++;
    syncCasters();
    requestRender();
    return { placement, entity };
  }

  async function add({ asset, pos = [0, 0, 0], yaw = 0, scale = 1 }) {
    const tpl = await ensureTemplate(asset);
    if (!tpl) { console.warn('[staging] unknown/failed asset — skipped', asset); return null; }
    const placement = {
      id: `p${nextId++}`, asset,
      pos: [num(pos[0], 0), 0, num(pos[2], 0)],
      yaw: num(yaw, 0), scale: num(scale, 1),
    };
    const entity = tpl.entity.clone();
    entity.enabled = true;
    restore(placement, entity);
    return placement;
  }

  async function loadFrom(stagingJson, catalogJson) {
    if (catalogJson) catalog = catalogJson;
    if (!stagingJson?.placements) return;
    for (const raw of stagingJson.placements) {
      if (!raw?.asset || typeof raw.asset !== 'string' || !Array.isArray(raw.pos) || raw.pos.length < 3
          || !Number.isFinite(Number(raw.pos[0])) || !Number.isFinite(Number(raw.pos[2]))) {
        console.warn('[staging] malformed placement skipped', raw); continue;
      }
      await add(raw);
    }
  }

  const round = (v, k = 1000) => Math.round(v * k) / k;
  function snapshot() {
    return placements.map(p => ({
      id: p.id, asset: p.asset, pos: [round(p.pos[0]), 0, round(p.pos[2])],
      yaw: round(p.yaw, 10), scale: round(p.scale),
    }));
  }

  // serialize: v1 + an ADDITIVE per-placement `aabb` (exact world box, 3 dp, 2026-09-14) so the pipeline's
  // navmesh report can say "a saved piece covers walked cells / the spawn" without the engine
  // (scripts/navmesh_region.placement_metrics). Loaders ignore it (loadFrom reads asset/pos/yaw/scale).
  function serialize(scene, shadowStrength) {
    const bx = new Map(boxes().map(b => [b.id, b]));
    return {
      scene, version: 1, saved_at: new Date().toISOString(),
      placements: snapshot().map(({ id, ...rest }) => {
        const b = bx.get(id);
        return b ? { ...rest, aabb: { min: b.min.map(v => round(v)), max: b.max.map(v => round(v)) } } : rest;
      }),
      ...(shadowStrength != null ? { shadow: { strength: round(shadowStrength) } } : {}),
    };
  }

  return {
    placements, applyPlacement, add, remove, restore, loadFrom, snapshot, serialize, boxes,
    get revision() { return revision; },
    ensureTemplate, syncCasters, resolveUrl,
    entityFor: id => entities.get(id),
    idFor: entity => owners.get(entity),
    get: id => placements.find(p => p.id === id),
    get catalog() { return catalog; },
    set catalog(c) { catalog = c; },
  };
}
