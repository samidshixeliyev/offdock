import { useCallback, useEffect, useRef, useState } from 'react'

/* ── types ──────────────────────────────────────────────────────────────── */
interface OutLine { kind: 'stdout' | 'stderr' | 'cmd' | 'sys'; text: string }

const HINTS = [
  'docker ps', 'docker images', 'docker stats --no-stream', 'docker logs ',
  'docker compose ps', 'docker compose up -d', 'docker compose down',
  'systemctl status offdock', 'systemctl restart offdock',
  'systemctl status nginx', 'systemctl reload nginx', 'nginx -t',
  'journalctl -u offdock -n 50 --no-pager', 'journalctl -u nginx -n 30 --no-pager',
  'ls /var/offdock/', 'ls /var/offdock/data/', 'ls /var/offdock/uploads/',
  'cat /etc/offdock/config.yaml', 'df -h', 'free -h', 'top -bn1', 'uptime',
]

const ANSI_RE = /\x1b\[[0-9;]*[mGKHF]/g
const stripAnsi = (s: string) => s.replace(ANSI_RE, '')

/* ── component ──────────────────────────────────────────────────────────── */
export default function TerminalPage() {
  const [lines, setLines] = useState<OutLine[]>([
    { kind: 'sys', text: 'OffDock Shell  ·  commands run as root  ·  Tab: autocomplete  ·  ↑↓: history  ·  Ctrl+C: cancel' },
  ])
  const [input, setInput] = useState('')
  const [cwd, setCwd] = useState('/root')
  const [hostname, setHostname] = useState('server')
  const [running, setRunning] = useState(false)
  const [cmdHist, setCmdHist] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [hint, setHint] = useState('')         // ghost autocomplete text

  const abortRef = useRef<AbortController | null>(null)
  const termRef = useRef<HTMLDivElement>(null)
  const hiddenRef = useRef<HTMLTextAreaElement>(null)

  /* ── init ────────────────────────────────────────────────────────────── */
  useEffect(() => {
    fetch('/api/v1/terminal/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'hostname && echo $PWD', cwd: '/root' }),
    }).then(r => r.json()).then((d: { stdout: string; cwd: string }) => {
      const parts = (d.stdout ?? '').trim().split('\n')
      if (parts[0]) setHostname(parts[0].trim())
      if (d.cwd) setCwd(d.cwd)
    }).catch(() => {})
  }, [])

  /* ── auto-scroll ─────────────────────────────────────────────────────── */
  useEffect(() => {
    const el = termRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, input])

  /* ── focus helpers ───────────────────────────────────────────────────── */
  const focusHidden = () => hiddenRef.current?.focus()

  /* ── autocomplete hint ───────────────────────────────────────────────── */
  const computeHint = useCallback((val: string) => {
    if (!val.trim()) { setHint(''); return }
    const match = HINTS.find(h => h.startsWith(val) && h !== val)
    setHint(match ? match.slice(val.length) : '')
  }, [])

  /* ── prompt string ───────────────────────────────────────────────────── */
  const shortCwd = cwd.replace(/^\/root$/, '~').replace(/^\/home\/\w+/, '~')
  const prompt = `root@${hostname}:${shortCwd}# `

  /* ── submit ──────────────────────────────────────────────────────────── */
  const submit = async (cmd: string) => {
    if (!cmd.trim() || running) return
    const trimmed = cmd.trim()
    setInput('')
    setHint('')
    setHistIdx(-1)
    setCmdHist(h => [trimmed, ...h.filter(x => x !== trimmed).slice(0, 99)])
    setLines(prev => [...prev, { kind: 'cmd', text: prompt + trimmed }])
    setRunning(true)

    abortRef.current = new AbortController()
    try {
      const res = await fetch('/api/v1/terminal/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: trimmed, cwd }),
        signal: abortRef.current.signal,
      })
      const data = await res.json() as { stdout: string; stderr: string; exit_code: number; cwd: string }
      if (data.cwd) setCwd(data.cwd)

      const outText = stripAnsi(data.stdout ?? '')
      const errText = stripAnsi(data.stderr ?? '')

      setLines(prev => {
        const next = [...prev]
        outText.split('\n').forEach(l => { if (l) next.push({ kind: 'stdout', text: l }) })
        errText.split('\n').forEach(l => { if (l) next.push({ kind: 'stderr', text: l }) })
        if (data.exit_code !== 0 && !errText) next.push({ kind: 'stderr', text: `[exit ${data.exit_code}]` })
        return next
      })
    } catch (e: unknown) {
      const msg = (e as Error)?.name === 'AbortError' ? '' : `error: ${(e as Error).message}`
      if (msg) setLines(prev => [...prev, { kind: 'stderr', text: msg }])
    } finally {
      setRunning(false)
      abortRef.current = null
      focusHidden()
    }
  }

  /* ── keyboard ────────────────────────────────────────────────────────── */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault()
      if (running) {
        abortRef.current?.abort()
      } else {
        setLines(prev => [...prev, { kind: 'cmd', text: prompt + input + '^C' }])
        setInput('')
        setHint('')
      }
      return
    }
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault()
      setLines([])
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      submit(input)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      if (hint) {
        const next = input + hint
        setInput(next)
        computeHint(next)
      }
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const idx = Math.min(histIdx + 1, cmdHist.length - 1)
      setHistIdx(idx)
      const val = cmdHist[idx] ?? ''
      setInput(val)
      computeHint(val)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const idx = Math.max(histIdx - 1, -1)
      setHistIdx(idx)
      const val = idx === -1 ? '' : cmdHist[idx]
      setInput(val)
      computeHint(val)
      return
    }
  }

  const onTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (running) return
    const val = e.target.value
    setInput(val)
    setHistIdx(-1)
    computeHint(val)
  }

  /* ── render ──────────────────────────────────────────────────────────── */
  return (
    <div
      className="flex flex-col bg-[#0d1117] h-[calc(100vh-0px)] select-none cursor-text"
      onClick={focusHidden}
    >
      {/* Title bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-[#30363d] shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <div className="w-3 h-3 rounded-full bg-[#28c840]" />
          <span className="ml-3 text-xs text-[#8b949e] font-mono">root@{hostname} — bash</span>
        </div>
        <div className="flex items-center gap-3">
          {running && (
            <button
              onClick={e => { e.stopPropagation(); abortRef.current?.abort() }}
              className="text-xs text-red-400 hover:text-red-300 border border-red-800 px-2 py-0.5 rounded font-mono"
            >
              ■ Ctrl+C
            </button>
          )}
          <button
            onClick={e => { e.stopPropagation(); setLines([]) }}
            className="text-xs text-[#8b949e] hover:text-white font-mono"
          >
            clear
          </button>
        </div>
      </div>

      {/* Output area */}
      <div
        ref={termRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-[13px] leading-5 select-text"
        style={{ fontFamily: '"JetBrains Mono","Fira Code","Cascadia Code",monospace' }}
      >
        {lines.map((l, i) => (
          <div
            key={i}
            className={
              l.kind === 'cmd'    ? 'text-[#79c0ff] whitespace-pre-wrap' :
              l.kind === 'stderr' ? 'text-[#ff7b72] whitespace-pre-wrap' :
              l.kind === 'sys'    ? 'text-[#8b949e] italic whitespace-pre-wrap mb-1' :
              'text-[#e6edf3] whitespace-pre-wrap'
            }
          >
            {l.text}
          </div>
        ))}

        {/* Current input line — always at bottom */}
        <div className="flex items-baseline mt-0.5">
          {/* Prompt segments */}
          <span className="text-[#3fb950] shrink-0">root@{hostname}</span>
          <span className="text-[#8b949e] shrink-0">:</span>
          <span className="text-[#79c0ff] shrink-0">{shortCwd}</span>
          <span className="text-[#e6edf3] shrink-0"># </span>

          {/* Typed text */}
          <span className="text-[#e6edf3] whitespace-pre">{input}</span>

          {/* Ghost hint */}
          {hint && !running && (
            <span className="text-[#3d444d] whitespace-pre">{hint}</span>
          )}

          {/* Blinking cursor */}
          {!running ? (
            <span className="inline-block w-[7px] h-[14px] bg-[#e6edf3] ml-[1px] align-middle animate-[blink_1s_step-end_infinite]" />
          ) : (
            <span className="inline-block w-[7px] h-[14px] bg-yellow-500 ml-[1px] align-middle animate-pulse" />
          )}
        </div>
      </div>

      {/* Hidden textarea captures all keyboard input */}
      <textarea
        ref={hiddenRef}
        autoFocus
        value={input}
        onChange={onTextareaChange}
        onKeyDown={onKeyDown}
        className="absolute opacity-0 pointer-events-none w-px h-px top-0 left-0"
        aria-hidden="true"
        tabIndex={0}
        readOnly={running}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
    </div>
  )
}
