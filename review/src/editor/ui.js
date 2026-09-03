// Editor overlay — own root at z-index 20 (independent of #hud and ?hud=0), the
// root is pointer-events:none so only the panel itself swallows clicks; everything
// on the canvas goes through the controller's capture-phase router.
export function createUi({ doc, catcher, sceneName, controller }) {
  const style = document.createElement('style');
  style.textContent = `
    #editor-ui { position: fixed; top: 12px; right: 12px; z-index: 20; pointer-events: none;
                 font-family: system-ui, sans-serif; }
    #editor-ui .panel { pointer-events: auto; background: rgba(12,12,16,.85); color: #ddd;
                        border: 1px solid #333; border-radius: 10px; padding: 12px 14px;
                        width: 250px; font-size: 12.5px; line-height: 1.5; }
    #editor-ui .title { color: #fc6; font-weight: 700; letter-spacing: .04em; margin-bottom: 6px; }
    #editor-ui .pal-item { display: flex; align-items: center; gap: 8px; width: 100%;
                           background: #1c1c22; color: #ddd; border: 1px solid #333;
                           border-radius: 8px; padding: 6px 8px; margin: 4px 0; cursor: pointer;
                           text-align: left; font: inherit; }
    #editor-ui .pal-item:hover { border-color: #6cf; }
    #editor-ui .pal-item.armed { border-color: #fc6; background: #2a2418; }
    #editor-ui .pal-item img { width: 40px; height: 40px; border-radius: 6px; object-fit: cover;
                               background: #333; }
    #editor-ui .pal-item .sub { color: #888; font-size: 11px; }
    #editor-ui .badge { color: #f96; font-size: 10px; border: 1px solid #f96; border-radius: 4px;
                        padding: 0 4px; margin-left: 4px; }
    #editor-ui .row { display: flex; gap: 6px; margin: 8px 0 4px; }
    #editor-ui .row button { flex: 1; background: #1c1c22; color: #ddd; border: 1px solid #333;
                             border-radius: 6px; padding: 5px 0; cursor: pointer; font: inherit; }
    #editor-ui .row button:disabled { opacity: .35; cursor: default; }
    #editor-ui .row button:not(:disabled):hover { border-color: #6cf; }
    #editor-ui .dirty { color: #fc6; }
    #editor-ui .sel { font-family: monospace; font-size: 11.5px; color: #9c9; min-height: 2.6em;
                      white-space: pre; margin-top: 6px; }
    #editor-ui .warn { color: #f96; font-size: 11.5px; min-height: 1.2em; }
    #editor-ui .legend { color: #777; font-size: 10.5px; margin-top: 8px; line-height: 1.5; }
    #editor-ui input[type=range] { width: 100%; }
    #editor-ui .shadow-lbl { color: #999; font-size: 11px; margin-top: 6px; }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'editor-ui';
  const panel = document.createElement('div');
  panel.className = 'panel';
  root.appendChild(panel);
  document.body.appendChild(root);

  // el() is for STATIC markup only — never interpolate data into it (see the slider below,
  // which used to template catcher.state().strength straight into an attribute: F-30).
  const el = html => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };

  // catalog values and ?scene= are data, not markup — build with DOM methods, never innerHTML
  const title = el('<div class="title"></div>');
  title.textContent = `STAGING EDITOR — ${sceneName}`;
  panel.appendChild(title);

  // palette
  const pal = document.createElement('div');
  const palButtons = new Map();
  for (const a of doc.catalog?.assets ?? []) {
    const b = el('<button class="pal-item" type="button"><img alt=""><span></span></button>');
    const img = b.querySelector('img');
    const thumbUrl = a.thumb ? doc.resolveUrl(a.thumb) : null;   // base-relative like entry.glb;
    if (thumbUrl) img.src = thumbUrl;                            // null = refused cross-origin (F-29)
    else img.style.display = 'none';
    img.addEventListener('error', () => { img.style.display = 'none'; });
    const span = b.querySelector('span');
    const name = document.createElement('b');
    name.textContent = a.name ?? a.id;
    span.appendChild(name);
    if (a.provenance?.license === 'judge-only') {
      const badge = el('<span class="badge">judge-only</span>');
      span.appendChild(badge);
    }
    span.appendChild(document.createElement('br'));
    const sub = el('<span class="sub"></span>');
    sub.textContent = `${a.class ?? ''} · h ${a.targetH} m`;
    span.appendChild(sub);
    b.addEventListener('click', () => controller.api.spawn(a.id));
    palButtons.set(a.id, b);
    pal.appendChild(b);
  }
  if (!palButtons.size) pal.appendChild(el('<div class="sub">no catalog.json — palette empty</div>'));
  panel.appendChild(pal);

  // undo / redo / save
  const row = el('<div class="row"></div>');
  const btnUndo = el('<button type="button">⌫ Undo</button>');
  const btnRedo = el('<button type="button">Redo</button>');
  const btnSave = el('<button type="button">Save</button>');
  btnUndo.addEventListener('click', () => controller.api.undo());
  btnRedo.addEventListener('click', () => controller.api.redo());
  btnSave.addEventListener('click', () => window.editorApi?.save());
  row.append(btnUndo, btnRedo, btnSave);
  panel.appendChild(row);

  // shadow strength
  panel.appendChild(el('<div class="shadow-lbl">shadow strength</div>'));
  // DOM methods, not a template: strength is data that reaches here from staging.json
  // (`shadow.strength`) via catcher.set — the one value in this file that is neither a
  // catalog entry nor ?scene=, which is exactly why the innerHTML rule was missed (F-30).
  // catcher.set now coerces too; this is the second half of the same fix.
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.01';
  slider.value = String(Number(catcher.state().strength) || 0);
  slider.addEventListener('input', () => controller.api.setShadowStrength(parseFloat(slider.value), false));
  slider.addEventListener('change', () => controller.api.setShadowStrength(parseFloat(slider.value), true));
  panel.appendChild(slider);

  const selEl = el('<div class="sel"></div>');
  const warnEl = el('<div class="warn"></div>');
  panel.append(selEl, warnEl);
  panel.appendChild(el(`<div class="legend">drag = move · [ ] = rotate · +/− = scale ·
    arrows = nudge (world axes, Shift = coarse) · Del = delete · Esc = deselect ·
    Ctrl+Z/Y = undo/redo · Ctrl+S = save<br>palette click arms spawn → click the floor</div>`));

  function refresh() {
    const s = controller.api.getState();
    for (const [id, b] of palButtons) b.classList.toggle('armed', s.spawning === id);
    btnUndo.disabled = !s.canUndo;
    btnRedo.disabled = !s.canRedo;
    btnSave.innerHTML = s.dirty ? 'Save <span class="dirty">●</span>' : 'Save';
    if (Math.abs(parseFloat(slider.value) - s.shadowStrength) > 0.005) slider.value = s.shadowStrength;
    if (s.selection) {
      const p = s.placements.find(x => x.id === s.selection);
      selEl.textContent = p
        ? `▸ ${p.asset}\n  pos ${p.pos[0].toFixed(2)}, ${p.pos[2].toFixed(2)} · yaw ${p.yaw.toFixed(0)}° · ×${p.scale.toFixed(2)}`
        : '';
    } else {
      selEl.textContent = s.spawning ? `armed: ${s.spawning}\nclick the floor to place (Esc cancels)` : 'click an object to select';
    }
    warnEl.textContent = s.warn ?? '';
  }

  return { root, refresh };
}
