import type { ReactNode } from 'react'
import type { Settings } from './settings'
import type { T } from './i18n'

interface ShellProps {
  title: string
  subtitle: string
  settings: Settings
  onSettings: (p: Partial<Settings>) => void
  t: T
  children: ReactNode
}

export function Shell({ title, subtitle, settings, onSettings, t, children }: ShellProps) {
  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">{t(title)}</span>
        <span className="hint tagline">{t(subtitle)}</span>
        <span className="spacer" />
        <label className="inline">
          {t('Theme')}
          <select value={settings.theme} onChange={(e) => onSettings({ theme: e.target.value as Settings['theme'] })}>
            <option value="auto">{t('System')}</option>
            <option value="light">{t('Light')}</option>
            <option value="dark">{t('Dark')}</option>
          </select>
        </label>
        <label className="inline">
          {t('Language')}
          <select value={settings.lang} onChange={(e) => onSettings({ lang: e.target.value as Settings['lang'] })}>
            <option value="en">English</option>
            <option value="uk">Українська</option>
          </select>
        </label>
      </header>
      <main className="main">{children}</main>
      <p className="hint foot">
        {t('Runs entirely in your browser. Nothing is uploaded.')}{' '}
        <a href="https://github.com/hermes98761234/micropython-web-editor">{t('Source on GitHub')}</a>
      </p>
    </div>
  )
}

export function Notice({ children, kind = 'warn' }: { children: ReactNode; kind?: 'warn' | 'info' | 'err' }) {
  return <div className={`notice ${kind}`}>{children}</div>
}

export function Tabs<K extends string>({ value, options, onChange }: { value: K; options: [K, string][]; onChange: (k: K) => void }) {
  return (
    <div className="tabs" role="tablist">
      {options.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'tab active' : 'tab'} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  )
}

export function download(name: string, data: string | Blob, type = 'text/plain'): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
