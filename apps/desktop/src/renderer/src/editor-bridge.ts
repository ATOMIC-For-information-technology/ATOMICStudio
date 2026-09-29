/**
 * The menu bar's handle on the editor, with no dependency on the editor.
 *
 * The menu needs to trigger Monaco's own actions — "Move Line Up", "Find", "Go to Line" — and the
 * honest way to expose those is to trigger the very action the keybinding triggers, not to
 * reimplement it. That used to mean `App.tsx` importing `runEditorAction` straight from
 * `CodeEditor.tsx`, which is what pinned the whole Monaco graph into the startup chunk: one
 * two-line helper held the entire editor hostage.
 *
 * So the handle lives here instead. This module imports nothing, the editor registers itself as it
 * mounts, and every function below is a no-op until it does — which is exactly the correct
 * behaviour anyway, since "Find" with no file open has nothing to find in.
 */

/** The subset of Monaco's editor this app actually drives from the menu. Structural, so it needs no
 *  `monaco-editor` import — matching the real type is the editor's job, not the menu's. */
export interface EditorHandle {
  focus(): void
  trigger(source: string, handlerId: string, payload: unknown): void
}

let activeEditor: EditorHandle | null = null

/** Called by `CodeEditor` on mount and on focus. */
export function setActiveEditor(editor: EditorHandle | null): void {
  activeEditor = editor
}

/** Clear the handle only if it still points at this editor — an unmount that races a newly focused
 *  tab must not blank out the tab that just took over. */
export function clearActiveEditor(editor: EditorHandle): void {
  if (activeEditor === editor) activeEditor = null
}

/** Run one of Monaco's built-in actions against the visible editor. No-op when nothing is open. */
export function runEditorAction(actionId: string): void {
  activeEditor?.focus()
  activeEditor?.trigger('menu', actionId, null)
}

export function focusEditor(): void {
  activeEditor?.focus()
}
