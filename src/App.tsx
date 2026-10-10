import { useCallback, useEffect, useRef, useState } from 'react'
import Editor from './Editor'
import { EXAMPLES } from './examples'
import { Device } from './lib/device'
import { serialSupported, SerialTransport } from './lib/serial'
import { SimBoard } from './lib/sim'
import { Term } from './lib/term'
import { joinPath, type Entry, utf8Bytes } from './lib/protocol'
import { tr, type T } from './i18n'
import { useSettings, useStored } from './settings'
import { download, Notice, Shell } from './ui'

type Status = 'off' | 'serial' | 'demo'

export default function App() {
  const [settings, setSettings] = useSettings()
  const t: T = (s, ...a) => tr(settings.lang, s, ...a)
  const [code, setCode] = useStored<string>('code', EXAMPLES['Blink LED'])
  const [filename, setFilename] = useStored<string>('filename', 'main.py')
  const [baud, setBaud] = useStored<number>('baud', 115200)
  const [status, setStatus] = useState<Status>('off')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [dir, setDir] = useState('/')
  const [files, setFiles] = useState<Entry[]>([])
  const [pins, setPins] = useState<Map<number, number>>(new Map())
  const [, tick] = useState(0)
  const term = useRef(new Term())
  const dev = useRef<Device | null>(null)
  const termEl = useRef<HTMLPreElement>(null)
  const raf = useRef(0)
  const prefersDark = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = settings.theme === 'dark' || (settings.theme === 'auto' && prefersDark)

  const redraw = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; tick((n) => n + 1) })
  }, [])
  useEffect(() => {
    const el = termEl.current
    if (el) el.scrollTop = el.scrollHeight
  })

  const refresh = useCallback(async (d = dir) => {
    if (!dev.current) return
    try { setFiles(await dev.current.list(d)) } catch (e) { setMsg(String((e as Error).message)) }
  }, [dir])

  const attach = async (transport: SimBoard | SerialTransport, st: Status) => {
    term.current.clear()
    const d = new Device(transport, (s) => { term.current.write(s); redraw() })
    d.onBusy = setBusy
    dev.current = d
    if (transport instanceof SerialTransport) transport.onClose = () => { setStatus('off'); setMsg(t('Device disconnected.')); dev.current = null; setFiles([]) }
    if (transport instanceof SimBoard) transport.onPins = setPins
    setStatus(st)
    setMsg('')
    if (st === 'serial') await d.start()
    await new Promise((r) => setTimeout(r, 150))
    setDir('/')
    try { setFiles(await d.list('/')) } catch (e) { setMsg(String((e as Error).message)) }
  }

  const connect = async () => {
    try { await attach(await SerialTransport.request(baud), 'serial') } catch (e) { setMsg(String((e as Error).message ?? e)) }
  }
  const demo = () => { void attach(new SimBoard(1), 'demo') }
  const disconnect = async () => {
    await dev.current?.close()
    dev.current = null
    setStatus('off')
    setFiles([])
    setPins(new Map())
  }

  const guard = async (fn: () => Promise<unknown>) => {
    try { setMsg(''); await fn() } catch (e) { setMsg(String((e as Error).message ?? e)) }
  }
  const run = () => dev.current && guard(async () => { term.current.write('\r\n'); await dev.current!.run(code) })
  const save = () => dev.current && guard(async () => { await dev.current!.writeFile(joinPath(dir, filename), utf8Bytes(code)); setMsg(t('Saved {0}', joinPath(dir, filename))); await refresh() })
  const open = (e: Entry) => guard(async () => {
    if (e.dir) { const d = joinPath(dir, e.name); setDir(d); await refresh(d); return }
    const bytes = await dev.current!.readFile(joinPath(dir, e.name))
    setCode(new TextDecoder().decode(bytes))
    setFilename(e.name)
  })
  const del = (e: Entry) => guard(async () => { if (confirm(t('Delete {0}?', e.name))) { await dev.current!.remove(joinPath(dir, e.name), e.dir); await refresh() } })
  const up = () => { const d = dir.replace(/\/[^/]*$/, '') || '/'; setDir(d); void refresh(d) }
  const localOpen = async (f: File | undefined) => { if (!f) return; setCode(await f.text()); setFilename(f.name) }

  const onKey = (e: React.KeyboardEvent) => {
    if (!dev.current) return
    let s = ''
    if (e.ctrlKey && e.key.length === 1) {
      const k = e.key.toLowerCase()
      if (k === 'v') return
      if (k >= 'a' && k <= 'z') s = String.fromCharCode(k.charCodeAt(0) - 96)
    } else if (e.metaKey || e.altKey) return
    else if (e.key === 'Enter') s = '\r'
    else if (e.key === 'Backspace') s = '\x7f'
    else if (e.key === 'Tab') s = '\t'
    else if (e.key === 'ArrowUp') s = '\x1b[A'
    else if (e.key === 'ArrowDown') s = '\x1b[B'
    else if (e.key.length === 1) s = e.key
    if (s) { e.preventDefault(); void dev.current.sendInput(s) }
  }
  const onPaste = (e: React.ClipboardEvent) => { e.preventDefault(); void dev.current?.sendInput(e.clipboardData.getData('text').replace(/\r?\n/g, '\r')) }

  const connected = status !== 'off'
  return (
    <Shell title="MicroPython Web Editor" subtitle="Edit, run and upload MicroPython over Web Serial, with a REPL terminal." settings={settings} onSettings={setSettings} t={t}>
      {!serialSupported() && <Notice>{t('Your browser does not support {0}. Use Chrome or Edge on desktop; the demo mode works everywhere.', 'Web Serial')}</Notice>}
      <div className="box">
        <div className="row">
          {!connected ? (
            <>
              <select value={baud} onChange={(e) => setBaud(+e.target.value)} aria-label={t('Baud rate')}>
                {[9600, 57600, 115200, 230400, 460800, 921600].map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
              <button className="primary" onClick={connect} disabled={!serialSupported()}>{t('Connect board')}</button>
              <button onClick={demo}>{t('Start simulator')}</button>
            </>
          ) : (
            <>
              <span className={`chip ${status === 'demo' ? '' : 'ok'}`}>{status === 'demo' ? t('Simulated board') : t('Connected')}</span>
              <button className="primary" onClick={run} disabled={busy} title="Ctrl+Enter">{t('Run')}</button>
              <button onClick={() => dev.current?.interrupt()}>{t('Stop')}</button>
              <button onClick={() => dev.current?.softReset()}>{t('Soft reset')}</button>
              <button onClick={save} disabled={busy}>{t('Save to device')}</button>
              <button className="danger" onClick={disconnect}>{t('Disconnect')}</button>
            </>
          )}
          <span className="spacer" />
          {msg && <span className="warn-text">{msg}</span>}
        </div>
      </div>
      <div className="cols mpy">
        <div className="box">
          <h3>{t('Device files')}</h3>
          {!connected && <p className="hint">{t('Connect a board or start the simulator to browse its files.')}</p>}
          {connected && (
            <>
              <div className="row">
                <span className="mono">{dir}</span>
                <span className="spacer" />
                {dir !== '/' && <button className="small" onClick={up}>..</button>}
                <button className="small" onClick={() => refresh()} disabled={busy}>{t('Refresh')}</button>
              </div>
              <ul className="files">
                {files.map((f) => (
                  <li key={f.name}>
                    <button className="link-btn" onClick={() => open(f)}>{f.dir ? '📁' : '📄'} {f.name}</button>
                    <span className="hint">{f.dir ? '' : `${f.size} B`}</span>
                    <button className="small danger" onClick={() => del(f)} aria-label={t('Delete')}>×</button>
                  </li>
                ))}
                {files.length === 0 && <li className="hint">{t('No files.')}</li>}
              </ul>
            </>
          )}
          {status === 'demo' && pins.size > 0 && (
            <div className="row" aria-label="pins">
              {[...pins].map(([n, v]) => <span key={n} className="chip"><span className={`led ${v ? 'on' : ''}`} /> GP{n}</span>)}
            </div>
          )}
        </div>
        <div className="box editorbox">
          <div className="row">
            <input type="text" value={filename} onChange={(e) => setFilename(e.target.value)} aria-label={t('File name')} style={{ width: 140 }} />
            <select value="" onChange={(e) => e.target.value && setCode(EXAMPLES[e.target.value])} aria-label={t('Examples')}>
              <option value="">{t('Examples…')}</option>
              {Object.keys(EXAMPLES).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <label className="filebtn">{t('Open file…')}<input type="file" accept=".py,.txt,.json" hidden onChange={(e) => localOpen(e.target.files?.[0])} /></label>
            <button className="small" onClick={() => download(filename, code, 'text/x-python')}>{t('Download')}</button>
          </div>
          <Editor value={code} dark={dark} onChange={setCode} onRun={() => void run()} />
        </div>
      </div>
      <div className="box">
        <div className="row">
          <h3 style={{ margin: 0 }}>{t('REPL terminal')}</h3>
          <span className="hint">{t('Click the terminal and type. Ctrl+C interrupts, Ctrl+D soft-resets, Ctrl+E pastes.')}</span>
          <span className="spacer" />
          <button className="small" onClick={() => { term.current.clear(); redraw() }}>{t('Clear')}</button>
        </div>
        <pre ref={termEl} className="term" tabIndex={0} onKeyDown={onKey} onPaste={onPaste} aria-label={t('REPL terminal')}>{term.current.text || (connected ? '' : t('Not connected.'))}</pre>
      </div>
    </Shell>
  )
}
