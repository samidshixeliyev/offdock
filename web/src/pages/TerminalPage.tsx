import { useCallback, useEffect, useRef, useState } from 'react'

/* ─── types ─────────────────────────────────────────────────────────────── */
interface Line { kind: 'out' | 'err' | 'cmd' | 'sys'; text: string }

/* ─── autocomplete hints ────────────────────────────────────────────────── */
const HINTS = [
  'docker ps', 'docker ps -a', 'docker images', 'docker stats --no-stream',
  'docker logs ', 'docker exec -it ', 'docker inspect ',
  'docker compose ps', 'docker compose up -d', 'docker compose down',
  'docker compose logs -f',
  'systemctl status offdock', 'systemctl restart offdock', 'systemctl stop offdock',
  'systemctl status nginx', 'systemctl reload nginx', 'nginx -t',
  'journalctl -u offdock -n 50 --no-pager',
  'journalctl -u nginx -n 30 --no-pager',
  'ls -la', 'ls /var/offdock/', 'ls /var/offdock/data/',
  'ls /var/offdock/uploads/', 'ls /var/offdock/projects/',
  'cat /etc/offdock/config.yaml',
  'df -h', 'free -h', 'uptime', 'top -bn1 | head -20',
  'ps aux | grep docker',
]

/* ─── ANSI stripper ─────────────────────────────────────────────────────── */
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const strip = (s: string) => s.replace(ANSI, '')

/* ─── colors (GitHub Dark) ──────────────────────────────────────────────── */
const C = {
  bg:       '#0d1117',
  bar:      '#161b22',
  border:   '#30363d',
  prompt_g: '#3fb950',   // green  — user@host
  prompt_c: '#79c0ff',   // cyan   — cwd
  prompt_w: '#c9d1d9',   // white  — # and typed text
  muted:    '#484f58',   // gray   — hint ghost text / dim
  out:      '#c9d1d9',   // normal output
  err:      '#ff7b72',   // stderr / error
  cmd:      '#79c0ff',   // echoed command line
  sys:      '#484f58',   // system messages
  cursor:   '#c9d1d9',
}

/* ─── component ─────────────────────────────────────────────────────────── */
export default function TerminalPage() {
  const [lines, setLines]     = useState<Line[]>([
    { kind: 'sys', text: 'OffDock Shell — Tab: autocomplete · ↑↓: history · Ctrl+C: cancel · Ctrl+L: clear' },
  ])
  const [input, setInput]     = useState('')
  const [hint, setHint]       = useState('')
  const [cwd, setCwd]         = useState('/root')
  const [host, setHost]       = useState('server')
  const [running, setRunning] = useState(false)
  const [cmdHist, setCmdHist] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)

  const abortRef  = useRef<AbortController | null>(null)
  const termRef   = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLInputElement>(null)

  /* ── auto-scroll ──────────────────────────────────────────────────────── */
  useEffect(() => {
    const el = termRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, input])

  /* ── initial cwd / hostname ───────────────────────────────────────────── */
  useEffect(() => {
    exec('hostname', '/root').then(r => {
      setHost(r.stdout.trim() || 'server')
      setCwd(r.cwd || '/root')
    }).catch(() => {})
  }, [])

  /* ── helpers ──────────────────────────────────────────────────────────── */
  const focusInput = () => inputRef.current?.focus()

  const shortCwd = (c: string) =>
    c === '/root' ? '~' : c.startsWith('/root/') ? '~' + c.slice(5) : c

  const computeHint = useCallback((val: string) => {
    if (!val.trim()) { setHint(''); return }
    const m = HINTS.find(h => h.startsWith(val) && h !== val)
    setHint(m ? m.slice(val.length) : '')
  }, [])

  /* ── low-level exec ───────────────────────────────────────────────────── */
  const exec = async (command: string, cwd_: string, signal?: AbortSignal) => {
    const res = await fetch('/api/v1/terminal/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, cwd: cwd_ }),
      signal,
    })
    return res.json() as Promise<{ stdout: string; stderr: string; exit_code: number; cwd: string }>
  }

  /* ── submit ───────────────────────────────────────────────────────────── */
  const submit = async (cmd: string) => {
    const trimmed = cmd.trim()
    if (!trimmed || running) return

    setInput('')
    setHint('')
    setHistIdx(-1)
    setCmdHist(h => [trimmed, ...h.filter(x => x !== trimmed).slice(0, 99)])

    const promptStr = `root@${host}:${shortCwd(cwd)}# ${trimmed}`
    setLines(prev => [...prev, { kind: 'cmd', text: promptStr }])
    setRunning(true)

    abortRef.current = new AbortController()
    try {
      const data = await exec(trimmed, cwd, abortRef.current.signal)
      if (data.cwd) setCwd(data.cwd)

      setLines(prev => {
        const next = [...prev]
        strip(data.stdout ?? '').split('\n').forEach(l => { if (l) next.push({ kind: 'out', text: l }) })
        strip(data.stderr ?? '').split('\n').forEach(l => { if (l) next.push({ kind: 'err', text: l }) })
        if (data.exit_code !== 0 && !data.stderr?.trim() && !data.stdout?.trim()) {
          next.push({ kind: 'err', text: `[exit ${data.exit_code}]` })
        }
        return next
      })
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') {
        setLines(prev => [...prev, { kind: 'err', text: `error: ${(e as Error).message}` }])
      } else {
        setLines(prev => [...prev, { kind: 'sys', text: '^C' }])
      }
    } finally {
      setRunning(false)
      abortRef.current = null
      focusInput()
    }
  }

  /* ── keyboard ─────────────────────────────────────────────────────────── */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit(input)
      return
    }
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault()
      if (running) {
        abortRef.current?.abort()
      } else {
        setLines(prev => [...prev, { kind: 'sys', text: `root@${host}:${shortCwd(cwd)}# ${input}^C` }])
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
      setInput(val); computeHint(val)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const idx = Math.max(histIdx - 1, -1)
      setHistIdx(idx)
      const val = idx === -1 ? '' : cmdHist[idx]
      setInput(val); computeHint(val)
      return
    }
  }

  /* ─── render ──────────────────────────────────────────────────────────── */
  const lineColor: Record<Line['kind'], string> = {
    out: C.out, err: C.err, cmd: C.cmd, sys: C.sys,
  }

  return (
    <div
      style={{ background: C.bg, fontFamily: '"JetBrains Mono","Fira Code","Cascadia Code",ui-monospace,monospace' }}
      className="flex flex-col h-[calc(100vh-0px)] cursor-text select-none"
      onClick={focusInput}
    >
      {/* ── title bar ──────────────────────────────────────────────────── */}
      <div
        style={{ background: C.bar, borderBottom: `1px solid ${C.border}` }}
        className="flex items-center justify-between px-4 py-2 shrink-0"
      >
        <div className="flex items-center gap-1.5">
          {/* traffic lights */}
          <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <div className="w-3 h-3 rounded-full bg-[#28c840]" />
          <span className="ml-3 text-xs" style={{ color: C.muted }}>
            root@{host} — bash
          </span>
        </div>
        <div className="flex items-center gap-4">
          {running && (
            <button
              onClick={e => { e.stopPropagation(); abortRef.current?.abort() }}
              style={{ color: C.err, border: `1px solid ${C.err}40` }}
              className="text-xs px-2 py-0.5 rounded font-mono"
            >
              ■ stop
            </button>
          )}
          <button
            onClick={e => { e.stopPropagation(); setLines([]) }}
            style={{ color: C.muted }}
            className="text-xs font-mono hover:opacity-80"
          >
            clear
          </button>
        </div>
      </div>

      {/* ── output ─────────────────────────────────────────────────────── */}
      <div
        ref={termRef}
        className="flex-1 overflow-y-auto p-4 text-[13px] leading-[1.6] select-text"
      >
        {/* history lines */}
        {lines.map((l, i) => (
          <div key={i} style={{ color: lineColor[l.kind], whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {l.text || ' '}
          </div>
        ))}

        {/* ── current prompt line ─────────────────────────────────────── */}
        {/* Plain block div with inline spans — no flex, no baseline issues */}
        <div style={{ whiteSpace: 'pre' }}>
          <span style={{ color: C.prompt_g }}>root@{host}</span>
          <span style={{ color: C.muted }}>:</span>
          <span style={{ color: C.prompt_c }}>{shortCwd(cwd)}</span>
          <span style={{ color: C.prompt_w }}># </span>
          <span style={{ color: C.prompt_w }}>{input}</span>
          {hint && <span style={{ color: C.muted }}>{hint}</span>}
          {/* cursor: block char that blinks */}
          <span
            style={{
              display: 'inline-block',
              width: '0.55em',
              height: '1.1em',
              background: running ? '#febc2e' : C.cursor,
              verticalAlign: 'text-bottom',
              marginLeft: '1px',
              animation: running ? 'none' : 'blink 1s step-end infinite',
            }}
          />
        </div>
      </div>

      {/* ── hidden input ────────────────────────────────────────────────── */}
      {/* opacity-0 keeps it invisible but focusable; pointer-events-none removed
          so the browser can still focus it programmatically */}
      <input
        ref={inputRef}
        type="text"
        value={input}
        autoFocus
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        readOnly={running}
        onChange={e => { if (!running) { setInput(e.target.value); computeHint(e.target.value); setHistIdx(-1) } }}
        onKeyDown={onKeyDown}
        style={{
          position: 'fixed',
          top: '-200px',
          left: '-200px',
          width: '1px',
          height: '1px',
          opacity: 0,
          border: 'none',
          outline: 'none',
        }}
        aria-hidden="true"
      />
    </div>
  )
}
