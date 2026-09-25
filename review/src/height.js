// View-height control (?height=1, owner 2026-09-25): raise / lower the orbit camera on the fly to compare
// how a splat looks below or above the height it was filmed at (research/2026-09-24-x6-home-view-height-compare.md).
//   Shift + wheel   ±5 cm per notch (Chrome on Linux turns Shift+wheel into deltaX — both axes are read)
//   PageUp / Down   ±5 cm
//   Y or the button flip back to the previous height (A/B at one spot)
// Moves the entity AND re-attaches camera-controls through its focusPoint setter (the instant re-attach —
// known-issues "camera-controls input suppression"); never viewerApi.setPose, which disables the script and
// snaps back on re-enable. Orbit mode only: walk and the rails tour own the camera height themselves.
import { Vec3 } from 'playcanvas';

const STEP_M = 0.05;
const GESTURE_GAP_MS = 800;   // a pause this long starts a new gesture → the flip target is its start height

export function createHeightControl({ camera, spawn, requestRender, busy, onStatus }) {
  const filmed = spawn?.position?.[1] ?? null;
  let prev = null, lastWheel = 0;
  const cc = () => camera.script?.cameraControls ?? null;
  const get = () => camera.getPosition().y;

  function set(y) {
    const c = cc();
    const p = camera.getPosition().clone(), f = camera.forward.clone();
    camera.setPosition(p.x, y, p.z);
    if (c) c.focusPoint = new Vec3(p.x + f.x * 2, y + f.y * 2, p.z + f.z * 2);
    requestRender();
    sync();
    return y;
  }
  function nudge(dy) {
    if (busy()) { onStatus('height control works in orbit mode — exit walk / tour first'); return; }
    const now = performance.now();
    if (now - lastWheel > GESTURE_GAP_MS) prev = get();
    lastWheel = now;
    set(get() + dy);
  }
  function flip() {
    if (busy() || prev == null) return;
    const cur = get();
    set(prev);
    prev = cur;
  }

  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:12;';
  const btn = document.createElement('button');
  btn.title = 'Shift + wheel or PageUp/PageDown: ±5 cm · click or Y: back to the previous height';
  btn.style.cssText =
    'pointer-events:auto;position:absolute;right:14px;bottom:52px;padding:7px 14px;' +
    'font:13px system-ui;color:#eee;background:#222a;border:1px solid #555;border-radius:6px;cursor:pointer;';
  btn.onclick = () => flip();
  root.appendChild(btn);
  document.body.appendChild(root);

  function sync() {
    const y = get();
    const d = filmed == null ? '' : ` · filmed ${filmed.toFixed(2)} (${y - filmed >= 0 ? '+' : '−'}${Math.abs(y - filmed).toFixed(2)})`;
    btn.textContent = `↕ ${y.toFixed(2)} m${d}${prev == null ? '' : ` · Y ⇄ ${prev.toFixed(2)}`}`;
  }

  // window capture phase: runs before camera-controls' canvas wheel (zoom) handler and swallows the event
  addEventListener('wheel', e => {
    if (!e.shiftKey) return;
    const d = e.deltaY || e.deltaX;
    if (!d) return;
    e.preventDefault(); e.stopImmediatePropagation();
    nudge(d < 0 ? STEP_M : -STEP_M);
  }, { capture: true, passive: false });
  addEventListener('keydown', e => {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code === 'PageUp' || e.code === 'PageDown') { e.preventDefault(); nudge(e.code === 'PageUp' ? STEP_M : -STEP_M); }
    if (e.code === 'KeyY' && !e.ctrlKey && !e.metaKey) flip();   // Ctrl+Y is the editor's redo
  });
  // the orbit camera moves under the mouse too — keep the readout current (cheap: a text node)
  setInterval(sync, 250);
  sync();
  return { get, set, flip, nudge };
}
