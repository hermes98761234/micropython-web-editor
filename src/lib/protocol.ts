/** MicroPython raw REPL protocol helpers: byte reader, code builders and listing parsers. */

export const CTRL_A = '\x01'
export const CTRL_B = '\x02'
export const CTRL_C = '\x03'
export const CTRL_D = '\x04'
export const CTRL_E = '\x05'

export interface Transport {
  /** Called with raw bytes from the device. */
  onData: ((data: Uint8Array) => void) | null
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
}

export const enc = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)
export const latin1 = (b: Uint8Array): string => { let s = ''; for (const x of b) s += String.fromCharCode(x); return s }
export const utf8Bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

export class TimeoutError extends Error {}

/** Buffers latin-1 text arriving from the device and lets protocol code wait for markers. */
export class Reader {
  buf = ''
  private waiter: (() => void) | null = null
  push(s: string): void {
    this.buf += s
    this.waiter?.()
  }
  clear(): void {
    this.buf = ''
  }
  private wait(ms: number | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = ms ? setTimeout(() => { this.waiter = null; reject(new TimeoutError('timeout')) }, ms) : null
      this.waiter = () => { if (t) clearTimeout(t); this.waiter = null; resolve() }
    })
  }
  /** Waits for `n` characters. */
  async take(n: number, timeout?: number): Promise<string> {
    while (this.buf.length < n) await this.wait(timeout)
    const r = this.buf.slice(0, n)
    this.buf = this.buf.slice(n)
    return r
  }
  /** Reads up to and including `marker`. `onPartial` receives data as it arrives (excluding the marker). */
  async until(marker: string, timeout?: number, onPartial?: (s: string) => void): Promise<string> {
    let emitted = 0
    for (;;) {
      const i = this.buf.indexOf(marker)
      if (i >= 0) {
        const r = this.buf.slice(0, i + marker.length)
        if (onPartial && i > emitted) onPartial(this.buf.slice(emitted, i))
        this.buf = this.buf.slice(i + marker.length)
        return r
      }
      if (onPartial) {
        const safe = Math.max(emitted, this.buf.length - (marker.length - 1))
        if (safe > emitted) { onPartial(this.buf.slice(emitted, safe)); emitted = safe }
      }
      await this.wait(timeout)
    }
  }
}

/** Python string literal for a path or name (JSON strings are valid Python literals). */
export const pyStringLiteral = (s: string): string => JSON.stringify(s)

const marker = (o: Record<string, unknown>): string => `# mpweb:${JSON.stringify(o)}\n`

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export function fromHex(h: string): Uint8Array {
  const clean = h.replace(/[^0-9a-fA-F]/g, '')
  const out = new Uint8Array(Math.floor(clean.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const buildList = (dir: string): string =>
  marker({ op: 'ls', path: dir }) + `import os\nfor e in os.ilistdir(${pyStringLiteral(dir)}):\n print("%s|%d|%d" % (e[0], e[1], e[3] if len(e) > 3 else 0))\n`

export const buildWrite = (path: string, chunk: Uint8Array, append: boolean): string =>
  marker({ op: 'write', path, append, hex: toHex(chunk) }) + `import ubinascii\nf = open(${pyStringLiteral(path)}, '${append ? 'ab' : 'wb'}')\nf.write(ubinascii.unhexlify('${toHex(chunk)}'))\nf.close()\n`

export const buildRead = (path: string): string =>
  marker({ op: 'read', path }) + `import ubinascii\nf = open(${pyStringLiteral(path)}, 'rb')\nwhile True:\n b = f.read(256)\n if not b:\n  break\n print(ubinascii.hexlify(b).decode())\nf.close()\n`

export const buildDelete = (path: string, isDir: boolean): string =>
  marker({ op: 'rm', path, dir: isDir }) + `import os\nos.${isDir ? 'rmdir' : 'remove'}(${pyStringLiteral(path)})\n`

export const buildMkdir = (path: string): string => marker({ op: 'mkdir', path }) + `import os\nos.mkdir(${pyStringLiteral(path)})\n`

export interface Entry {
  name: string
  dir: boolean
  size: number
}

export function parseListing(out: string): Entry[] {
  const entries: Entry[] = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.*)\|(\d+)\|(\d+)$/.exec(line)
    if (m) entries.push({ name: m[1], dir: (+m[2] & 0x4000) !== 0, size: +m[3] })
  }
  return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
}

export function parseHexLines(out: string): Uint8Array {
  return fromHex(out.split(/\r?\n/).filter((l) => /^[0-9a-fA-F]+$/.test(l.trim())).join(''))
}

export const joinPath = (dir: string, name: string): string => (dir === '/' || dir === '' ? '/' + name : dir.replace(/\/$/, '') + '/' + name)

export function chunkBytes(b: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < b.length; i += size) out.push(b.slice(i, i + size))
  return out.length ? out : [new Uint8Array(0)]
}

/** Splits a command into the "marker + code" pieces and returns the marker JSON if present (used by the simulator). */
export function readMarker(code: string): Record<string, unknown> | null {
  const m = /^# mpweb:(\{.*\})\n/.exec(code)
  if (!m) return null
  try { return JSON.parse(m[1]) as Record<string, unknown> } catch { return null }
}
