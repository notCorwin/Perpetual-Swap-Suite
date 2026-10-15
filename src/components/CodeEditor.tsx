import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { useEffect, useRef } from 'react'

export function CodeEditor({ value, onChange }: { value: string; onChange(value: string): void }) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!host.current) return
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          javascript(),
          ...(dark ? [oneDark] : []),
          EditorView.lineWrapping,
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
          EditorView.theme({
            '&': { height: '100%', background: 'transparent' },
            '.cm-scroller': { fontFamily: 'SF Mono, ui-monospace, monospace', fontSize: '10px' },
            '.cm-gutters': { background: 'transparent', borderRight: '1px solid var(--border)' },
          }),
        ],
      }),
    })
    editor.current = view
    return () => { editor.current = null; view.destroy() }
    // The editor owns its document after creation; the second effect handles external replacements.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = editor.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  return <div ref={host} className="code-editor" />
}
