import { useRef, useState } from 'react'
import XTerminal, { XTerminalHandle } from '../components/XTerminal'

const QUICK_PATHS = [
  { label: '~',              path: '/root' },
  { label: '/',              path: '/' },
  { label: '/var/offdock',   path: '/var/offdock' },
  { label: '/etc/offdock',   path: '/etc/offdock' },
  { label: '/var/log',       path: '/var/log' },
  { label: '/etc/nginx',     path: '/etc/nginx' },
]

// Copies text to clipboard using the Clipboard API on HTTPS, textarea trick on HTTP.
function copyText(text: string, onDone?: () => void) {
  const doFallback = () => {
    const ta = document.createElement('textarea')
    ta.value = text
    Object.assign(ta.style, { position: 'fixed', top: '-9999px', left: '-9999px', opacity: '0' })
    document.body.appendChild(ta)
    ta.focus(); ta.select()
    try { document.execCommand('copy') } catch {}
    ta.remove()
    onDone?.()
  }
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(onDone).catch(doFallback)
  } else {
    doFallback()
  }
}

export default function TerminalPage() {
  const [key, setKey] = useState(0)
  const [fontSize, setFontSize] = useState(13)
  const [copied, setCopied] = useState(false)
  const termRef = useRef<XTerminalHandle>(null)

  const reconnect = () => setKey(k => k + 1)

  const handleCopy = () => {
    const sel = termRef.current?.getSelection() ?? ''
    if (!sel) return
    copyText(sel, () => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      termRef.current?.focus()
    })
  }

  const handlePaste = () => {
    if (!window.isSecureContext || !navigator.clipboard?.readText) return
    navigator.clipboard.readText().then(text => {
      if (text) termRef.current?.send(text)
      termRef.current?.focus()
    }).catch(() => {})
  }

  const canPaste = window.isSecureContext && !!navigator.clipboard?.readText

  return (
    <div className="flex flex-col h-full" style={{ background: '#0d1117' }}>
      {/* Title bar */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 shrink-0 flex-wrap gap-y-1"
        style={{ background: '#161b22', borderBottom: '1px solid #30363d' }}
      >
        {/* Traffic lights */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <div className="w-3 h-3 rounded-full bg-[#28c840]" />
        </div>

        <span className="text-xs font-mono ml-1 shrink-0" style={{ color: '#484f58' }}>
          root@server — bash — host shell
        </span>

        {/* Quick dir nav */}
        <div className="flex items-center gap-1 ml-2 flex-wrap">
          {QUICK_PATHS.map(p => (
            <button
              key={p.path}
              onClick={() => {
                termRef.current?.send(`cd ${p.path}\r`)
                termRef.current?.focus()
              }}
              className="text-xs px-2 py-0.5 rounded font-mono transition-opacity hover:opacity-80"
              style={{ color: '#484f58', border: '1px solid #30363d' }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 ml-auto">
          {/* Font size */}
          <div className="flex items-center gap-1" style={{ color: '#484f58' }}>
            <button
              onClick={() => setFontSize(s => Math.max(9, s - 1))}
              className="text-xs px-1.5 py-0.5 rounded hover:opacity-80 font-mono"
              style={{ border: '1px solid #30363d' }}
            >
              −
            </button>
            <span className="text-xs font-mono tabular-nums w-5 text-center">{fontSize}</span>
            <button
              onClick={() => setFontSize(s => Math.min(24, s + 1))}
              className="text-xs px-1.5 py-0.5 rounded hover:opacity-80 font-mono"
              style={{ border: '1px solid #30363d' }}
            >
              ＋
            </button>
          </div>

          {/* Copy button */}
          <button
            onClick={handleCopy}
            title="Copy selection (Ctrl+Shift+C)"
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded hover:opacity-80 transition-colors"
            style={{
              color: copied ? '#3fb950' : '#484f58',
              border: `1px solid ${copied ? '#3fb950' : '#30363d'}`,
            }}
          >
            {copied ? (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>
                <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
              </svg>
            )}
            <span>{copied ? 'Copied!' : 'Copy'}</span>
          </button>

          {/* Paste button */}
          <button
            onClick={handlePaste}
            disabled={!canPaste}
            title={canPaste ? 'Paste from clipboard (Ctrl+V)' : 'Paste requires HTTPS — use Ctrl+V'}
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-opacity"
            style={{
              color: canPaste ? '#484f58' : '#2d3139',
              border: `1px solid ${canPaste ? '#30363d' : '#1e2228'}`,
              cursor: canPaste ? 'pointer' : 'not-allowed',
              opacity: canPaste ? 1 : 0.5,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.626 3.533a.249.249 0 0 0-.126.217v9.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-9.5a.249.249 0 0 0-.126-.217l-.75-.432-.752 1.304-1.04-.6.752-1.304h-.884a.25.25 0 0 0-.25.25v.75h-2.5v-.75a.25.25 0 0 0-.25-.25h-.884l.752 1.304-1.04.6-.752-1.304-.75.432ZM5.5 1.75v-.25c0-.966.784-1.75 1.75-1.75h1.5c.966 0 1.75.784 1.75 1.75v.25h.884a1.75 1.75 0 0 1 1.616 1.083l.75.433A1.75 1.75 0 0 1 14.5 4.75v9.5A1.75 1.75 0 0 1 12.75 16h-8.5A1.75 1.75 0 0 1 2.5 14.25v-9.5a1.75 1.75 0 0 1 .75-1.434l.75-.433A1.75 1.75 0 0 1 5.616 1.75H5.5ZM7.25 1.5a.25.25 0 0 0-.25.25v.25h2V1.75a.25.25 0 0 0-.25-.25Z"/>
            </svg>
            <span>Paste</span>
          </button>

          <button
            onClick={reconnect}
            className="text-xs font-mono hover:opacity-80 px-2 py-0.5 rounded"
            style={{ color: '#484f58', border: '1px solid #30363d' }}
          >
            ↺ reconnect
          </button>
        </div>
      </div>

      {/* Terminal */}
      <XTerminal
        key={`shell-${key}`}
        ref={termRef}
        wsUrl="/api/v1/terminal/shell/ws"
        fontSize={fontSize}
        className="flex-1 min-h-0"
        style={{ padding: '8px' }}
      />
    </div>
  )
}
