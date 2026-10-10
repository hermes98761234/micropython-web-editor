import { useCallback, useEffect, useState } from 'react'

export type Lang = 'en' | 'uk'
export type Theme = 'auto' | 'light' | 'dark'
export interface Settings {
  lang: Lang
  theme: Theme
}

const PREFIX = 'micropython-web-editor:'

export function loadJSON<V>(key: string, fallback: V): V {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return fallback
    const v: unknown = JSON.parse(raw)
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) return { ...fallback, ...(v as object) } as V
    return v as V
  } catch {
    return fallback
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* storage full or blocked */
  }
}

/** useState persisted in localStorage. */
export function useStored<V>(key: string, initial: V): [V, (v: V | ((p: V) => V)) => void] {
  const [v, setV] = useState<V>(() => loadJSON(key, initial))
  useEffect(() => saveJSON(key, v), [key, v])
  const set = useCallback((n: V | ((p: V) => V)) => setV(n), [])
  return [v, set]
}

export function useSettings(): [Settings, (p: Partial<Settings>) => void] {
  const [s, setS] = useStored<Settings>('settings', {
    lang: typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('uk') ? 'uk' : 'en',
    theme: 'auto',
  })
  useEffect(() => {
    const root = document.documentElement
    if (s.theme === 'auto') delete root.dataset.theme
    else root.dataset.theme = s.theme
    root.lang = s.lang
  }, [s.theme, s.lang])
  return [s, (p) => setS((o) => ({ ...o, ...p }))]
}
