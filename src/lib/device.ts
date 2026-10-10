import { buildDelete, buildList, buildMkdir, buildRead, buildWrite, chunkBytes, CTRL_A, CTRL_B, CTRL_C, CTRL_D, CTRL_E, enc, latin1, parseHexLines, parseListing, Reader, utf8Bytes, type Entry, type Transport } from './protocol'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface ExecResult {
  stdout: string
  stderr: string
}

/** Host side of a MicroPython board: terminal passthrough plus raw REPL operations. */
export class Device {
  transport: Transport
  /** Text for the terminal (decoded UTF-8). */
  onText: (s: string) => void
  onBusy: (busy: boolean) => void = () => {}
  private reader = new Reader()
  private capturing = false
  private dec = new TextDecoder('utf-8')
  private chain: Promise<unknown> = Promise.resolve()
  busy = false

  constructor(transport: Transport, onText: (s: string) => void) {
    this.transport = transport
    this.onText = onText
    transport.onData = (d) => {
      if (this.capturing) this.reader.push(latin1(d))
      else this.onText(this.dec.decode(d, { stream: true }))
    }
  }

  /** Interrupts whatever is running and shows the friendly REPL banner. */
  async start(): Promise<void> {
    await this.transport.write(enc('\r' + CTRL_C + CTRL_C))
    await sleep(80)
    await this.transport.write(enc(CTRL_B))
  }

  async close(): Promise<void> {
    await this.transport.close()
  }

  /** Keystrokes typed in the terminal. Ignored while a raw operation owns the line. */
  async sendInput(s: string): Promise<void> {
    if (this.capturing) { if (s.includes(CTRL_C)) await this.transport.write(enc(CTRL_C)); return }
    await this.transport.write(utf8Bytes(s))
  }

  interrupt(): Promise<void> {
    return this.transport.write(enc(CTRL_C))
  }

  async softReset(): Promise<void> {
    if (this.capturing) await this.transport.write(enc(CTRL_C))
    await this.queue(async () => { await this.transport.write(enc(CTRL_C + CTRL_C + CTRL_D)) })
  }

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      this.busy = true
      this.onBusy(true)
      try { return await fn() } finally { this.busy = false; this.onBusy(false) }
    })
    this.chain = run.catch(() => {})
    return run
  }

  private async withRaw<T>(fn: () => Promise<T>): Promise<T> {
    this.reader.clear()
    this.capturing = true
    try {
      await this.transport.write(enc('\r' + CTRL_C + CTRL_C))
      await sleep(60)
      this.reader.clear()
      await this.transport.write(enc('\r' + CTRL_A))
      await this.reader.until('raw REPL; CTRL-B to exit\r\n>', 4000)
      return await fn()
    } finally {
      await this.transport.write(enc(CTRL_B))
      await sleep(20)
      this.capturing = false
    }
  }

  /** Runs code in the (already entered) raw REPL, preferring raw-paste mode. */
  private async execRaw(code: string, onStdout?: (s: string) => void): Promise<ExecResult> {
    const cs = latin1(utf8Bytes(code))
    const r = this.reader
    let pasted = false
    await this.transport.write(enc(CTRL_E + 'A' + CTRL_A))
    const head = await r.take(2, 2000)
    if (head === 'R\x01') {
      const w = await r.take(2, 2000)
      const window = w.charCodeAt(0) | (w.charCodeAt(1) << 8)
      let remain = window
      let i = 0
      let early = false
      while (i < cs.length && !early) {
        while (remain === 0 || r.buf.length > 0) {
          const b = await r.take(1, 5000)
          if (b === '\x01') remain += window
          else if (b === '\x04') { await this.transport.write(enc(CTRL_D)); early = true; break }
        }
        if (early) break
        const n = Math.min(remain, cs.length - i)
        await this.transport.write(enc(cs.slice(i, i + n)))
        i += n
        remain -= n
      }
      if (!early) {
        await this.transport.write(enc(CTRL_D))
        await r.until('\x04', 5000)
      }
      pasted = true
    }
    if (!pasted) {
      // Legacy raw REPL: send code in small pieces, then Ctrl-D, expect "OK".
      if (head !== 'R\x00') r.buf = head + r.buf
      for (let i = 0; i < cs.length; i += 256) { await this.transport.write(enc(cs.slice(i, i + 256))); await sleep(8) }
      await this.transport.write(enc(CTRL_D))
      await r.until('OK', 5000)
    }
    const dec = new TextDecoder('utf-8')
    let out = ''
    await r.until('\x04', undefined, (chunk) => { const t = dec.decode(enc(chunk), { stream: true }); out += t; onStdout?.(t) })
    const err = await r.until('\x04', 10000)
    await r.take(1, 3000) // the raw REPL prompt '>'
    return { stdout: out, stderr: new TextDecoder('utf-8').decode(enc(err.slice(0, -1))) }
  }

  /** Runs a script and streams its output to the terminal. */
  run(code: string): Promise<ExecResult> {
    return this.queue(() =>
      this.withRaw(async () => {
        const res = await this.execRaw(code, (s) => this.onText(s))
        if (res.stderr) this.onText(res.stderr)
        return res
      }),
    )
  }

  private async exec(code: string): Promise<string> {
    const res = await this.execRaw(code)
    if (res.stderr.trim()) throw new Error(res.stderr.trim().split(/\r?\n/).pop())
    return res.stdout
  }

  list(dir: string): Promise<Entry[]> {
    return this.queue(() => this.withRaw(async () => parseListing(await this.exec(buildList(dir)))))
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.queue(() => this.withRaw(async () => parseHexLines(await this.exec(buildRead(path)))))
  }

  writeFile(path: string, data: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<void> {
    return this.queue(() =>
      this.withRaw(async () => {
        const chunks = chunkBytes(data, 256)
        let done = 0
        for (let i = 0; i < chunks.length; i++) {
          await this.exec(buildWrite(path, chunks[i], i > 0))
          done += chunks[i].length
          onProgress?.(done, data.length)
        }
      }),
    )
  }

  remove(path: string, isDir: boolean): Promise<void> {
    return this.queue(() => this.withRaw(async () => { await this.exec(buildDelete(path, isDir)) }))
  }

  mkdir(path: string): Promise<void> {
    return this.queue(() => this.withRaw(async () => { await this.exec(buildMkdir(path)) }))
  }
}
