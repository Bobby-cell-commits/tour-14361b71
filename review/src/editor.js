// Operator staging editor (issue #5) — lazy entry. NEVER imported without ?edit=1
// (Theatre.js-Studio packaging discipline: the customer bundle physically lacks
// the tool). Wires document + history + controller + overlay UI + saver and
// exposes window.editorApi as the automation surface.
import { createHistory } from './editor/history.js';
import { createSaver } from './editor/save.js';
import { createController } from './editor/controller.js';
import { createUi } from './editor/ui.js';

export async function initEditor(ctx) {
  const { doc, catcher, sceneName, docReady } = ctx;
  await docReady;   // placements + catalog are projected before the editor wakes

  let ui = null;
  const history = createHistory({
    onChange: () => { controller.refreshShadowBaseline(); ui?.refresh(); },
  });
  const saver = createSaver({ doc, catcher, sceneName, history });
  const controller = createController({ ...ctx, history, saver, onState: () => ui?.refresh() });
  ui = createUi({ doc, catcher, history, sceneName, controller });
  controller.setUiRoot(ui.root);

  window.editorApi = {
    ...controller.api,
    save: () => saver.save(),
    serialize: () => saver.serialize(),
    markSaved: () => history.markSaved(),   // out-of-band saves (automation writes the file itself)
  };

  window.addEventListener('beforeunload', e => {
    if (history.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  ui.refresh();
  console.log('[editor] ready', JSON.stringify({
    placements: doc.placements.length, catalog: doc.catalog?.assets?.length ?? 0,
  }));
}
