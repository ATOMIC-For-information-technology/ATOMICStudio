import React, { useEffect, useRef } from 'react'
import Editor from '@monaco-editor/react'
import { languageForPath } from '../monaco-setup'
import { setActiveEditor, clearActiveEditor } from '../editor-bridge'
import { monacoThemeName } from '../theme'
import type { EditorPrefs } from './SettingsPanel'

export interface EditorSelection {
  startLine: number
  endLine: number
  text: string
}

interface Props {
  path: string
  value: string
  onChange: (value: string) => void
  onSave: () => void
  /** ⌘K: called with the current selection (whole current line when empty). */
  onInlineEdit: (sel: EditorSelection) => void
  prefs: EditorPrefs
}

/**
 * Monaco (the VS Code editor engine) wrapper. Read/write of a single file's
 * text; Cmd/Ctrl+S triggers onSave. Runs fully offline (see monaco-setup.ts).
 */
export function CodeEditor({ path, value, onChange, onSave, onInlineEdit, prefs }: Props): React.JSX.Element {
  // `onMount` runs once, so a command registered with the `onSave` of that render
  // would keep saving the file/content as they were at mount — silently dropping
  // later edits and writing the wrong tab. Always call through the latest prop.
  const onSaveRef = useRef(onSave)
  const onInlineEditRef = useRef(onInlineEdit)
  useEffect(() => {
    onSaveRef.current = onSave
    onInlineEditRef.current = onInlineEdit
  }, [onSave, onInlineEdit])

  return (
    <Editor
      className="code-editor"
      language={languageForPath(path)}
      value={value}
      theme={monacoThemeName()}
      onChange={(v) => onChange(v ?? '')}
      onMount={(editor, monaco) => {
        setActiveEditor(editor)
        editor.onDidFocusEditorText(() => {
          setActiveEditor(editor)
        })
        editor.onDidDispose(() => {
          clearActiveEditor(editor)
        })
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current())
        // ⌘K — AI edit of the current selection (or the caret's line). Registered as a real Monaco
        // ACTION, not just a keybinding, so the menu bar can trigger the identical code path
        // instead of a second implementation that could drift from it.
        editor.addAction({
          id: 'atomic.inlineEdit',
          label: 'Edit with AI…',
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
          contextMenuGroupId: 'modification',
          run: () => {
          const model = editor.getModel()
          const sel = editor.getSelection()
          if (!model || !sel) return
          const empty = sel.isEmpty()
          const startLine = empty ? sel.startLineNumber : sel.startLineNumber
          const endLine = empty ? sel.startLineNumber : sel.endLineNumber
          const text = empty
            ? model.getLineContent(startLine)
            : model.getValueInRange({
                startLineNumber: startLine,
                startColumn: 1,
                endLineNumber: endLine,
                endColumn: model.getLineMaxColumn(endLine)
              })
          onInlineEditRef.current({ startLine, endLine, text })
          }
        })
        // Test hooks: let the automated GUI pass drive the editor like a user would.
        ;(window as unknown as Record<string, unknown>).__studioEditor = editor
        ;(window as unknown as Record<string, unknown>).__studioMonaco = monaco

        // Tab autocomplete — one global registration; per-keystroke calls are
        // debounced and honour Monaco's cancellation token so only the newest
        // cursor position ever reaches the model.
        const w = window as unknown as Record<string, unknown>
        if (!w.__studioAutocompleteRegistered) {
          w.__studioAutocompleteRegistered = true
          monaco.languages.registerInlineCompletionsProvider(
            '*',
            {
              provideInlineCompletions: async (mdl, position, _ctx, token) => {
                w.__studioAcCalls = ((w.__studioAcCalls as number) ?? 0) + 1
                const cfg = w.__studioAutocomplete as
                  | { enabled: boolean; provider: string; model?: string; path?: string }
                  | undefined
                if (!cfg?.enabled) return { items: [] }
                await new Promise((r) => setTimeout(r, 350))
                if (token.isCancellationRequested) return { items: [] }
                const offset = mdl.getOffsetAt(position)
                const text = mdl.getValue()
                const res = await window.studio.autocomplete({
                  file: cfg.path ?? 'untitled',
                  prefix: text.slice(0, offset),
                  suffix: text.slice(offset),
                  provider: cfg.provider,
                  model: cfg.model
                })
                if (!res.ok || !res.text || token.isCancellationRequested) return { items: [] }
                return {
                  items: [
                    {
                      insertText: res.text,
                      range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
                    }
                  ]
                }
              },
              freeInlineCompletions: () => {}
            }
          )
        }
      }}
      options={{
        fontSize: prefs.fontSize,
        inlineSuggest: { enabled: true },
        minimap: { enabled: prefs.minimap },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        tabSize: prefs.tabSize,
        wordWrap: prefs.wordWrap ? 'on' : 'off',
        smoothScrolling: true,
        renderWhitespace: 'selection',
        padding: { top: 10 }
      }}
    />
  )
}
