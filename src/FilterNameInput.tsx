import type { Dispatch, SetStateAction } from 'react'
import { Input } from '@/components/ui/input'
import type { FilterEditorState } from '@/rule-engine'

export function FilterNameInput({ id, name, label, editor, setEditor, onCommit }: { id: string; name: string; label: string; editor: FilterEditorState; setEditor: Dispatch<SetStateAction<FilterEditorState>>; onCommit: (name: string) => void }) {
  const commit = () => {
    if (!(id in editor.nameDrafts)) return
    const next = editor.nameDrafts[id].trim().replace(/\s+/g, '_')
    if (next !== name) onCommit(next)
    setEditor(current => { const drafts = { ...current.nameDrafts }; delete drafts[id]; return { ...current, nameDrafts: drafts } })
  }
  return <Input value={editor.nameDrafts[id] ?? name} aria-label={label} spellCheck={false} autoComplete="off" onChange={event => setEditor(current => ({ ...current, nameDrafts: { ...current.nameDrafts, [id]: event.target.value } }))} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
}
