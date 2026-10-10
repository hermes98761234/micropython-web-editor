import { describe, expect, it } from 'vitest'
import { tr, UK } from './i18n'

describe('i18n', () => {
  it('returns English source unchanged and interpolates', () => {
    expect(tr('en', 'Hello {0} and {1}', 'a', 2)).toBe('Hello a and 2')
  })
  it('translates known strings and falls back to source', () => {
    expect(tr('uk', 'Source on GitHub')).toBe('Код на GitHub')
    expect(tr('uk', 'unknown string {0}', 5)).toBe('unknown string 5')
  })
  it('keeps placeholders consistent between English and Ukrainian', () => {
    for (const [en, uk] of Object.entries(UK)) {
      const ph = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join()
      expect(ph(uk), en).toBe(ph(en))
    }
  })
})
