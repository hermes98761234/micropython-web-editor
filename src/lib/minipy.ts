/**
 * A tiny Python subset interpreter used by the simulated board. It supports enough of the language
 * (expressions, f-strings, if/while/for, def, lists, dicts) and a few MicroPython modules to make the demo useful.
 */

export class PyError extends Error {
  type: string
  constructor(type: string, msg: string) {
    super(msg)
    this.type = type
  }
}

export class F {
  v: number
  constructor(v: number) {
    this.v = v
  }
}
export class PyTuple {
  items: Value[]
  constructor(items: Value[]) {
    this.items = items
  }
}
export type Value = number | string | boolean | null | F | PyTuple | Value[] | Map<Value, Value> | PyFunc | Native | PyObj | undefined
type Native = (args: Value[]) => Value | Promise<Value>
export interface PyObj {
  pyName: string
  getattr(name: string): Value
  strOf?(): string
}
export class PyFunc {
  name: string
  params: { name: string; def?: Expr }[]
  body: Stmt[]
  constructor(name: string, params: { name: string; def?: Expr }[], body: Stmt[]) {
    this.name = name
    this.params = params
    this.body = body
  }
}

// ----------------------------------------------------------------------------------------------- tokens
type Tok = { k: 'num' | 'str' | 'fstr' | 'name' | 'op' | 'nl' | 'indent' | 'dedent' | 'eof'; v: string; line: number }

const OPS3 = ['**=', '//=', '>>=', '<<=']
const OPS2 = ['==', '!=', '<=', '>=', '**', '//', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '->']

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const indents = [0]
  let depth = 0
  let i = 0
  let lineNo = 0
  const text = lines.join('\n')
  let pos = 0
  let atLineStart = true
  void i
  while (pos < text.length) {
    if (atLineStart && depth === 0) {
      let col = 0
      let p = pos
      while (p < text.length && (text[p] === ' ' || text[p] === '\t')) { col += text[p] === '\t' ? 8 : 1; p++ }
      if (text[p] === '\n' || text[p] === '#' || p >= text.length) {
        // blank or comment line
        while (p < text.length && text[p] !== '\n') p++
        pos = p + 1
        lineNo++
        continue
      }
      pos = p
      if (col > indents[indents.length - 1]) { indents.push(col); toks.push({ k: 'indent', v: '', line: lineNo + 1 }) }
      while (col < indents[indents.length - 1]) {
        indents.pop()
        toks.push({ k: 'dedent', v: '', line: lineNo + 1 })
        if (col > indents[indents.length - 1]) throw new PyError('IndentationError', 'unindent does not match any outer indentation level')
      }
      atLineStart = false
    }
    const c = text[pos]
    const line = lineNo + 1
    if (c === '\n') {
      pos++
      lineNo++
      if (depth === 0) { toks.push({ k: 'nl', v: '', line }); atLineStart = true }
      continue
    }
    if (c === ' ' || c === '\t') { pos++; continue }
    if (c === '#') { while (pos < text.length && text[pos] !== '\n') pos++; continue }
    if (c === '\\' && text[pos + 1] === '\n') { pos += 2; lineNo++; continue }
    // strings (with optional prefix)
    const m = /^([fFbBrRuU]{0,2})('''|"""|'|")/.exec(text.slice(pos, pos + 5))
    if (m && (m[1] === '' || /^[fFbBrRuU]+$/.test(m[1]))) {
      const prefix = m[1].toLowerCase()
      const q = m[2]
      let p = pos + m[0].length
      let out = ''
      while (p < text.length && !text.startsWith(q, p)) {
        if (text[p] === '\\' && !prefix.includes('r')) {
          const n = text[p + 1]
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' }
          if (n === 'x') { out += String.fromCharCode(parseInt(text.slice(p + 2, p + 4), 16)); p += 4; continue }
          if (n === '\n') { p += 2; lineNo++; continue }
          out += map[n] ?? '\\' + n
          p += 2
          continue
        }
        if (text[p] === '\n') {
          if (q.length === 1) throw new PyError('SyntaxError', 'invalid syntax')
          lineNo++
        }
        out += text[p++]
      }
      if (p >= text.length) throw new PyError('SyntaxError', 'invalid syntax')
      pos = p + q.length
      toks.push({ k: prefix.includes('f') ? 'fstr' : 'str', v: out, line })
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[pos + 1] ?? ''))) {
      const mm = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(\d[\d_]*)?\.?\d*([eE][+-]?\d+)?)/.exec(text.slice(pos))!
      toks.push({ k: 'num', v: mm[0].replace(/_/g, ''), line })
      pos += mm[0].length
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const mm = /^[A-Za-z_][A-Za-z_0-9]*/.exec(text.slice(pos))!
      toks.push({ k: 'name', v: mm[0], line })
      pos += mm[0].length
      continue
    }
    const o3 = text.slice(pos, pos + 3)
    const o2 = text.slice(pos, pos + 2)
    const op = OPS3.includes(o3) ? o3 : OPS2.includes(o2) ? o2 : c
    if (!/^(\*\*=|\/\/=|>>=|<<=|==|!=|<=|>=|\*\*|\/\/|[+\-*/%&|^]=|<<|>>|->|[-+*/%<>=()[\]{},:.;~&|^@!])$/.test(op)) throw new PyError('SyntaxError', 'invalid syntax')
    if ('([{'.includes(op)) depth++
    if (')]}'.includes(op)) depth = Math.max(0, depth - 1)
    toks.push({ k: 'op', v: op, line })
    pos += op.length
  }
  if (toks.length && toks[toks.length - 1].k !== 'nl') toks.push({ k: 'nl', v: '', line: lineNo + 1 })
  while (indents.length > 1) { indents.pop(); toks.push({ k: 'dedent', v: '', line: lineNo + 1 }) }
  toks.push({ k: 'eof', v: '', line: lineNo + 1 })
  return toks
}

// ----------------------------------------------------------------------------------------------- AST
export type Expr =
  | { t: 'num'; v: Value }
  | { t: 'str'; v: string }
  | { t: 'fstr'; parts: (string | Expr)[] }
  | { t: 'name'; n: string; line: number }
  | { t: 'list'; items: Expr[] }
  | { t: 'tuple'; items: Expr[] }
  | { t: 'dict'; pairs: [Expr, Expr][] }
  | { t: 'un'; op: string; e: Expr }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'logic'; op: 'and' | 'or'; l: Expr; r: Expr }
  | { t: 'cond'; c: Expr; a: Expr; b: Expr }
  | { t: 'call'; fn: Expr; args: Expr[]; kw: [string, Expr][] }
  | { t: 'attr'; o: Expr; n: string }
  | { t: 'idx'; o: Expr; i: Expr }
  | { t: 'slice'; o: Expr; a: Expr | null; b: Expr | null }

export type Stmt = { line: number } & (
  | { s: 'expr'; e: Expr }
  | { s: 'assign'; targets: Expr[]; v: Expr }
  | { s: 'aug'; target: Expr; op: string; v: Expr }
  | { s: 'if'; c: Expr; body: Stmt[]; orelse: Stmt[] }
  | { s: 'while'; c: Expr; body: Stmt[] }
  | { s: 'for'; names: string[]; it: Expr; body: Stmt[] }
  | { s: 'def'; name: string; params: { name: string; def?: Expr }[]; body: Stmt[] }
  | { s: 'return'; e: Expr | null }
  | { s: 'pass' }
  | { s: 'global'; names: string[] }
  | { s: 'raise'; e: Expr | null }
  | { s: 'with'; e: Expr; as: string | null; body: Stmt[] }
  | { s: 'try'; body: Stmt[]; handlers: { types: string[]; as: string | null; body: Stmt[] }[]; orelse: Stmt[]; fin: Stmt[] }
  | { s: 'break' }
  | { s: 'continue' }
  | { s: 'import'; mod: string; as: string }
  | { s: 'from'; mod: string; names: [string, string][] }
)

class Parser {
  toks: Tok[]
  p = 0
  constructor(toks: Tok[]) {
    this.toks = toks
  }
  get cur(): Tok { return this.toks[this.p] }
  err(): never { throw new PyError('SyntaxError', 'invalid syntax') }
  isOp(v: string): boolean { return this.cur.k === 'op' && this.cur.v === v }
  isKw(v: string): boolean { return this.cur.k === 'name' && this.cur.v === v }
  eatOp(v: string): boolean { if (this.isOp(v)) { this.p++; return true } return false }
  eatKw(v: string): boolean { if (this.isKw(v)) { this.p++; return true } return false }
  expectOp(v: string): void { if (!this.eatOp(v)) this.err() }

  program(): Stmt[] {
    const out: Stmt[] = []
    while (this.cur.k !== 'eof') {
      if (this.cur.k === 'nl') { this.p++; continue }
      out.push(...this.statement())
    }
    return out
  }

  block(): Stmt[] {
    this.expectOp(':')
    if (this.cur.k === 'nl') {
      this.p++
      if ((this.cur as Tok).k !== 'indent') throw new PyError('IndentationError', 'expected an indented block')
      this.p++
      const body: Stmt[] = []
      while ((this.cur as Tok).k !== 'dedent' && (this.cur as Tok).k !== 'eof') {
        if ((this.cur as Tok).k === 'nl') { this.p++; continue }
        body.push(...this.statement())
      }
      if ((this.cur as Tok).k === 'dedent') this.p++
      return body
    }
    return this.simpleLine()
  }

  statement(): Stmt[] {
    const t = this.cur
    const line = t.line
    if (t.k === 'name') {
      if (t.v === 'if') return [this.ifStmt()]
      if (t.v === 'while') { this.p++; const c = this.expr(); return [{ s: 'while', c, body: this.block(), line }] }
      if (t.v === 'for') {
        this.p++
        const names: string[] = []
        do { if (this.cur.k !== 'name') this.err(); names.push(this.cur.v); this.p++ } while (this.eatOp(','))
        if (!this.eatKw('in')) this.err()
        const it = this.expr()
        return [{ s: 'for', names, it, body: this.block(), line }]
      }
      if (t.v === 'with') {
        this.p++
        const e = this.expr()
        let as: string | null = null
        if (this.eatKw('as')) { as = this.cur.v; this.p++ }
        return [{ s: 'with', e, as, body: this.block(), line }]
      }
      if (t.v === 'try') {
        this.p++
        const body = this.block()
        const handlers: { types: string[]; as: string | null; body: Stmt[] }[] = []
        let orelse: Stmt[] = []
        let fin: Stmt[] = []
        while (this.isKw('except')) {
          this.p++
          const types: string[] = []
          let as: string | null = null
          if (!this.isOp(':')) {
            const ex = this.expr()
            const names = (x: Expr): string[] => (x.t === 'name' ? [x.n] : x.t === 'tuple' ? x.items.flatMap(names) : [])
            types.push(...names(ex))
            if (this.eatKw('as')) { as = this.cur.v; this.p++ }
          }
          handlers.push({ types, as, body: this.block() })
        }
        if (this.eatKw('else')) orelse = this.block()
        if (this.eatKw('finally')) fin = this.block()
        return [{ s: 'try', body, handlers, orelse, fin, line }]
      }
      if (t.v === 'def') {
        this.p++
        const name = this.cur.v
        this.p++
        this.expectOp('(')
        const params: { name: string; def?: Expr }[] = []
        while (!this.isOp(')')) {
          const pn = this.cur.v
          this.p++
          params.push(this.eatOp('=') ? { name: pn, def: this.expr() } : { name: pn })
          if (!this.eatOp(',')) break
        }
        this.expectOp(')')
        return [{ s: 'def', name, params, body: this.block(), line }]
      }
    }
    return this.simpleLine()
  }

  ifStmt(): Stmt {
    const line = this.cur.line
    this.p++
    const c = this.expr()
    const body = this.block()
    let orelse: Stmt[] = []
    if (this.isKw('elif')) orelse = [this.ifStmt()]
    else if (this.eatKw('else')) orelse = this.block()
    return { s: 'if', c, body, orelse, line }
  }

  simpleLine(): Stmt[] {
    const out: Stmt[] = [this.simple()]
    while (this.eatOp(';')) { if (this.cur.k === 'nl') break; out.push(this.simple()) }
    if (this.cur.k !== 'nl' && this.cur.k !== 'eof') this.err()
    if (this.cur.k === 'nl') this.p++
    return out
  }

  simple(): Stmt {
    const t = this.cur
    const line = t.line
    if (t.k === 'name') {
      switch (t.v) {
        case 'pass': this.p++; return { s: 'pass', line }
        case 'raise': { this.p++; const e = this.cur.k === 'nl' ? null : this.expr(); return { s: 'raise', e, line } }
        case 'break': this.p++; return { s: 'break', line }
        case 'continue': this.p++; return { s: 'continue', line }
        case 'return': { this.p++; const e = this.cur.k === 'nl' || this.isOp(';') ? null : this.exprList(); return { s: 'return', e, line } }
        case 'global': case 'nonlocal': { this.p++; const names: string[] = []; while (this.cur.k === 'name' || this.isOp(',')) { if (this.cur.k === 'name') names.push(this.cur.v); this.p++ } return { s: 'global', names, line } }
        case 'import': {
          this.p++
          let mod = this.cur.v
          this.p++
          while (this.eatOp('.')) { mod += '.' + this.cur.v; this.p++ }
          let as = mod
          if (this.eatKw('as')) { as = this.cur.v; this.p++ }
          return { s: 'import', mod, as, line }
        }
        case 'from': {
          this.p++
          let mod = this.cur.v
          this.p++
          while (this.eatOp('.')) { mod += '.' + this.cur.v; this.p++ }
          if (!this.eatKw('import')) this.err()
          const names: [string, string][] = []
          if (this.eatOp('*')) names.push(['*', '*'])
          else do { const n = this.cur.v; this.p++; let a = n; if (this.eatKw('as')) { a = this.cur.v; this.p++ } names.push([n, a]) } while (this.eatOp(','))
          return { s: 'from', mod, names, line }
        }
      }
    }
    const e = this.exprList()
    if (this.isOp('=')) {
      const targets = [e]
      let v: Expr = e
      while (this.eatOp('=')) { v = this.exprList(); targets.push(v) }
      targets.pop()
      return { s: 'assign', targets, v, line }
    }
    if (this.cur.k === 'op' && /^(\*\*|\/\/|>>|<<|[+\-*/%&|^])=$/.test(this.cur.v)) {
      const op = this.cur.v.slice(0, -1)
      this.p++
      return { s: 'aug', target: e, op, v: this.exprList(), line }
    }
    return { s: 'expr', e, line }
  }

  exprList(): Expr {
    const first = this.expr()
    if (!this.isOp(',')) return first
    const items = [first]
    while (this.eatOp(',')) { if (this.cur.k === 'nl' || this.isOp('=') || this.isOp(')')) break; items.push(this.expr()) }
    return { t: 'tuple', items }
  }

  expr(): Expr {
    const a = this.orTest()
    if (this.isKw('if')) {
      this.p++
      const c = this.orTest()
      if (!this.eatKw('else')) this.err()
      return { t: 'cond', c, a, b: this.expr() }
    }
    return a
  }
  orTest(): Expr { let l = this.andTest(); while (this.eatKw('or')) l = { t: 'logic', op: 'or', l, r: this.andTest() }; return l }
  andTest(): Expr { let l = this.notTest(); while (this.eatKw('and')) l = { t: 'logic', op: 'and', l, r: this.notTest() }; return l }
  notTest(): Expr { if (this.eatKw('not')) return { t: 'un', op: 'not', e: this.notTest() }; return this.comparison() }
  comparison(): Expr {
    let l = this.bitor()
    for (;;) {
      let op: string | null = null
      if (this.cur.k === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(this.cur.v)) { op = this.cur.v; this.p++ }
      else if (this.isKw('in')) { op = 'in'; this.p++ }
      else if (this.isKw('not') && this.toks[this.p + 1]?.v === 'in') { op = 'not in'; this.p += 2 }
      else if (this.isKw('is')) { this.p++; op = this.eatKw('not') ? 'is not' : 'is' }
      if (!op) return l
      l = { t: 'bin', op, l, r: this.bitor() }
    }
  }
  level(next: () => Expr, ops: string[]): Expr {
    let l = next()
    while (this.cur.k === 'op' && ops.includes(this.cur.v)) { const op = this.cur.v; this.p++; l = { t: 'bin', op, l, r: next() } }
    return l
  }
  bitor(): Expr { return this.level(() => this.bitxor(), ['|']) }
  bitxor(): Expr { return this.level(() => this.bitand(), ['^']) }
  bitand(): Expr { return this.level(() => this.shift(), ['&']) }
  shift(): Expr { return this.level(() => this.arith(), ['<<', '>>']) }
  arith(): Expr { return this.level(() => this.term(), ['+', '-']) }
  term(): Expr { return this.level(() => this.factor(), ['*', '/', '//', '%']) }
  factor(): Expr {
    if (this.cur.k === 'op' && ['-', '+', '~'].includes(this.cur.v)) { const op = this.cur.v; this.p++; return { t: 'un', op, e: this.factor() } }
    return this.power()
  }
  power(): Expr {
    const b = this.postfix()
    if (this.eatOp('**')) return { t: 'bin', op: '**', l: b, r: this.factor() }
    return b
  }
  postfix(): Expr {
    let e = this.atom()
    for (;;) {
      if (this.eatOp('(')) {
        const args: Expr[] = []
        const kw: [string, Expr][] = []
        while (!this.isOp(')')) {
          if (this.cur.k === 'name' && this.toks[this.p + 1]?.v === '=' && this.toks[this.p + 1].k === 'op') { const n = this.cur.v; this.p += 2; kw.push([n, this.expr()]) }
          else args.push(this.expr())
          if (!this.eatOp(',')) break
        }
        this.expectOp(')')
        e = { t: 'call', fn: e, args, kw }
      } else if (this.eatOp('.')) {
        if (this.cur.k !== 'name') this.err()
        e = { t: 'attr', o: e, n: this.cur.v }
        this.p++
      } else if (this.eatOp('[')) {
        let a: Expr | null = null
        if (!this.isOp(':')) a = this.expr()
        if (this.eatOp(':')) {
          const b = this.isOp(']') ? null : this.expr()
          this.expectOp(']')
          e = { t: 'slice', o: e, a, b }
        } else {
          this.expectOp(']')
          e = { t: 'idx', o: e, i: a! }
        }
      } else return e
    }
  }
  atom(): Expr {
    const t = this.cur
    this.p++
    if (t.k === 'num') {
      const v = t.v
      if (/^0[xX]/.test(v)) return { t: 'num', v: parseInt(v, 16) }
      if (/^0[bB]/.test(v)) return { t: 'num', v: parseInt(v.slice(2), 2) }
      if (/^0[oO]/.test(v)) return { t: 'num', v: parseInt(v.slice(2), 8) }
      return { t: 'num', v: /[.eE]/.test(v) ? new F(parseFloat(v)) : parseInt(v, 10) }
    }
    if (t.k === 'str') {
      let s = t.v
      while (this.cur.k === 'str') { s += this.cur.v; this.p++ }
      return { t: 'str', v: s }
    }
    if (t.k === 'fstr') return this.fstring(t.v)
    if (t.k === 'name') {
      if (t.v === 'True') return { t: 'num', v: true }
      if (t.v === 'False') return { t: 'num', v: false }
      if (t.v === 'None') return { t: 'num', v: null }
      if (['if', 'else', 'elif', 'while', 'for', 'in', 'def', 'return', 'import', 'from', 'and', 'or', 'not', 'is', 'try', 'except', 'finally', 'with', 'raise'].includes(t.v)) this.err()
      return { t: 'name', n: t.v, line: t.line }
    }
    if (t.k === 'op') {
      if (t.v === '(') {
        if (this.eatOp(')')) return { t: 'tuple', items: [] }
        const e = this.expr()
        if (this.isOp(',')) {
          const items = [e]
          while (this.eatOp(',')) { if (this.isOp(')')) break; items.push(this.expr()) }
          this.expectOp(')')
          return { t: 'tuple', items }
        }
        this.expectOp(')')
        return e
      }
      if (t.v === '[') {
        const items: Expr[] = []
        while (!this.isOp(']')) { items.push(this.expr()); if (!this.eatOp(',')) break }
        this.expectOp(']')
        return { t: 'list', items }
      }
      if (t.v === '{') {
        const pairs: [Expr, Expr][] = []
        while (!this.isOp('}')) { const k = this.expr(); this.expectOp(':'); pairs.push([k, this.expr()]); if (!this.eatOp(',')) break }
        this.expectOp('}')
        return { t: 'dict', pairs }
      }
    }
    this.p--
    this.err()
  }
  fstring(src: string): Expr {
    const parts: (string | Expr)[] = []
    let i = 0
    let lit = ''
    while (i < src.length) {
      const c = src[i]
      if (c === '{' && src[i + 1] === '{') { lit += '{'; i += 2; continue }
      if (c === '}' && src[i + 1] === '}') { lit += '}'; i += 2; continue }
      if (c === '{') {
        let d = 1
        let j = i + 1
        while (j < src.length && d > 0) { if (src[j] === '{') d++; if (src[j] === '}') d--; j++ }
        const inner = src.slice(i + 1, j - 1)
        const m = /^(.*?)(?::([^:]*))?$/.exec(inner.replace(/!r$|!s$/, ''))!
        if (lit) { parts.push(lit); lit = '' }
        const sub = new Parser(tokenize(m[1]))
        const ex = sub.expr()
        parts.push(m[2] ? { t: 'call', fn: { t: 'name', n: '__fmt', line: 0 }, args: [ex, { t: 'str', v: m[2] }], kw: [] } : ex)
        i = j
        continue
      }
      lit += c
      i++
    }
    if (lit) parts.push(lit)
    return { t: 'fstr', parts }
  }
}

export function parse(src: string): Stmt[] {
  return new Parser(tokenize(src)).program()
}

// ----------------------------------------------------------------------------------------------- values
const isF = (x: Value): x is F => x instanceof F
export const num = (x: Value): number => (typeof x === 'number' ? x : isF(x) ? x.v : typeof x === 'boolean' ? (x ? 1 : 0) : NaN)
const isNum = (x: Value): boolean => typeof x === 'number' || isF(x) || typeof x === 'boolean'

function floatStr(v: number): string {
  if (Number.isNaN(v)) return 'nan'
  if (!Number.isFinite(v)) return v < 0 ? '-inf' : 'inf'
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return v.toFixed(1)
  return String(parseFloat(v.toPrecision(7)))
}

export function pyRepr(v: Value): string {
  if (typeof v === 'string') return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
  return pyStr(v)
}

export function pyStr(v: Value): string {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v
  if (isF(v)) return floatStr(v.v)
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']'
  if (v instanceof PyTuple) return '(' + v.items.map(pyRepr).join(', ') + (v.items.length === 1 ? ',' : '') + ')'
  if (v instanceof Map) return '{' + [...v.entries()].map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ') + '}'
  if (v instanceof PyFunc) return `<function ${v.name}>`
  if (typeof v === 'function') return '<built-in function>'
  if (v.strOf) return v.strOf()
  return `<${v.pyName} object>`
}

export const truthy = (v: Value): boolean => {
  if (v === null || v === undefined) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v.length > 0
  if (isF(v)) return v.v !== 0
  if (Array.isArray(v)) return v.length > 0
  if (v instanceof PyTuple) return v.items.length > 0
  if (v instanceof Map) return v.size > 0
  return true
}

function typeName(v: Value): string {
  if (v === null || v === undefined) return 'NoneType'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return 'int'
  if (typeof v === 'string') return 'str'
  if (isF(v)) return 'float'
  if (Array.isArray(v)) return 'list'
  if (v instanceof PyTuple) return 'tuple'
  if (v instanceof Map) return 'dict'
  if (typeof v === 'function' || v instanceof PyFunc) return 'function'
  return v.pyName
}

function eq(a: Value, b: Value): boolean {
  if (isNum(a) && isNum(b)) return num(a) === num(b)
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]))
  if (a instanceof PyTuple && b instanceof PyTuple) return eq(a.items, b.items)
  return a === b
}

function cmp(a: Value, b: Value): number {
  if (isNum(a) && isNum(b)) return num(a) - num(b)
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  throw new PyError('TypeError', "unsupported types for comparison: '" + typeName(a) + "', '" + typeName(b) + "'")
}

function iterate(v: Value): Value[] {
  if (Array.isArray(v)) return v
  if (v instanceof PyTuple) return v.items
  if (typeof v === 'string') return [...v]
  if (v instanceof Map) return [...v.keys()]
  throw new PyError('TypeError', "'" + typeName(v) + "' object isn't iterable")
}

function fmtSpec(v: Value, spec: string): string {
  const m = /^([<>^])?(0)?(\d+)?(?:\.(\d+))?([dfxXbeg%s])?$/.exec(spec)
  if (!m) return pyStr(v)
  const [, align, zero, w, prec, type] = m
  let s: string
  const n = num(v)
  if (type === 'f') s = n.toFixed(prec ? +prec : 6)
  else if (type === 'x') s = Math.trunc(n).toString(16)
  else if (type === 'X') s = Math.trunc(n).toString(16).toUpperCase()
  else if (type === 'b') s = Math.trunc(n).toString(2)
  else if (type === 'd') s = String(Math.trunc(n))
  else if (type === 'e') s = n.toExponential(prec ? +prec : 6)
  else if (prec && typeof v !== 'string') s = n.toFixed(+prec)
  else s = pyStr(v)
  const width = w ? +w : 0
  if (s.length < width) {
    const pad = zero && !align ? '0' : ' '
    const right = align === '>' || (!align && (isNum(v) || zero === '0'))
    if (align === '^') { const l = Math.floor((width - s.length) / 2); s = pad.repeat(l) + s + pad.repeat(width - s.length - l) }
    else if (right) s = (zero && s.startsWith('-') ? '-' + '0'.repeat(width - s.length) + s.slice(1) : pad.repeat(width - s.length) + s)
    else s = s + pad.repeat(width - s.length)
  }
  return s
}

// ----------------------------------------------------------------------------------------------- interpreter
class Scope {
  vars = new Map<string, Value>()
  globalNames = new Set<string>()
  parent: Scope | null
  constructor(parent: Scope | null) {
    this.parent = parent
  }
  lookup(n: string): Scope | null {
    for (let s: Scope | null = this; s; s = s.parent) if (s.vars.has(n)) return s
    return null
  }
}

class Return { v: Value; constructor(v: Value) { this.v = v } }
class Break {}
class Continue {}

export interface Host {
  write(s: string): void
  /** Scale factor for time.sleep (0 = instant). */
  sleepScale: number
  modules: Record<string, Record<string, Value>>
}

export class Interp {
  globals = new Scope(null)
  host: Host
  interrupted = false
  frames: string[] = []
  curLine = 0
  constructor(host: Host) {
    this.host = host
    const g = this.globals.vars
    const out = (s: string) => this.host.write(s)
    g.set('print', (args: Value[]) => { out(args.map(pyStr).join(' ') + '\r\n'); return null })
    g.set('range', (a: Value[]) => {
      const [x, y, z] = a.map(num)
      const [s, e, st] = a.length === 1 ? [0, x, 1] : [x, y, z ?? 1]
      const r: Value[] = []
      if (st === 0) throw new PyError('ValueError', 'zero step')
      for (let i = s; st > 0 ? i < e : i > e; i += st) { r.push(i); if (r.length > 1e6) throw new PyError('MemoryError', 'memory allocation failed') }
      return r
    })
    g.set('len', (a: Value[]) => { const v = a[0]; if (typeof v === 'string' || Array.isArray(v)) return v.length; if (v instanceof PyTuple) return v.items.length; if (v instanceof Map) return v.size; throw new PyError('TypeError', "object of type '" + typeName(v) + "' has no len()") })
    g.set('str', (a: Value[]) => pyStr(a[0] ?? ''))
    g.set('repr', (a: Value[]) => pyRepr(a[0]))
    g.set('int', (a: Value[]) => { const v = a[0]; if (typeof v === 'string') { const n = a[1] ? parseInt(v, num(a[1])) : Number(v.trim()); if (!Number.isFinite(n) || v.trim() === '') throw new PyError('ValueError', `invalid literal for int() with base ${a[1] ?? 10}: ${pyRepr(v)}`); return Math.trunc(n) } return Math.trunc(num(v ?? 0)) })
    g.set('float', (a: Value[]) => { const v = a[0]; if (typeof v === 'string') { const n = Number(v.trim()); if (Number.isNaN(n) || v.trim() === '') throw new PyError('ValueError', 'invalid syntax for number'); return new F(n) } return new F(num(v ?? 0)) })
    g.set('bool', (a: Value[]) => truthy(a[0]))
    g.set('abs', (a: Value[]) => (isF(a[0]) ? new F(Math.abs(a[0].v)) : Math.abs(num(a[0]))))
    g.set('min', (a: Value[]) => (a.length === 1 ? iterate(a[0]) : a).reduce((m, x) => (cmp(x, m) < 0 ? x : m)))
    g.set('max', (a: Value[]) => (a.length === 1 ? iterate(a[0]) : a).reduce((m, x) => (cmp(x, m) > 0 ? x : m)))
    g.set('sum', (a: Value[]) => iterate(a[0]).reduce<Value>((s, x) => this.binop('+', s, x), 0))
    g.set('round', (a: Value[]) => { const n = num(a[0]); if (a[1] === undefined) return Math.round(n); const p = 10 ** num(a[1]); return new F(Math.round(n * p) / p) })
    g.set('list', (a: Value[]) => (a.length ? [...iterate(a[0])] : []))
    g.set('tuple', (a: Value[]) => new PyTuple(a.length ? [...iterate(a[0])] : []))
    g.set('dict', () => new Map())
    g.set('sorted', (a: Value[]) => [...iterate(a[0])].sort(cmp))
    g.set('enumerate', (a: Value[]) => iterate(a[0]).map((x, i) => new PyTuple([i, x])))
    g.set('zip', (a: Value[]) => { const ls = a.map(iterate); const n = Math.min(...ls.map((l) => l.length)); return Array.from({ length: n }, (_, i) => new PyTuple(ls.map((l) => l[i]))) })
    g.set('type', (a: Value[]) => `<class '${typeName(a[0])}'>`)
    g.set('chr', (a: Value[]) => String.fromCharCode(num(a[0])))
    g.set('ord', (a: Value[]) => String(a[0]).charCodeAt(0))
    g.set('hex', (a: Value[]) => '0x' + num(a[0]).toString(16))
    g.set('bin', (a: Value[]) => '0b' + num(a[0]).toString(2))
    g.set('isinstance', () => true)
    g.set('input', () => '')
    g.set('help', () => { out('Welcome to MicroPython (simulated board)!\r\nTry: import machine, time, os\r\n'); return null })
    g.set('__fmt', (a: Value[]) => fmtSpec(a[0], String(a[1])))
  }

  async run(src: string, repl = false): Promise<void> {
    const prog = parse(src)
    this.interrupted = false
    try {
      for (let i = 0; i < prog.length; i++) {
        const st = prog[i]
        if (repl && st.s === 'expr') {
          this.curLine = st.line
          const v = await this.eval(st.e, this.globals)
          if (v !== null && v !== undefined) this.host.write(pyRepr(v) + '\r\n')
        } else await this.exec(st, this.globals)
      }
    } catch (e) {
      if (e instanceof Return || e instanceof Break || e instanceof Continue) throw new PyError('SyntaxError', "'return' outside function")
      throw e
    }
  }

  fail(e: unknown): string {
    if (e instanceof PyError) {
      const tb = e.type === 'SyntaxError' || e.type === 'IndentationError' ? '' : `Traceback (most recent call last):\r\n  File "<stdin>", line ${Math.max(1, this.curLine)}, in <module>\r\n`
      return `${tb}${e.type}: ${e.message}\r\n`
    }
    return `Traceback (most recent call last):\r\nException: ${String(e)}\r\n`
  }

  async execBlock(body: Stmt[], sc: Scope): Promise<void> {
    for (const st of body) await this.exec(st, sc)
  }

  async assign(target: Expr, v: Value, sc: Scope): Promise<void> {
    if (target.t === 'name') {
      ;(sc.globalNames.has(target.n) ? this.globals : sc).vars.set(target.n, v)
      return
    }
    if (target.t === 'tuple' || target.t === 'list') {
      const items = iterate(v)
      if (items.length !== target.items.length) throw new PyError('ValueError', `need more than ${items.length} values to unpack`)
      for (let i = 0; i < items.length; i++) await this.assign(target.items[i], items[i], sc)
      return
    }
    if (target.t === 'idx') {
      const o = await this.eval(target.o, sc)
      const i = await this.eval(target.i, sc)
      if (Array.isArray(o)) { const n = num(i); const k = n < 0 ? o.length + n : n; if (k < 0 || k >= o.length) throw new PyError('IndexError', 'list index out of range'); o[k] = v }
      else if (o instanceof Map) o.set(i, v)
      else throw new PyError('TypeError', "'" + typeName(o) + "' object doesn't support item assignment")
      return
    }
    throw new PyError('SyntaxError', "can't assign to expression")
  }

  async exec(st: Stmt, sc: Scope): Promise<void> {
    if (this.interrupted) throw new PyError('KeyboardInterrupt', '')
    this.curLine = st.line
    switch (st.s) {
      case 'expr': await this.eval(st.e, sc); return
      case 'assign': { const v = await this.eval(st.v, sc); for (const t of st.targets) await this.assign(t, v, sc); return }
      case 'aug': { const cur = await this.eval(st.target, sc); await this.assign(st.target, this.binop(st.op, cur, await this.eval(st.v, sc)), sc); return }
      case 'if': if (truthy(await this.eval(st.c, sc))) await this.execBlock(st.body, sc); else await this.execBlock(st.orelse, sc); return
      case 'while':
        while (truthy(await this.eval(st.c, sc))) {
          try { await this.execBlock(st.body, sc) } catch (e) { if (e instanceof Break) break; if (e instanceof Continue) continue; throw e }
          await new Promise((r) => setTimeout(r, 0))
        }
        return
      case 'for': {
        const items = iterate(await this.eval(st.it, sc))
        for (const it of items) {
          if (st.names.length === 1) sc.vars.set(st.names[0], it)
          else { const parts = iterate(it); st.names.forEach((n, i) => sc.vars.set(n, parts[i])) }
          try { await this.execBlock(st.body, sc) } catch (e) { if (e instanceof Break) break; if (e instanceof Continue) continue; throw e }
        }
        return
      }
      case 'def': sc.vars.set(st.name, new PyFunc(st.name, st.params, st.body)); return
      case 'return': throw new Return(st.e ? await this.eval(st.e, sc) : null)
      case 'pass': return
      case 'raise': {
        if (!st.e) throw new PyError('RuntimeError', 'no active exception to reraise')
        if (st.e.t === 'call' && st.e.fn.t === 'name') { const a = st.e.args.length ? pyStr(await this.eval(st.e.args[0], sc)) : ''; throw new PyError(st.e.fn.n, a) }
        if (st.e.t === 'name') throw new PyError(st.e.n, '')
        const v = await this.eval(st.e, sc)
        if (v && typeof v === 'object' && 'excType' in v) throw new PyError((v as unknown as { excType: string }).excType, pyStr(v))
        throw new PyError('TypeError', 'exceptions must derive from BaseException')
      }
      case 'with': {
        const obj = await this.eval(st.e, sc)
        if (st.as) sc.vars.set(st.as, obj)
        try { await this.execBlock(st.body, sc) } finally {
          if (obj && typeof obj === 'object' && 'getattr' in obj) { const c = (obj as PyObj).getattr('close'); if (typeof c === 'function') await c([]) }
        }
        return
      }
      case 'try': {
        try {
          try {
            await this.execBlock(st.body, sc)
            await this.execBlock(st.orelse, sc)
          } catch (e) {
            if (!(e instanceof PyError)) throw e
            const h = st.handlers.find((x) => x.types.length === 0 || x.types.includes(e.type) || (x.types.includes('Exception') && e.type !== 'KeyboardInterrupt'))
            if (!h) throw e
            if (h.as) sc.vars.set(h.as, Object.assign({ pyName: e.type, getattr: () => null, strOf: () => e.message } as PyObj, { excType: e.type }))
            await this.execBlock(h.body, sc)
          }
        } finally {
          await this.execBlock(st.fin, sc)
        }
        return
      }
      case 'global': for (const n of st.names) sc.globalNames.add(n); return
      case 'break': throw new Break()
      case 'continue': throw new Continue()
      case 'import': {
        const m = this.host.modules[st.mod]
        if (!m) throw new PyError('ImportError', 'no module named \'' + st.mod + "'")
        sc.vars.set(st.as, this.moduleObj(st.mod, m))
        return
      }
      case 'from': {
        const m = this.host.modules[st.mod]
        if (!m) throw new PyError('ImportError', 'no module named \'' + st.mod + "'")
        for (const [n, a] of st.names) {
          if (n === '*') { for (const [k, v] of Object.entries(m)) sc.vars.set(k, v); continue }
          if (!(n in m)) throw new PyError('ImportError', "can't import name " + n)
          sc.vars.set(a, m[n])
        }
        return
      }
    }
  }

  moduleObj(_name: string, m: Record<string, Value>): Value {
    return { pyName: 'module', getattr: (n: string) => { if (!(n in m)) throw new PyError('AttributeError', `'module' object has no attribute '${n}'`); return m[n] } } as PyObj
  }

  binop(op: string, a: Value, b: Value): Value {
    switch (op) {
      case '+':
        if (typeof a === 'string' && typeof b === 'string') return a + b
        if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
        if (isNum(a) && isNum(b)) return isF(a) || isF(b) ? new F(num(a) + num(b)) : num(a) + num(b)
        break
      case '-': if (isNum(a) && isNum(b)) return isF(a) || isF(b) ? new F(num(a) - num(b)) : num(a) - num(b); break
      case '*':
        if (isNum(a) && isNum(b)) return isF(a) || isF(b) ? new F(num(a) * num(b)) : num(a) * num(b)
        if (typeof a === 'string' && typeof b === 'number') return a.repeat(Math.max(0, b))
        if (Array.isArray(a) && typeof b === 'number') return Array.from({ length: Math.max(0, b) }, () => a).flat()
        break
      case '/': if (isNum(a) && isNum(b)) { if (num(b) === 0) throw new PyError('ZeroDivisionError', 'divide by zero'); return new F(num(a) / num(b)) } break
      case '//': if (isNum(a) && isNum(b)) { if (num(b) === 0) throw new PyError('ZeroDivisionError', 'divide by zero'); const q = Math.floor(num(a) / num(b)); return isF(a) || isF(b) ? new F(q) : q } break
      case '%':
        if (typeof a === 'string') { let i = 0; const args = b instanceof PyTuple ? b.items : [b]; return a.replace(/%(\.\d+)?([sdfrxXc%])/g, (_m, p: string | undefined, t: string) => { if (t === '%') return '%'; const v = args[i++]; if (t === 's') return pyStr(v); if (t === 'r') return pyRepr(v); if (t === 'd') return String(Math.trunc(num(v))); if (t === 'f') return num(v).toFixed(p ? +p.slice(1) : 6); if (t === 'x') return Math.trunc(num(v)).toString(16); if (t === 'X') return Math.trunc(num(v)).toString(16).toUpperCase(); return String.fromCharCode(num(v)) }) }
        if (isNum(a) && isNum(b)) { if (num(b) === 0) throw new PyError('ZeroDivisionError', 'divide by zero'); const r = ((num(a) % num(b)) + num(b)) % num(b); return isF(a) || isF(b) ? new F(r) : r }
        break
      case '**': if (isNum(a) && isNum(b)) { const r = num(a) ** num(b); return isF(a) || isF(b) || num(b) < 0 ? new F(r) : r } break
      case '&': if (isNum(a) && isNum(b)) return Number(BigInt.asIntN(32, BigInt(num(a)) & BigInt(num(b)))); break
      case '|': if (isNum(a) && isNum(b)) return Number(BigInt.asIntN(32, BigInt(num(a)) | BigInt(num(b)))); break
      case '^': if (isNum(a) && isNum(b)) return Number(BigInt.asIntN(32, BigInt(num(a)) ^ BigInt(num(b)))); break
      case '<<': if (isNum(a) && isNum(b)) return num(a) * 2 ** num(b); break
      case '>>': if (isNum(a) && isNum(b)) return Math.floor(num(a) / 2 ** num(b)); break
      case '==': return eq(a, b)
      case '!=': return !eq(a, b)
      case '<': return cmp(a, b) < 0
      case '>': return cmp(a, b) > 0
      case '<=': return cmp(a, b) <= 0
      case '>=': return cmp(a, b) >= 0
      case 'is': return a === b || (a === null && b === null)
      case 'is not': return !(a === b)
      case 'in': return typeof b === 'string' ? b.includes(String(a)) : b instanceof Map ? b.has(a) : iterate(b).some((x) => eq(x, a))
      case 'not in': return !this.binop('in', a, b)
    }
    throw new PyError('TypeError', `unsupported types for ${op}: '${typeName(a)}', '${typeName(b)}'`)
  }

  async call(fn: Value, args: Value[], kw: [string, Value][] = []): Promise<Value> {
    if (typeof fn === 'function') return fn(kw.length ? [...args, new Map(kw)] : args)
    if (fn instanceof PyFunc) {
      const sc = new Scope(this.globals)
      if (args.length > fn.params.length) throw new PyError('TypeError', `function takes ${fn.params.length} positional arguments but ${args.length} were given`)
      for (let i = 0; i < fn.params.length; i++) {
        const p = fn.params[i]
        const k = kw.find(([n]) => n === p.name)
        if (i < args.length) sc.vars.set(p.name, args[i])
        else if (k) sc.vars.set(p.name, k[1])
        else if (p.def) sc.vars.set(p.name, await this.eval(p.def, this.globals))
        else throw new PyError('TypeError', `function missing required positional argument #${i + 1}`)
      }
      if (this.frames.length > 40) throw new PyError('RuntimeError', 'maximum recursion depth exceeded')
      this.frames.push(fn.name)
      try {
        await this.execBlock(fn.body, sc)
      } catch (e) {
        if (e instanceof Return) return e.v
        throw e
      } finally {
        this.frames.pop()
      }
      return null
    }
    if (fn && typeof fn === 'object' && 'getattr' in fn && typeof (fn as PyObj).getattr === 'function') {
      const call = (fn as PyObj).getattr('__call__')
      if (typeof call === 'function') return call(args)
    }
    throw new PyError('TypeError', "'" + typeName(fn) + "' object isn't callable")
  }

  getattr(o: Value, n: string): Value {
    if (o && typeof o === 'object' && 'getattr' in o && typeof (o as PyObj).getattr === 'function') return (o as PyObj).getattr(n)
    if (typeof o === 'string') {
      const m: Record<string, Native> = {
        upper: () => (o as string).toUpperCase(), lower: () => (o as string).toLowerCase(), strip: () => (o as string).trim(), split: (a) => (a[0] === undefined ? (o as string).trim().split(/\s+/) : (o as string).split(String(a[0]))),
        join: (a) => iterate(a[0]).map(pyStr).join(o as string), replace: (a) => (o as string).split(String(a[0])).join(String(a[1])), startswith: (a) => (o as string).startsWith(String(a[0])), endswith: (a) => (o as string).endsWith(String(a[0])),
        format: (a) => { let i = 0; return (o as string).replace(/\{(\d*)(?::([^}]*))?\}/g, (_x, idx: string, sp: string | undefined) => { const v = a[idx === '' ? i++ : +idx]; return sp ? fmtSpec(v, sp) : pyStr(v) }) },
        encode: () => o, find: (a) => (o as string).indexOf(String(a[0])),
      }
      if (n in m) return m[n]
    }
    if (Array.isArray(o)) {
      const m: Record<string, Native> = {
        append: (a) => { o.push(a[0]); return null }, pop: (a) => { if (!o.length) throw new PyError('IndexError', 'pop from empty list'); return a.length ? o.splice(num(a[0]), 1)[0] : o.pop() },
        extend: (a) => { o.push(...iterate(a[0])); return null }, insert: (a) => { o.splice(num(a[0]), 0, a[1]); return null }, remove: (a) => { const i = o.findIndex((x) => eq(x, a[0])); if (i < 0) throw new PyError('ValueError', 'list.remove(x): x not in list'); o.splice(i, 1); return null },
        index: (a) => { const i = o.findIndex((x) => eq(x, a[0])); if (i < 0) throw new PyError('ValueError', 'object not in sequence'); return i }, reverse: () => { o.reverse(); return null }, sort: () => { o.sort(cmp); return null }, count: (a) => o.filter((x) => eq(x, a[0])).length,
      }
      if (n in m) return m[n]
    }
    if (o instanceof Map) {
      const m: Record<string, Native> = {
        get: (a) => { for (const [k, v] of o) if (eq(k, a[0])) return v; return a[1] ?? null }, keys: () => [...o.keys()], values: () => [...o.values()], items: () => [...o.entries()].map(([k, v]) => new PyTuple([k, v])),
        pop: (a) => { const v = o.get(a[0]); o.delete(a[0]); return v ?? null }, update: (a) => { if (a[0] instanceof Map) for (const [k, v] of a[0]) o.set(k, v); return null },
      }
      if (n in m) return m[n]
    }
    throw new PyError('AttributeError', `'${typeName(o)}' object has no attribute '${n}'`)
  }

  async eval(e: Expr, sc: Scope): Promise<Value> {
    switch (e.t) {
      case 'num': return e.v
      case 'str': return e.v
      case 'fstr': { let s = ''; for (const p of e.parts) s += typeof p === 'string' ? p : pyStr(await this.eval(p, sc)); return s }
      case 'name': {
        const owner = sc.globalNames.has(e.n) ? this.globals : sc.lookup(e.n)
        if (!owner) throw new PyError('NameError', `name '${e.n}' isn't defined`)
        return owner.vars.get(e.n)
      }
      case 'list': return Promise.all(e.items.map((x) => this.eval(x, sc)))
      case 'tuple': return new PyTuple(await Promise.all(e.items.map((x) => this.eval(x, sc))))
      case 'dict': { const m = new Map<Value, Value>(); for (const [k, v] of e.pairs) m.set(await this.eval(k, sc), await this.eval(v, sc)); return m }
      case 'un': {
        const v = await this.eval(e.e, sc)
        if (e.op === 'not') return !truthy(v)
        if (e.op === '-') return isF(v) ? new F(-v.v) : -num(v)
        if (e.op === '~') return ~num(v)
        return v
      }
      case 'logic': { const l = await this.eval(e.l, sc); return e.op === 'and' ? (truthy(l) ? this.eval(e.r, sc) : l) : truthy(l) ? l : this.eval(e.r, sc) }
      case 'cond': return truthy(await this.eval(e.c, sc)) ? this.eval(e.a, sc) : this.eval(e.b, sc)
      case 'bin': return this.binop(e.op, await this.eval(e.l, sc), await this.eval(e.r, sc))
      case 'attr': return this.getattr(await this.eval(e.o, sc), e.n)
      case 'idx': {
        const o = await this.eval(e.o, sc)
        const i = await this.eval(e.i, sc)
        if (o instanceof Map) { for (const [k, v] of o) if (eq(k, i)) return v; throw new PyError('KeyError', pyRepr(i)) }
        const seq = typeof o === 'string' || Array.isArray(o) ? o : o instanceof PyTuple ? o.items : null
        if (!seq) throw new PyError('TypeError', "'" + typeName(o) + "' object isn't subscriptable")
        const n = num(i)
        const k = n < 0 ? seq.length + n : n
        if (k < 0 || k >= seq.length) throw new PyError('IndexError', typeof o === 'string' ? 'string index out of range' : 'list index out of range')
        return seq[k]
      }
      case 'slice': {
        const o = await this.eval(e.o, sc)
        const a = e.a ? num(await this.eval(e.a, sc)) : undefined
        const b = e.b ? num(await this.eval(e.b, sc)) : undefined
        if (typeof o === 'string' || Array.isArray(o)) return o.slice(a, b)
        if (o instanceof PyTuple) return new PyTuple(o.items.slice(a, b))
        throw new PyError('TypeError', "object isn't subscriptable")
      }
      case 'call': {
        const fn = await this.eval(e.fn, sc)
        const args: Value[] = []
        for (const a of e.args) args.push(await this.eval(a, sc))
        const kw: [string, Value][] = []
        for (const [k, v] of e.kw) kw.push([k, await this.eval(v, sc)])
        return this.call(fn, args, kw)
      }
    }
  }
}
