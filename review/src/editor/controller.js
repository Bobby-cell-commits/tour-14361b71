// Editor state machine + input. States: idle / selected / (gesture) dragging /
// spawning. Pointer ownership per probe P4: a capture-phase pointerdown on window
// decides — hit a placement (or spawning) → own the gesture (preventDefault +
// stopImmediatePropagation, camera enable* flags off, fullscreen shield captures
// the pointer); miss → the event passes through to camera-controls untouched.
// NEVER cycles cameraControls' script.enabled (pose-snap trap, probes P4).
// Fly (WASD/arrows) is disabled while a selection exists so arrow-nudge can't
// fight camera fly; orbit/pan stay live outside gestures.
import { floorPick, createSelectPicker } from './pick.js';
import { transformOp, addOp, removeOp, shadowOp, cloneT, sameT, placementT } from './ops.js';
import { createGhost } from '../staging.js';

const TRANSFORM_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'BracketLeft', 'BracketRight', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract',
]);

export function createController(ctx) {
  const { app, camera, catcher, doc, requestRender, history, saver, onState = () => {} } = ctx;
  const selectPicker = createSelectPicker(app, camera, doc);
  const selGhost = createGhost(app);
  app.on('update', () => selGhost.sync());

  const state = { selection: null, spawning: null, warn: '' };
  let uiRoot = null;
  let lastShadow = catcher.state().strength;

  const cc = () => camera.script?.cameraControls ?? null;
  const setWarn = msg => { state.warn = msg; onState(); };
  const syncFly = () => { const c = cc(); if (c) c.enableFly = !state.selection; };

  function select(id) {
    if (state.selection === id) return;
    commitKeyOp();
    state.selection = id;
    const e = id ? doc.entityFor(id) : null;
    if (e) selGhost.set(e, true);
    else if (selGhost.on) selGhost.set(null, false);
    syncFly();
    requestRender();
    onState();
  }

  // --- drag gesture (one op per drag; grab-offset so the object moves relatively) ---
  const shield = document.createElement('div');
  shield.style.cssText = 'position:fixed;inset:0;z-index:15;display:none;touch-action:none;cursor:grabbing;';
  document.body.appendChild(shield);
  let gesture = null;

  function beginGesture(e, id) {
    const c = cc();
    if (c) { c.enableOrbit = false; c.enablePan = false; c.enableFly = false; }
    shield.style.display = 'block';
    try { shield.setPointerCapture(e.pointerId); } catch {}
    gesture = { id, moved: false, startX: e.clientX, startY: e.clientY, op: null, offset: [0, 0] };
    if (id) {
      const oldT = placementT(doc.get(id));
      gesture.op = transformOp(doc, id, oldT, cloneT(oldT));
      const fp0 = floorPick(camera, e.clientX, e.clientY);
      if (fp0) gesture.offset = [oldT.pos[0] - fp0.point[0], oldT.pos[2] - fp0.point[2]];
    }
  }

  function endGesture() {
    const c = cc();
    if (c) { c.enableOrbit = true; c.enablePan = true; }
    syncFly();
    shield.style.display = 'none';
    if (gesture?.op && gesture.moved && !sameT(gesture.op.oldT, gesture.op.newT)) history.add(gesture.op);
    gesture = null;
    onState();
  }

  shield.addEventListener('pointermove', e => {
    if (!gesture) return;
    if (!gesture.moved && Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) < 4) return;
    gesture.moved = true;
    if (!gesture.op) return;
    const fp = floorPick(camera, e.clientX, e.clientY);
    if (!fp) return;
    gesture.op.newT.pos = [fp.point[0] + gesture.offset[0], 0, fp.point[2] + gesture.offset[1]];
    gesture.op.do();   // live apply — history.add re-runs it idempotently on commit
  });
  shield.addEventListener('pointerup', endGesture);
  shield.addEventListener('pointercancel', endGesture);

  async function placeSpawn(x, y) {
    const assetId = state.spawning;
    const fp = floorPick(camera, x, y);
    if (!fp) { setWarn('no floor under cursor'); return; }
    state.spawning = null;
    state.warn = fp.amp > 2
      ? `glancing angle (amp ${fp.amp.toFixed(1)}) — placement may overshoot; walk closer`
      : '';
    const placement = await doc.add({ asset: assetId, pos: fp.point, yaw: 0, scale: 1 });
    if (!placement) { setWarn(`asset ${assetId} failed to load`); return; }
    history.add(addOp(doc, placement, doc.entityFor(placement.id)));
    select(placement.id);
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    if (uiRoot && uiRoot.contains(e.target)) return;   // panel handles its own clicks
    if (state.spawning) {
      e.preventDefault(); e.stopImmediatePropagation();
      beginGesture(e, null);                           // own the gesture; place on click
      placeSpawn(e.clientX, e.clientY);
      return;
    }
    const id = selectPicker.pick(e.clientX, e.clientY);
    if (!id) { if (state.selection) select(null); return; }   // pass through → camera
    e.preventDefault(); e.stopImmediatePropagation();
    select(id);
    beginGesture(e, id);
  }
  window.addEventListener('pointerdown', onPointerDown, { capture: true });

  // --- keyboard (key auto-repeat = ONE op: snapshot on first keydown, commit on last keyup) ---
  const keyState = { op: null, keys: new Set() };
  function commitKeyOp() {
    if (keyState.op && !sameT(keyState.op.oldT, keyState.op.newT)) history.add(keyState.op);
    keyState.op = null;
    keyState.keys.clear();
  }

  function onKeyDown(e) {
    const t = e.target;
    if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === 'KeyZ') {
      e.preventDefault(); commitKeyOp();
      if (e.shiftKey) history.redo(); else history.undo();
      onState(); return;
    }
    if (ctrl && e.code === 'KeyY') { e.preventDefault(); commitKeyOp(); history.redo(); onState(); return; }
    if (ctrl && e.code === 'KeyS') {
      e.preventDefault(); commitKeyOp();
      saver.save().then(r => setWarn(r.ok ? `saved (${r.via})` : 'save cancelled'));
      return;
    }
    if (e.code === 'Escape') {
      if (state.spawning) { state.spawning = null; onState(); } else select(null);
      return;
    }
    if (!state.selection) return;
    if (e.code === 'Delete' || e.code === 'Backspace') {
      e.preventDefault(); commitKeyOp();
      const id = state.selection;
      select(null);
      history.add(removeOp(doc, id));
      onState(); return;
    }
    if (!TRANSFORM_KEYS.has(e.code)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!keyState.op) {
      const oldT = placementT(doc.get(state.selection));
      keyState.op = transformOp(doc, state.selection, oldT, cloneT(oldT));
    }
    keyState.keys.add(e.code);
    const nt = keyState.op.newT;
    const step = e.shiftKey ? 0.10 : 0.02;
    const yawStep = e.shiftKey ? 15 : 5;
    switch (e.code) {
      case 'ArrowUp': nt.pos[2] -= step; break;
      case 'ArrowDown': nt.pos[2] += step; break;
      case 'ArrowLeft': nt.pos[0] -= step; break;
      case 'ArrowRight': nt.pos[0] += step; break;
      case 'BracketLeft': nt.yaw -= yawStep; break;
      case 'BracketRight': nt.yaw += yawStep; break;
      case 'Equal': case 'NumpadAdd': nt.scale = Math.min(2, +(nt.scale * 1.03).toFixed(4)); break;
      case 'Minus': case 'NumpadSubtract': nt.scale = Math.max(0.5, +(nt.scale / 1.03).toFixed(4)); break;
    }
    keyState.op.do();
  }
  function onKeyUp(e) {
    if (!keyState.op) return;
    keyState.keys.delete(e.code);
    if (keyState.keys.size === 0) { commitKeyOp(); onState(); }
  }
  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('keyup', onKeyUp, { capture: true });

  // --- actions for the UI + automation ---
  async function spawn(assetId) {
    state.spawning = state.spawning === assetId ? null : assetId;
    onState();
    if (state.spawning) await doc.ensureTemplate(assetId);   // preload so the click is instant
  }

  async function spawnAt(assetId, pos, yaw = 0, scale = 1) {
    const placement = await doc.add({ asset: assetId, pos: [pos[0], 0, pos[2]], yaw, scale });
    if (!placement) return null;
    history.add(addOp(doc, placement, doc.entityFor(placement.id)));
    select(placement.id);
    return placement.id;
  }

  function transform(id, t) {
    const oldT = placementT(doc.get(id));
    const newT = cloneT(oldT);
    if (t.pos) newT.pos = [t.pos[0], 0, t.pos[2]];
    if (t.yaw !== undefined) newT.yaw = t.yaw;
    if (t.scale !== undefined) newT.scale = t.scale;
    history.add(transformOp(doc, id, oldT, newT));
    onState();
  }

  function setShadowStrength(v, commit) {
    catcher.set({ strength: v });
    if (commit && v !== lastShadow) { history.add(shadowOp(catcher, lastShadow, v)); }
  }

  return {
    setUiRoot(el) { uiRoot = el; },
    refreshShadowBaseline() { lastShadow = catcher.state().strength; },
    state,
    api: {
      select, spawn, spawnAt, transform, setShadowStrength,
      remove(id) { if (state.selection === id) select(null); history.add(removeOp(doc, id)); onState(); },
      undo() { commitKeyOp(); history.undo(); onState(); },
      redo() { commitKeyOp(); history.redo(); onState(); },
      getState() {
        return {
          selection: state.selection, spawning: state.spawning, warn: state.warn,
          canUndo: history.canUndo, canRedo: history.canRedo, dirty: history.dirty,
          shadowStrength: catcher.state().strength,
          placements: doc.snapshot(),
        };
      },
    },
  };
}
