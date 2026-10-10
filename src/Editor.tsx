import { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { python } from '@codemirror/lang-python'
import { oneDark } from '@codemirror/theme-one-dark'

interface Props {
  value: string
  dark: boolean
  onChange: (v: string) => void
  onRun: () => void
}

const base = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', backgroundColor: 'var(--panel)', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflow: 'auto' },
  '.cm-gutters': { backgroundColor: 'var(--panel2)', color: 'var(--muted)', border: 'none' },
})

export default function Editor({ value, dark, onChange, onRun }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const theme = useRef(new Compartment())
  const cb = useRef({ onChange, onRun })
  cb.current = { onChange, onRun }

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightActiveLine(), history(), indentOnInput(), bracketMatching(), python(),
          keymap.of([{ key: 'Mod-Enter', run: () => { cb.current.onRun(); return true } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          base,
          theme.current.of(dark ? oneDark : syntaxHighlighting(defaultHighlightStyle)),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()) }),
        ],
      }),
    })
    view.current = v
    return () => v.destroy()
    // The editor is created once; later prop changes are applied by the effects below.
  }, [])

  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(dark ? oneDark : syntaxHighlighting(defaultHighlightStyle)) })
  }, [dark])

  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])

  return <div ref={host} className="cm-host" />
}
