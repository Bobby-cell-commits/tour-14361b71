// Command-pattern undo — the SuperSplat design (edit-history.ts), reimplemented:
// an op is {name, do(), undo()} with all state captured at construction; do() IS
// redo; add() truncates the redo branch, pushes, and immediately runs do() (which
// must therefore be idempotent after a live drag — the caller applied the same
// state already). Ops here are synchronous, so SuperSplat's CommandQueue is skipped.
export function createHistory({ onChange = () => {} } = {}) {
  const ops = [];
  let cursor = 0;
  let savedCursor = 0;   // -1 = the saved state was truncated away, can never be clean again

  const api = {
    add(op) {
      while (cursor < ops.length) ops.pop();
      if (savedCursor > cursor) savedCursor = -1;
      ops.push(op);
      op.do();
      cursor++;
      onChange(api);
    },
    undo() { if (cursor > 0) { ops[cursor - 1].undo(); cursor--; onChange(api); } },
    redo() { if (cursor < ops.length) { ops[cursor].do(); cursor++; onChange(api); } },
    markSaved() { savedCursor = cursor; onChange(api); },
    get canUndo() { return cursor > 0; },
    get canRedo() { return cursor < ops.length; },
    get dirty() { return cursor !== savedCursor; },
    get cursor() { return cursor; },
    get length() { return ops.length; },
  };
  return api;
}
