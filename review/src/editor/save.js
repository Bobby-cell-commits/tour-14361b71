// Save — FS Access API with a cached handle (silent Ctrl+S after the first pick),
// plain-download fallback. Operator saves to viewer/<scene>.staging.json (the
// committed home; viewer-pc/assets/ holds a symlink so a reload round-trips).
export function createSaver({ doc, catcher, sceneName, history }) {
  let handle = null;

  async function save() {
    const data = JSON.stringify(doc.serialize(sceneName, catcher.state().strength), null, 2) + '\n';
    if ('showSaveFilePicker' in window) {
      try {
        if (!handle) {
          handle = await window.showSaveFilePicker({
            suggestedName: `${sceneName}.staging.json`,
            types: [{ description: 'staging json', accept: { 'application/json': ['.json'] } }],
          });
        }
        const w = await handle.createWritable();
        await w.write(data);
        await w.close();
        history.markSaved();
        return { ok: true, via: 'fs', name: handle.name };
      } catch (e) {
        if (e?.name === 'AbortError') return { ok: false, aborted: true };
        console.warn('[editor] fs save failed — falling back to download', e);
        handle = null;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = `${sceneName}.staging.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    history.markSaved();
    return { ok: true, via: 'download' };
  }

  return { save, serialize: () => doc.serialize(sceneName, catcher.state().strength) };
}
