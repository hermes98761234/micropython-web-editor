import { F, Interp, PyError, PyTuple, num, pyStr, type Host, type PyObj, type Value } from './minipy'
import { CTRL_C, enc, fromHex, latin1, readMarker, toHex, type Transport } from './protocol'

export const BANNER = 'MicroPython v1.22.2 on 2024-02-22; Simulated board with RP2040\r\nType "help()" for more information.\r\n'
const WINDOW = 128

type Mode = 'friendly' | 'raw' | 'paste'

/** A simulated MicroPython board speaking the real REPL / raw REPL / raw-paste protocol. */
export class SimBoard implements Transport {
  onData: ((d: Uint8Array) => void) | null = null
  /** Files by absolute path; contents are latin-1 strings holding raw bytes. */
  fs = new Map<string, string>()
  dirs = new Set<string>(['/'])
  pins = new Map<number, number>()
  onPins: ((pins: Map<number, number>) => void) | null = null
  sleepScale: number
  private mode: Mode = 'friendly'
  private line = ''
  private block: string[] = []
  private rawBuf = ''
  private paste: { active: boolean; consumed: number } = { active: false, consumed: 0 }
  private pasteStart = 0 // 0 none, 1 saw ^E, 2 saw A
  private pasteBuf = ''
  private interp: Interp
  private running = false
  private closed = false

  constructor(sleepScale = 1) {
    this.sleepScale = sleepScale
    this.fs.set('/boot.py', '# This file is executed on every boot\r\n')
    this.fs.set('/main.py', 'print("Hello from the simulated board!")\r\n')
    this.fs.set('/lib/sensor.py', '# helper module\r\n')
    this.dirs.add('/lib')
    this.interp = this.newInterp()
    // Greet like a freshly reset board.
    setTimeout(() => this.out(BANNER + '>>> '), 0)
  }

  private out(s: string): void {
    if (!this.closed) this.onData?.(enc(unescape(encodeURIComponent(s))))
  }
  private outRaw(s: string): void {
    if (!this.closed) this.onData?.(enc(s))
  }

  private newInterp(): Interp {
    const self = this
    const sleep = async (sec: number): Promise<null> => {
      let left = sec * 1000 * this.sleepScale
      while (left > 0) {
        if (this.interp.interrupted) throw new PyError('KeyboardInterrupt', '')
        const step = Math.min(left, 25)
        await new Promise((r) => setTimeout(r, step))
        left -= step
      }
      return null
    }
    const start = Date.now()
    const pin = (n: number): PyObj => {
      const o: PyObj = {
        pyName: 'Pin',
        getattr: (name: string): Value => {
          const set = (v: number) => { self.pins.set(n, v); self.onPins?.(new Map(self.pins)) }
          switch (name) {
            case 'value': return (a: Value[]) => { if (a.length) { set(num(a[0]) ? 1 : 0); return null } return self.pins.get(n) ?? 0 }
            case 'on': case 'high': return () => { set(1); return null }
            case 'off': case 'low': return () => { set(0); return null }
            case 'toggle': return () => { set(self.pins.get(n) ? 0 : 1); return null }
            case 'init': return () => null
            default: throw new PyError('AttributeError', `'Pin' object has no attribute '${name}'`)
          }
        },
        strOf: () => `Pin(${n})`,
      }
      return o
    }
    const pinClass: PyObj = {
      pyName: 'type',
      getattr: (name: string): Value => {
        const c: Record<string, Value> = { IN: 0, OUT: 1, PULL_UP: 2, PULL_DOWN: 3, __call__: (a: Value[]) => { const n = num(a[0]); if (a[1] === 1 && !self.pins.has(n)) { self.pins.set(n, 0); self.onPins?.(new Map(self.pins)) } return pin(n) } }
        if (!(name in c)) throw new PyError('AttributeError', `type object 'Pin' has no attribute '${name}'`)
        return c[name]
      },
    }
    const adc = (a: Value[]): PyObj => ({ pyName: 'ADC', getattr: (n: string): Value => (n === 'read_u16' ? () => 30000 + Math.floor(Math.random() * 2000) : n === 'read' ? () => 1900 + Math.floor(Math.random() * 100) : () => null) , strOf: () => `ADC(${pyStr(a[0])})` })
    const pwm = (): PyObj => ({ pyName: 'PWM', getattr: () => () => null })
    const fileObj = (path: string, mode: string): PyObj => {
      let buf = mode.startsWith('r') ? (self.fs.get(path) ?? '') : mode.startsWith('a') ? (self.fs.get(path) ?? '') : ''
      if (mode.startsWith('r') && !self.fs.has(path)) throw new PyError('OSError', '[Errno 2] ENOENT')
      let pos = 0
      return {
        pyName: 'TextIOWrapper',
        getattr: (n: string): Value => {
          if (n === 'read') return () => { const r = buf.slice(pos); pos = buf.length; return r }
          if (n === 'readline') return () => { const i = buf.indexOf('\n', pos); const r = buf.slice(pos, i < 0 ? undefined : i + 1); pos += r.length; return r }
          if (n === 'readlines') return () => { const r = buf.slice(pos).split(/(?<=\n)/).filter(Boolean); pos = buf.length; return r }
          if (n === 'write') return (a: Value[]) => { buf += pyStr(a[0]); self.fs.set(path, buf); return pyStr(a[0]).length }
          if (n === 'close') return () => { if (!mode.startsWith('r')) self.fs.set(path, buf); return null }
          throw new PyError('AttributeError', `'file' object has no attribute '${n}'`)
        },
      }
    }
    const abs = (p: string) => (p.startsWith('/') ? p : '/' + p)
    const mod = (m: Record<string, Value>): Record<string, Value> => m
    const host: Host = {
      write: (s) => this.out(s),
      sleepScale: this.sleepScale,
      modules: {
        time: mod({
          sleep: (a) => sleep(num(a[0])), sleep_ms: (a) => sleep(num(a[0]) / 1000), sleep_us: (a) => sleep(num(a[0]) / 1e6),
          ticks_ms: () => (Date.now() - start) % 1073741823, ticks_us: () => ((Date.now() - start) * 1000) % 1073741823, ticks_diff: (a) => num(a[0]) - num(a[1]), time: () => Math.floor(Date.now() / 1000) - 946684800,
        }),
        machine: mod({ Pin: pinClass, ADC: (a) => adc(a), PWM: () => pwm(), freq: () => 125000000, unique_id: () => 'e6614103e7a5ab2f', reset: () => { throw new PyError('SystemExit', '') } }),
        os: mod({
          listdir: (a) => { const d = a.length ? abs(String(a[0])).replace(/\/$/, '') || '/' : '/'; return self.list(d).map((e) => e.name) },
          uname: () => new PyTuple(['rp2', 'rp2', '1.22.2', 'v1.22.2 on 2024-02-22 (simulated)', 'Simulated board with RP2040']),
          remove: (a) => { self.fs.delete(abs(String(a[0]))); return null }, getcwd: () => '/', mkdir: (a) => { self.dirs.add(abs(String(a[0]))); return null },
        }),
        sys: mod({ version: '3.4.0; MicroPython v1.22.2 on 2024-02-22', platform: 'rp2', implementation: new PyTuple(['micropython', 1, 22, 2]), path: ['', '/lib'] }),
        random: mod({ random: () => new F(Math.random()), randint: (a) => num(a[0]) + Math.floor(Math.random() * (num(a[1]) - num(a[0]) + 1)), choice: (a) => (a[0] as Value[])[Math.floor(Math.random() * (a[0] as Value[]).length)] }),
        math: mod({ sqrt: (a) => new F(Math.sqrt(num(a[0]))), sin: (a) => new F(Math.sin(num(a[0]))), cos: (a) => new F(Math.cos(num(a[0]))), tan: (a) => new F(Math.tan(num(a[0]))), atan2: (a) => new F(Math.atan2(num(a[0]), num(a[1]))), floor: (a) => Math.floor(num(a[0])), ceil: (a) => Math.ceil(num(a[0])), pow: (a) => new F(num(a[0]) ** num(a[1])), pi: new F(Math.PI), e: new F(Math.E) }),
        gc: mod({ collect: () => null, mem_free: () => 190000, mem_alloc: () => 12000 }),
        ubinascii: mod({}),
      },
    }
    const it = new Interp(host)
    it.globals.vars.set('open', (a: Value[]) => fileObj(abs(String(a[0])), String(a[1] ?? 'r')))
    return it
  }

  list(dir: string): { name: string; dir: boolean; size: number }[] {
    const d = dir === '/' ? '/' : dir.replace(/\/$/, '') + '/'
    const out: { name: string; dir: boolean; size: number }[] = []
    for (const [p, c] of this.fs) if (p.startsWith(d) && !p.slice(d.length).includes('/')) out.push({ name: p.slice(d.length), dir: false, size: c.length })
    for (const p of this.dirs) if (p !== '/' && p.startsWith(d) && !p.slice(d.length).includes('/')) out.push({ name: p.slice(d.length), dir: true, size: 0 })
    return out
  }

  async write(data: Uint8Array): Promise<void> {
    for (const b of data) this.feed(String.fromCharCode(b))
  }
  async close(): Promise<void> {
    this.closed = true
    this.interp.interrupted = true
  }

  // ------------------------------------------------------------------------------------------ input state machine
  private feed(c: string): void {
    if (c === CTRL_C) return this.ctrlC()
    if (this.mode === 'raw') return this.feedRaw(c)
    if (this.running) return
    if (this.mode === 'paste') return this.feedPaste(c)
    switch (c) {
      case '\x01': this.mode = 'raw'; this.rawBuf = ''; this.out('\r\nraw REPL; CTRL-B to exit\r\n>'); return
      case '\x02': this.out('\r\n' + BANNER + '>>> '); return
      case '\x04': this.softReset(); return
      case '\x05': this.mode = 'paste'; this.pasteBuf = ''; this.out('\r\npaste mode; Ctrl-C to cancel, Ctrl-D to finish\r\n=== '); return
      case '\r': case '\n': this.enter(); return
      case '\x7f': case '\b': if (this.line) { this.line = this.line.slice(0, -1); this.out('\b\x1b[K') } return
      default: if (c >= ' ') { this.line += c; this.out(c) }
    }
  }

  private softReset(): void {
    this.interp = this.newInterp()
    this.line = ''
    this.block = []
    this.out('MPY: soft reboot\r\n' + BANNER + '>>> ')
  }

  private ctrlC(): void {
    if (this.running) { this.interp.interrupted = true; return }
    if (this.mode === 'paste') { this.mode = 'friendly'; this.out('\r\n>>> '); return }
    if (this.mode === 'raw') { this.rawBuf = ''; this.paste = { active: false, consumed: 0 }; this.pasteStart = 0; return }
    this.line = ''
    this.block = []
    this.out('\r\nKeyboardInterrupt:\r\n>>> ')
  }

  private enter(): void {
    const line = this.line
    this.line = ''
    this.out('\r\n')
    if (this.block.length) {
      if (line.trim() === '') { const src = this.block.join('\n'); this.block = []; void this.execFriendly(src); return }
      this.block.push(line)
      this.out('... ')
      return
    }
    if (line.trimEnd().endsWith(':')) { this.block.push(line); this.out('... '); return }
    if (line.trim() === '') { this.out('>>> '); return }
    void this.execFriendly(line)
  }

  private async execFriendly(src: string): Promise<void> {
    this.running = true
    try {
      await this.interp.run(src, true)
    } catch (e) {
      if (e instanceof PyError && e.type === 'KeyboardInterrupt') this.out('Traceback (most recent call last):\r\n  File "<stdin>", line 1, in <module>\r\nKeyboardInterrupt: \r\n')
      else this.out(this.interp.fail(e))
    }
    this.running = false
    this.out('>>> ')
  }

  private feedPaste(c: string): void {
    if (c === '\x04') {
      const src = this.pasteBuf
      this.mode = 'friendly'
      this.out('\r\n')
      void this.execFriendly(src)
      return
    }
    if (c === '\r' || c === '\n') { this.pasteBuf += '\n'; this.out('\r\n=== '); return }
    if (c === '\x7f' || c === '\b') { if (this.pasteBuf && !this.pasteBuf.endsWith('\n')) { this.pasteBuf = this.pasteBuf.slice(0, -1); this.out('\b\x1b[K') } return }
    if (c >= ' ') { this.pasteBuf += c; this.out(c) }
  }

  private feedRaw(c: string): void {
    if (this.running) return
    if (this.paste.active) {
      if (c === '\x04') {
        this.paste.active = false
        this.outRaw('\x04')
        const code = this.pasteBuf
        this.pasteBuf = ''
        void this.runRaw(code, false)
        return
      }
      this.pasteBuf += c
      if (++this.paste.consumed % WINDOW === 0) this.outRaw('\x01')
      return
    }
    if (this.pasteStart === 1) { this.pasteStart = c === 'A' ? 2 : 0; if (this.pasteStart === 0) this.rawBuf += '\x05' + c; return }
    if (this.pasteStart === 2) {
      this.pasteStart = 0
      if (c === '\x01') { this.paste = { active: true, consumed: 0 }; this.pasteBuf = ''; this.outRaw('R\x01' + String.fromCharCode(WINDOW & 255, WINDOW >> 8)) }
      return
    }
    switch (c) {
      case '\x01': this.rawBuf = ''; this.out('\r\nraw REPL; CTRL-B to exit\r\n>'); return
      case '\x02': this.mode = 'friendly'; this.out('\r\n' + BANNER + '>>> '); return
      case '\x05': if (this.rawBuf === '') this.pasteStart = 1; else this.rawBuf += c; return
      case '\x04': {
        if (this.rawBuf === '') { this.interp = this.newInterp(); this.out('MPY: soft reboot\r\nraw REPL; CTRL-B to exit\r\n>'); return }
        const code = this.rawBuf
        this.rawBuf = ''
        this.out('OK')
        void this.runRaw(code, false)
        return
      }
      default: this.rawBuf += c
    }
  }

  private async runRaw(code: string, _unused: boolean): Promise<void> {
    void _unused
    this.running = true
    let stderr = ''
    // The interpreter writes stdout through host.write, which streams straight to the transport.
    try {
      const op = readMarker(code)
      if (op) stderr = this.native(op)
      else {
        try { await this.interp.run(code) } catch (e) { stderr = e instanceof PyError && e.type === 'KeyboardInterrupt' ? 'Traceback (most recent call last):\r\n  File "<stdin>", line 1, in <module>\r\nKeyboardInterrupt: \r\n' : this.interp.fail(e) }
      }
    } finally {
      this.running = false
    }
    this.out('\x04' + stderr + '\x04>')
  }

  /** Executes the simulator-side equivalent of the helper snippets built in protocol.ts. Returns stderr text. */
  private native(op: Record<string, unknown>): string {
    const path = String(op.path ?? '/')
    const abs = path.startsWith('/') ? path : '/' + path
    switch (op.op) {
      case 'ls': {
        if (abs !== '/' && !this.dirs.has(abs.replace(/\/$/, ''))) return `Traceback (most recent call last):\r\n  File "<stdin>", line 2, in <module>\r\nOSError: [Errno 2] ENOENT\r\n`
        for (const e of this.list(abs)) this.out(`${e.name}|${e.dir ? 0x4000 : 0x8000}|${e.size}\r\n`)
        return ''
      }
      case 'write': {
        const bytes = latin1(fromHex(String(op.hex)))
        this.fs.set(abs, (op.append ? (this.fs.get(abs) ?? '') : '') + bytes)
        const dir = abs.slice(0, abs.lastIndexOf('/'))
        if (dir && !this.dirs.has(dir)) return `Traceback (most recent call last):\r\n  File "<stdin>", line 2, in <module>\r\nOSError: [Errno 2] ENOENT\r\n`
        return ''
      }
      case 'read': {
        const c = this.fs.get(abs)
        if (c === undefined) return `Traceback (most recent call last):\r\n  File "<stdin>", line 2, in <module>\r\nOSError: [Errno 2] ENOENT\r\n`
        for (let i = 0; i < c.length; i += 256) this.out(toHex(enc(c.slice(i, i + 256))) + '\r\n')
        return ''
      }
      case 'rm': {
        if (op.dir) this.dirs.delete(abs)
        else if (!this.fs.delete(abs)) return `Traceback (most recent call last):\r\n  File "<stdin>", line 2, in <module>\r\nOSError: [Errno 2] ENOENT\r\n`
        return ''
      }
      case 'mkdir': this.dirs.add(abs); return ''
    }
    return ''
  }
}
