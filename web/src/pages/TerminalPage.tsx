import { useEffect, useRef, useState, KeyboardEvent } from 'react'

interface Line { type: 'cmd' | 'out' | 'err' | 'info'; text: string }

const SHELL_COMPLETIONS = [
  'docker ps', 'docker images', 'docker stats --no-stream', 'docker logs ',
  'docker compose ps', 'docker compose up -d', 'docker compose down',
  'systemctl status offdock', 'systemctl restart offdock', 'systemctl status nginx',
  'journalctl -u offdock -n 50', 'journalctl -u nginx -n 50',
  'ls /var/offdock/', 'ls /var/offdock/data/', 'ls /var/offdock/uploads/',
  'df -h', 'free -h', 'top -bn1', 'ps aux',
  'cat /etc/offdock/config.yaml', 'nginx -t', 'systemctl reload nginx',
]


export default function TerminalPage() {
  const [lines, setLines] = useState<Line[]>([
    { type: 'info', text: 'OffDock terminal  ·  commands run as root on the server' },
    { type: 'info', text: 'Tip: Tab to autocomplete, ↑↓ for history, Ctrl+L to clear' },
  ])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [running, setRunning] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggIdx, setSuggIdx] = useState(-1)
  const [cwd, setCwd] = useState('')

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Fetch initial cwd
  useEffect(() => {
    fetch('/api/v1/terminal/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'pwd' }) })
      .then(r => r.json()).then(d => setCwd((d.stdout as string).trim())).catch(() => {})
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  const append = (type: Line['type'], text: string) =>
    setLines(prev => [...prev, { type, text }])

  const run = async (cmd = input.trim()) => {
    if (!cmd || running) return
    setInput('')
    setHistIdx(-1)
    setSuggestions([])
    setSuggIdx(-1)
    setHistory(h => [cmd, ...h.filter(x => x !== cmd).slice(0, 99)])
    append('cmd', (cwd ? cwd + ' $ ' : '$ ') + cmd)
    setRunning(true)

    abortRef.current = new AbortController()
    try {
      const res = await fetch('/api/v1/terminal/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, cwd }),
        signal: abortRef.current.signal,
      })
      const data = await res.json() as { stdout: string; stderr: string; exit_code: number; cwd?: string }
      if (data.cwd) setCwd(data.cwd)
      const outLines = (data.stdout ?? '').split('\n')
      const errLines = (data.stderr ?? '').split('\n')
      outLines.forEach(l => { if (l) append('out', l) })
      errLines.forEach(l => { if (l) append('err', l) })
      if (!data.stdout && !data.stderr && data.exit_code === 0) append('out', '')
      if (data.exit_code !== 0) append('err', `[exit ${data.exit_code}]`)
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') {
        append('err', 'Request failed: ' + (e instanceof Error ? e.message : String(e)))
      } else {
        append('info', '^C')
      }
    } finally {
      setRunning(false)
      abortRef.current = null
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }

  const abort = () => {
    if (abortRef.current) {
      abortRef.current.abort()
    }
  }

  const updateSuggestions = (val: string) => {
    if (!val.trim()) { setSuggestions([]); return }
    const matches = SHELL_COMPLETIONS.filter(s => s.toLowerCase().startsWith(val.toLowerCase()))
    setSuggestions(matches)
    setSuggIdx(-1)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Ctrl+C aborts running command
    if (e.ctrlKey && e.key === 'c') { e.preventDefault(); if (running) abort(); else { append('info', '^C'); setInput('') }; return }
    // Ctrl+L clear
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); setLines([]); return }

    if (e.key === 'Enter') { e.preventDefault(); if (running) return; if (suggIdx >= 0 && suggestions[suggIdx]) { setInput(suggestions[suggIdx]); setSuggestions([]); setSuggIdx(-1) } else { run() } ; return }

    if (e.key === 'Tab') {
      e.preventDefault()
      if (suggestions.length === 1) { setInput(suggestions[0]); setSuggestions([]); return }
      if (suggestions.length > 1) { setSuggIdx(i => (i + 1) % suggestions.length); return }
      // Try to complete from history
      const match = history.find(h => h.startsWith(input) && h !== input)
      if (match) setInput(match)
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (suggestions.length > 0) { setSuggIdx(i => Math.max(0, i - 1)); return }
      const idx = Math.min(histIdx + 1, history.length - 1)
      setHistIdx(idx)
      if (history[idx] !== undefined) setInput(history[idx])
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (suggestions.length > 0) { setSuggIdx(i => Math.min(suggestions.length - 1, i + 1)); return }
      const idx = Math.max(histIdx - 1, -1)
      setHistIdx(idx)
      setInput(idx === -1 ? '' : history[idx])
      return
    }
    if (e.key === 'Escape') { setSuggestions([]); setSuggIdx(-1) }
  }

  return (
    <div className="p-6 flex flex-col h-[calc(100vh-2rem)]">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-semibold text-white">Terminal</h1>
        <div className="flex items-center gap-2">
          <span className="text-xs text-yellow-500 bg-yellow-900/20 px-2 py-1 rounded border border-yellow-800/40">
            runs as root
          </span>
          {running && (
            <button onClick={abort} className="btn-danger text-xs py-1">
              Ctrl+C  Stop
            </button>
          )}
          <button onClick={() => setLines([])} className="btn-ghost text-xs">Clear</button>
        </div>
      </div>

      {/* Output */}
      <div
        className="flex-1 font-mono text-xs bg-gray-950 border border-gray-800 rounded-xl p-4 overflow-y-auto cursor-text select-text"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((l, i) => (
          <div key={i} className={
            l.type === 'cmd'  ? 'text-blue-400 mt-1' :
            l.type === 'err'  ? 'text-red-400' :
            l.type === 'info' ? 'text-gray-600 italic' :
            'text-gray-300'
          }>
            {l.text || ' '}
          </div>
        ))}
        {running && <span className="text-yellow-400 animate-pulse">▌</span>}
        <div ref={bottomRef} />
      </div>

      {/* Autocomplete suggestions */}
      {suggestions.length > 0 && !running && (
        <div className="bg-gray-900 border border-gray-700 rounded-lg mt-1 max-h-40 overflow-y-auto">
          {suggestions.map((s, i) => (
            <button
              key={s}
              className={`w-full text-left px-3 py-1.5 font-mono text-xs transition-colors ${i === suggIdx ? 'bg-blue-600/30 text-blue-300' : 'text-gray-400 hover:bg-gray-800'}`}
              onMouseDown={e => { e.preventDefault(); setInput(s); setSuggestions([]); inputRef.current?.focus() }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="flex items-center gap-2 mt-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 focus-within:border-blue-600 transition-colors">
        <span className="text-blue-400 font-mono text-xs shrink-0 select-none">
          {cwd ? <span className="text-green-500">{cwd}</span> : null}
          {cwd ? <span className="text-gray-600"> $ </span> : <span className="text-blue-400">$ </span>}
        </span>
        <input
          ref={inputRef}
          className="flex-1 bg-transparent font-mono text-xs text-gray-100 outline-none placeholder-gray-700 caret-blue-400"
          placeholder={running ? '' : 'type a command…'}
          value={input}
          disabled={running}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          onChange={e => { setInput(e.target.value); updateSuggestions(e.target.value) }}
          onKeyDown={onKeyDown}
        />
        <span className="text-gray-700 text-xs shrink-0 select-none">
          {history.length > 0 && `${history.length} history`}
        </span>
      </div>
    </div>
  )
}
