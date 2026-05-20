import { useRef, useState, KeyboardEvent } from 'react'

interface Line { type: 'cmd' | 'out' | 'err'; text: string }

export default function TerminalPage() {
  const [lines, setLines] = useState<Line[]>([{ type: 'out', text: 'OffDock terminal — commands run on the server as root. Type a command and press Enter.' }])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [running, setRunning] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const append = (type: Line['type'], text: string) => {
    setLines(prev => [...prev, { type, text }])
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }

  const run = async () => {
    const cmd = input.trim()
    if (!cmd) return
    setInput('')
    setHistIdx(-1)
    setHistory(h => [cmd, ...h.slice(0, 49)])
    append('cmd', '$ ' + cmd)
    setRunning(true)
    try {
      const res = await fetch('/api/v1/terminal/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      })
      const data = await res.json() as { stdout: string; stderr: string; exit_code: number }
      if (data.stdout) data.stdout.split('\n').forEach(l => append('out', l))
      if (data.stderr) data.stderr.split('\n').forEach(l => append('err', l))
      if (data.exit_code !== 0) append('err', `exit code: ${data.exit_code}`)
    } catch (e) {
      append('err', 'Request failed: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setRunning(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { run(); return }
    if (e.key === 'ArrowUp') {
      const idx = Math.min(histIdx + 1, history.length - 1)
      setHistIdx(idx)
      setInput(history[idx] ?? '')
      e.preventDefault()
    }
    if (e.key === 'ArrowDown') {
      const idx = Math.max(histIdx - 1, -1)
      setHistIdx(idx)
      setInput(idx === -1 ? '' : history[idx])
      e.preventDefault()
    }
  }

  return (
    <div className="p-6 flex flex-col h-[calc(100vh-2rem)]">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white">Terminal</h1>
        <div className="flex gap-2">
          <span className="text-xs text-yellow-400 bg-yellow-900/30 px-2 py-1 rounded">Commands run as root on the server</span>
          <button onClick={() => setLines([])} className="btn-ghost text-xs">Clear</button>
        </div>
      </div>

      {/* Output */}
      <div
        className="flex-1 font-mono text-xs bg-gray-950 border border-gray-800 rounded-xl p-4 overflow-y-auto cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((l, i) => (
          <div key={i} className={l.type === 'cmd' ? 'text-blue-400' : l.type === 'err' ? 'text-red-400' : 'text-gray-300'}>
            {l.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 mt-3 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2">
        <span className="text-blue-400 font-mono text-xs shrink-0">$</span>
        <input
          ref={inputRef}
          className="flex-1 bg-transparent font-mono text-xs text-gray-100 outline-none placeholder-gray-600"
          placeholder={running ? 'running…' : 'enter command…'}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={running}
          autoFocus
          spellCheck={false}
        />
        <button onClick={run} disabled={running || !input.trim()} className="btn-primary text-xs py-1 shrink-0">
          {running ? '…' : 'Run'}
        </button>
      </div>
    </div>
  )
}
