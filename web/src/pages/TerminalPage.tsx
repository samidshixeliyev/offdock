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

export default function TerminalPage() {
  const [key, setKey] = useState(0)
  const [fontSize, setFontSize] = useState(13)
  const termRef = useRef<XTerminalHandle>(null)

  const reconnect = () => setKey(k => k + 1)

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
        <div className="flex items-center gap-3 ml-auto">
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

          <span className="text-xs font-mono hidden md:inline" style={{ color: '#30363d' }}>
            Ctrl+Shift+C copy · Ctrl+Shift+V paste · right-click menu
          </span>

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
