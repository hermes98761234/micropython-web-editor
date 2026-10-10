/** A very small terminal emulator: handles CR, LF, backspace and the few CSI sequences MicroPython's REPL emits. */
export class Term {
  lines: string[] = ['']
  row = 0
  col = 0
  maxLines: number
  private pending = ''
  constructor(maxLines = 2000) {
    this.maxLines = maxLines
  }

  write(s: string): void {
    const input = this.pending + s
    this.pending = ''
    for (let i = 0; i < input.length; i++) {
      const c = input[i]
      if (c === '\x1b') {
        if (i + 1 >= input.length) { this.pending = input.slice(i); return }
        if (input[i + 1] === '[') {
          let j = i + 2
          while (j < input.length && /[0-9;?]/.test(input[j])) j++
          if (j >= input.length) { this.pending = input.slice(i); return }
          this.csi(input.slice(i + 2, j), input[j])
          i = j
        } else i++
        continue
      }
      if (c === '\r') this.col = 0
      else if (c === '\n') { this.newline(); this.col = 0 }
      else if (c === '\b') this.col = Math.max(0, this.col - 1)
      else if (c === '\x07' || c === '\0') continue
      else if (c === '\t') this.put(' '.repeat(8 - (this.col % 8)))
      else if (c >= ' ') this.put(c)
    }
  }

  private put(s: string): void {
    const line = this.lines[this.row]
    const padded = line.length < this.col ? line + ' '.repeat(this.col - line.length) : line
    this.lines[this.row] = padded.slice(0, this.col) + s + padded.slice(this.col + s.length)
    this.col += s.length
  }

  private newline(): void {
    this.row++
    if (this.row >= this.lines.length) this.lines.push('')
    if (this.lines.length > this.maxLines) { this.lines.shift(); this.row-- }
  }

  private csi(params: string, cmd: string): void {
    const n = parseInt(params, 10)
    if (cmd === 'K') {
      if (!params || n === 0) this.lines[this.row] = this.lines[this.row].slice(0, this.col)
      else if (n === 2) this.lines[this.row] = ''
    } else if (cmd === 'D') this.col = Math.max(0, this.col - (Number.isNaN(n) ? 1 : n))
    else if (cmd === 'C') this.col += Number.isNaN(n) ? 1 : n
  }

  clear(): void {
    this.lines = ['']
    this.row = 0
    this.col = 0
  }

  get text(): string {
    return this.lines.join('\n')
  }
}
