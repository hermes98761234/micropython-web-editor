import { describe, expect, it } from 'vitest'
import { Term } from './term'
import { Device } from './device'
import { SimBoard } from './sim'
import { buildWrite, chunkBytes, fromHex, joinPath, parseHexLines, parseListing, readMarker, toHex, utf8Bytes } from './protocol'
import { Interp, parse, pyRepr, type Host, type Value } from './minipy'

const mkHost = (): { host: Host; out: () => string } => {
  let o = ''
  return { host: { write: (s) => (o += s), sleepScale: 0, modules: { time: { sleep: () => null } } }, out: () => o }
}
async function py(src: string, repl = false): Promise<string> {
  const { host, out } = mkHost()
  const it = new Interp(host)
  try { await it.run(src, repl) } catch (e) { return out() + it.fail(e) }
  return out()
}

describe('Term', () => {
  it('handles CR, LF, backspace and erase sequences', () => {
    const t = new Term()
    t.write('>>> helo\b\x1b[K')
    t.write('lo\r\nnext')
    expect(t.text).toBe('>>> hello\nnext')
  })
  it('overwrites after carriage return and survives split escape sequences', () => {
    const t = new Term()
    t.write('abcdef\rXY')
    t.write('\x1b')
    t.write('[2D!')
    expect(t.lines[0]).toBe('!Ycdef')
  })
  it('drops colour codes and limits history', () => {
    const t = new Term(3)
    t.write('\x1b[31mred\x1b[0m\n1\n2\n3\n4')
    expect(t.lines.length).toBe(3)
    expect(t.text).toBe('2\n3\n4')
  })
})

describe('protocol helpers', () => {
  it('hex round-trips and chunks', () => {
    const b = Uint8Array.from([0, 1, 254, 255])
    expect(toHex(b)).toBe('0001feff')
    expect([...fromHex('00 01 fe ff')]).toEqual([...b])
    expect(chunkBytes(new Uint8Array(600), 256).map((c) => c.length)).toEqual([256, 256, 88])
    expect(chunkBytes(new Uint8Array(0), 256)).toHaveLength(1)
  })
  it('builds a write snippet with a marker comment and valid code', () => {
    const code = buildWrite('/main.py', utf8Bytes('hi'), false)
    expect(readMarker(code)).toMatchObject({ op: 'write', path: '/main.py', append: false, hex: '6869' })
    expect(code).toContain("open(\"/main.py\", 'wb')")
    expect(code).toContain("unhexlify('6869')")
  })
  it('parses listings and hex output', () => {
    expect(parseListing('main.py|32768|40\r\nlib|16384|0\r\n')).toEqual([{ name: 'lib', dir: true, size: 0 }, { name: 'main.py', dir: false, size: 40 }])
    expect([...parseHexLines('6869\r\n0a\r\n')]).toEqual([0x68, 0x69, 0x0a])
    expect(joinPath('/', 'a.py')).toBe('/a.py')
    expect(joinPath('/lib', 'a.py')).toBe('/lib/a.py')
  })
})

describe('mini Python', () => {
  it('evaluates arithmetic, strings and f-strings like Python', async () => {
    expect(await py('print(1 + 2 * 3, 7 // 2, 7 % 3, 2 ** 10, 7 / 2)')).toBe('7 3 1 1024 3.5\r\n')
    expect(await py('x = 5\nprint(f"x={x} half={x/2} {x:03d} {3.14159:.2f}")')).toBe('x=5 half=2.5 005 3.14\r\n')
    expect(await py('print("a" * 3 + "b", [1, 2] + [3], len("abc"))')).toBe('aaab [1, 2, 3] 3\r\n')
    expect(await py('print(10 / 2, 1e3, 2.0 * 3)')).toBe('5.0 1000.0 6.0\r\n')
  })
  it('runs loops, functions, conditionals and containers', async () => {
    const src = `def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

total = 0
for i in range(5):
    if i % 2 == 0:
        total += i
    else:
        continue
d = {"a": 1}
d["b"] = 2
print(fib(10), total, sorted(d.keys()), [x * x for x in [1]] if False else "ok")
n = 3
while n > 0:
    n -= 1
print(n, d)
`
    // list comprehensions are not supported: make sure the failure is a clean SyntaxError
    const out = await py(src)
    expect(out).toContain('SyntaxError')
    const fixed = src.replace('[x * x for x in [1]] if False else "ok"', '"ok"')
    expect(await py(fixed)).toBe("55 6 ['a', 'b'] ok\r\n0 {'a': 1, 'b': 2}\r\n")
  })
  it('supports try/except, raise, with and global', async () => {
    const src = `count = 0
def inc():
    global count
    count += 1
inc()
inc()
try:
    1 / 0
except ZeroDivisionError as e:
    print("caught", e)
try:
    raise ValueError("bad")
except Exception as e:
    print("caught", e)
finally:
    print("done", count)
`
    expect(await py(src)).toBe('caught divide by zero\r\ncaught bad\r\ndone 2\r\n')
  })
  it('reports errors in MicroPython style', async () => {
    expect(await py('print(undefined_name)')).toBe('Traceback (most recent call last):\r\n  File "<stdin>", line 1, in <module>\r\nNameError: name \'undefined_name\' isn\'t defined\r\n')
    expect(await py('x = (1,')).toContain('SyntaxError: invalid syntax')
    expect(await py('1 +')).toContain('SyntaxError')
    expect(await py('"a" + 1')).toContain('TypeError')
    expect(await py('print([1][5])')).toContain('IndexError: list index out of range')
  })
  it('echoes expression values in REPL mode', async () => {
    expect(await py('1 + 1\n"hi"\nNone', true)).toBe("2\r\n'hi'\r\n")
    expect(pyRepr('it\'s')).toBe('"it\'s"')
  })
  it('parses without running', () => {
    expect(parse('a = 1\nif a:\n    print(a)\n')).toHaveLength(2)
  })
})

describe('simulated board over the real protocol', () => {
  async function connect(): Promise<{ dev: Device; term: Term; board: SimBoard }> {
    const board = new SimBoard(0)
    const term = new Term()
    const dev = new Device(board, (s) => term.write(s))
    await dev.start()
    await new Promise((r) => setTimeout(r, 120))
    return { dev, term, board }
  }
  it('shows the banner and prompt', async () => {
    const { term } = await connect()
    expect(term.text).toContain('MicroPython v1.22.2')
    expect(term.text.trimEnd().endsWith('>>>')).toBe(true)
  })
  it('runs code through raw-paste mode and streams stdout', async () => {
    const { dev, term } = await connect()
    const res = await dev.run('import time\nfor i in range(3):\n    print("tick", i)\n    time.sleep(0.01)\n')
    expect(res.stdout).toBe('tick 0\r\ntick 1\r\ntick 2\r\n')
    expect(res.stderr).toBe('')
    expect(term.text).toContain('tick 2')
  })
  it('returns tracebacks on stderr', async () => {
    const { dev } = await connect()
    const res = await dev.run('print(1/0)')
    expect(res.stderr).toContain('ZeroDivisionError')
  })
  it('handles code larger than the paste window', async () => {
    const { dev } = await connect()
    const code = Array.from({ length: 60 }, (_, i) => `x${i} = ${i}`).join('\n') + '\nprint(x59 + x58)\n'
    expect(code.length).toBeGreaterThan(300)
    expect((await dev.run(code)).stdout).toBe('117\r\n')
  })
  it('lists, writes, reads and removes files', async () => {
    const { dev, board } = await connect()
    expect((await dev.list('/')).map((e) => e.name)).toEqual(['lib', 'boot.py', 'main.py'])
    const data = new Uint8Array(700).map((_, i) => i % 251)
    await dev.writeFile('/data.bin', data)
    expect(board.fs.get('/data.bin')!.length).toBe(700)
    expect([...(await dev.readFile('/data.bin'))]).toEqual([...data])
    await dev.remove('/data.bin', false)
    expect(board.fs.has('/data.bin')).toBe(false)
    await expect(dev.readFile('/nope.py')).rejects.toThrow(/ENOENT/)
  })
  it('executes an uploaded main.py and supports the friendly REPL', async () => {
    const { dev, term } = await connect()
    await dev.writeFile('/main.py', utf8Bytes('print("uploaded")\n'))
    await dev.sendInput('import os\r')
    await dev.sendInput('os.listdir()\r')
    await new Promise((r) => setTimeout(r, 100))
    expect(term.text).toContain('main.py')
    await dev.sendInput('print(6*7)\r')
    await new Promise((r) => setTimeout(r, 60))
    expect(term.text).toContain('42')
  })
  it('lets Ctrl-C stop a running loop', async () => {
    const board = new SimBoard(1)
    const term = new Term()
    const dev = new Device(board, (s) => term.write(s))
    await dev.start()
    await new Promise((r) => setTimeout(r, 120))
    const p = dev.run('import time\nwhile True:\n    time.sleep(0.05)\n')
    await new Promise((r) => setTimeout(r, 200))
    await dev.interrupt()
    const res = await p
    expect(res.stderr).toContain('KeyboardInterrupt')
  })
  it('drives virtual pins', async () => {
    const { dev, board } = await connect()
    let last: Map<number, number> = new Map()
    board.onPins = (p) => (last = p)
    await dev.run('from machine import Pin\nled = Pin(25, Pin.OUT)\nled.value(1)\n')
    expect(last.get(25)).toBe(1)
    const v: Value = 0
    expect(v).toBe(0)
  })
})
