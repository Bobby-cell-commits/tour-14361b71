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
import { normalizeGlb } from './staging.js';

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

export function createStagingDoc(app, catcher, { requestRender = () => {}, base = 'assets' } = {}) {
  const placements = [];          // [{id, asset, pos:[x,0,z], yaw, scale}] — runtime id, not serialized
  const entities = new Map();     // id -> wrap entity
  const owners = new Map();       // wrap entity -> id (picker parent-walk lookup)
  const templates = new Map();    // catalog asset id -> Promise<{entity, meta} | null>
  let catalog = null;
  let nextId = 1;

  const resolveUrl = rel => /^(https?:)?\//.test(rel) ? rel : `${base}/${rel}`;

  function ensureTemplate(assetId) {
    if (templates.has(assetId)) return templates.get(assetId);
    const entry = catalog?.assets?.find(a => a.id === assetId);
    const p = !entry
      ? Promise.resolve(null)
      : new Promise(resolve => {
        const asset = new Asset(`catalog-${assetId}`, 'container', { url: resolveUrl(entry.glb) });
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
    requestRender();
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
    applyPlacement(placement);
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
    syncCasters();
    requestRender();
    return { placement, entity };
  }

  async function add({ asset, pos = [0, 0, 0], yaw = 0, scale = 1 }) {
    const tpl = await ensureTemplate(asset);
    if (!tpl) { console.warn('[staging] unknown/failed asset — skipped', asset); return null; }
    const placement = { id: `p${nextId++}`, asset, pos: [pos[0], 0, pos[2]], yaw, scale };
    const entity = tpl.entity.clone();
    entity.enabled = true;
    restore(placement, entity);
    return placement;
  }

  async function loadFrom(stagingJson, catalogJson) {
    if (catalogJson) catalog = catalogJson;
    if (!stagingJson?.placements) return;
    for (const raw of stagingJson.placements) {
      if (!raw?.asset || !Array.isArray(raw.pos)) { console.warn('[staging] malformed placement skipped', raw); continue; }
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

  function serialize(scene, shadowStrength) {
    return {
      scene, version: 1, saved_at: new Date().toISOString(),
      placements: snapshot().map(({ id, ...rest }) => rest),
      ...(shadowStrength != null ? { shadow: { strength: round(shadowStrength) } } : {}),
    };
  }

  return {
    placements, applyPlacement, add, remove, restore, loadFrom, snapshot, serialize,
    ensureTemplate, syncCasters, resolveUrl,
    entityFor: id => entities.get(id),
    idFor: entity => owners.get(entity),
    get: id => placements.find(p => p.id === id),
    get catalog() { return catalog; },
    set catalog(c) { catalog = c; },
  };
}
