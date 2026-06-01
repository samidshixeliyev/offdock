import { useEffect, useRef, useState, useCallback } from 'react'
import { api, ContainerInfo, ContainerStats } from '../api/client'
import XTerminal from '../components/XTerminal'
import clsx from 'clsx'

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parsePercent(s: string) {
  return parseFloat(s?.replace('%', '') ?? '0') || 0
}

function stateStyle(state: string) {
  switch (state?.toLowerCase()) {
    case 'running': return { dot: 'bg-green-400 animate-pulse', badge: 'bg-green-950/60 text-green-300 border-green-900/50' }
    case 'exited':  return { dot: 'bg-red-500',                 badge: 'bg-red-950/60  text-red-300  border-red-900/50'  }
    case 'paused':  return { dot: 'bg-yellow-400',              badge: 'bg-yellow-950/60 text-yellow-300 border-yellow-900/50' }
    case 'created': return { dot: 'bg-blue-400',                badge: 'bg-blue-950/60 text-blue-300 border-blue-900/50' }
    default:        return { dot: 'bg-slate-500',                badge: 'bg-slate-800 text-slate-400 border-slate-700' }
  }
}

// ─── Full-screen Logs Modal ───────────────────────────────────────────────────
function LogsModal({ name, onClose }: { name: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [showTs, setShowTs] = useState(false)
  const [follow, setFollow] = useState(true)
  const [tail, setTail] = useState(200)
  const [fullscreen, setFullscreen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  const connect = useCallback((tailN: number) => {
    esRef.current?.close()
    setLines([])
    const es = new EventSource(`/api/v1/containers/${encodeURIComponent(name)}/logs?tail=${tailN}`)
    esRef.current = es
    es.onmessage = e => {
      try {
        const d = JSON.parse(e.data as string) as { line: string }
        setLines(prev => [...prev.slice(-4999), d.line])
      } catch {}
    }
    es.onerror = () => es.close()
  }, [name])

  useEffect(() => { connect(tail); return () => esRef.current?.close() }, [name])

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines, follow])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stripTs = (l: string) =>
    showTs ? l : l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s?/, '')

  const filtered = filter
    ? lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()))
    : lines

  const lineColor = (l: string) => {
    const lc = l.toLowerCase()
    if (lc.includes('error') || lc.includes('fatal') || lc.includes('panic')) return 'text-red-400'
    if (lc.includes('warn')) return 'text-yellow-400'
    if (lc.includes('info')) return 'text-blue-300'
    if (lc.includes('debug')) return 'text-slate-500'
    return 'text-green-300'
  }

  const download = () => {
    const text = filtered.map(stripTs).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    a.download = `${name}-logs.txt`
    a.click()
  }

  return (
    <div className={clsx(
      'fixed bg-black/80 flex items-center justify-center z-50',
      fullscreen ? 'inset-0' : 'inset-0'
    )}>
      <div className={clsx(
        'bg-slate-900 border border-slate-700 rounded-xl flex flex-col shadow-2xl',
        fullscreen ? 'w-full h-full rounded-none' : 'w-full max-w-6xl'
      )} style={fullscreen ? {} : { height: '88vh' }}>
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 shrink-0 flex-wrap">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">Live Logs</p>
            <p className="text-xs text-slate-500 font-mono truncate">{name}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-600" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd"/>
              </svg>
              <input className="input pl-7 text-xs w-36 py-1.5" placeholder="Filter…"
                value={filter} onChange={e => setFilter(e.target.value)} />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
              <input type="checkbox" checked={showTs} onChange={e => setShowTs(e.target.checked)} />
              Timestamps
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
              <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />
              Follow
            </label>
            <select className="input text-xs py-1.5 w-24"
              value={tail} onChange={e => { setTail(Number(e.target.value)); connect(Number(e.target.value)) }}>
              <option value={50}>50 lines</option>
              <option value={200}>200 lines</option>
              <option value={500}>500 lines</option>
              <option value={1000}>1000 lines</option>
              <option value={0}>All</option>
            </select>
            <button onClick={() => connect(tail)} className="btn-ghost text-xs py-1.5">↻ Reload</button>
            <button onClick={() => setLines([])} className="btn-ghost text-xs py-1.5">Clear</button>
            <button onClick={download} className="btn-ghost text-xs py-1.5" title="Download logs">↓</button>
            <button onClick={() => setFullscreen(f => !f)}
              className="btn-ghost text-xs py-1.5" title="Toggle fullscreen">
              {fullscreen ? '⊡' : '⊞'}
            </button>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none ml-1">×</button>
        </div>

        {/* Log view */}
        <div ref={ref} className="flex-1 overflow-y-auto min-h-0 p-4 font-mono text-xs leading-relaxed bg-slate-950">
          {lines.length === 0
            ? <span className="text-slate-600 animate-pulse">Connecting…</span>
            : filtered.length === 0
              ? <span className="text-slate-600">No lines match "{filter}"</span>
              : filtered.map((l, i) => (
                  <div key={i} className={lineColor(stripTs(l))}>{stripTs(l) || ' '}</div>
                ))
          }
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-slate-800 shrink-0 flex items-center justify-between">
          <span className="text-xs text-slate-600">
            {filtered.length}{filter ? ` of ${lines.length}` : ''} lines
          </span>
          <span className="text-xs text-slate-600">ESC to close · Ctrl+Shift+C to copy</span>
        </div>
      </div>
    </div>
  )
}

// ─── Full-screen Exec Modal ───────────────────────────────────────────────────
function ExecModal({ name, onClose }: { name: string; onClose: () => void }) {
  const [shell, setShell] = useState('sh')
  const [key, setKey] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const wsUrl = `/api/v1/terminal/container/ws?container=${encodeURIComponent(name)}&shell=${shell}`

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !fullscreen) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, fullscreen])

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div
        className={clsx(
          'border border-[#30363d] flex flex-col shadow-2xl',
          fullscreen ? 'fixed inset-0 rounded-none' : 'w-full max-w-5xl rounded-xl'
        )}
        style={fullscreen ? { background: '#0d1117' } : { background: '#0d1117', height: '82vh' }}
      >
        {/* Title bar */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#30363d] shrink-0"
          style={{ background: '#161b22' }}>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
            <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
            <div className="w-3 h-3 rounded-full bg-[#28c840]" />
          </div>
          <span className="text-xs font-mono flex-1" style={{ color: '#484f58' }}>
            docker exec -it <span style={{ color: '#79c0ff' }}>{name}</span> {shell}
          </span>
          <div className="flex items-center gap-1">
            {(['sh', 'bash', 'zsh'] as const).map(s => (
              <button key={s} onClick={() => { setShell(s); setKey(k => k + 1) }}
                className={`text-xs px-2 py-0.5 rounded font-mono transition-colors ${
                  shell === s
                    ? 'bg-[#79c0ff]/20 text-[#79c0ff] border border-[#79c0ff]/30'
                    : 'text-[#484f58] hover:text-[#c9d1d9] border border-[#30363d]'
                }`}>
                {s}
              </button>
            ))}
          </div>
          <button onClick={() => setKey(k => k + 1)}
            className="text-xs font-mono hover:opacity-80 ml-2 px-1.5" style={{ color: '#484f58' }}>
            ↺
          </button>
          <button onClick={() => setFullscreen(f => !f)}
            className="text-xs font-mono hover:opacity-80 px-1.5" style={{ color: '#484f58' }}
            title="Toggle fullscreen">
            {fullscreen ? '⊡' : '⊞'}
          </button>
          <button onClick={onClose} className="hover:opacity-80 text-lg leading-none ml-1"
            style={{ color: '#484f58' }}>×</button>
        </div>

        <div className="flex-1 min-h-0 relative">
          <div className="absolute inset-0 text-[10px] text-right pr-3 pt-1 pointer-events-none"
            style={{ color: '#30363d' }}>
            Ctrl+Shift+C copy · Ctrl+Shift+V paste · right-click menu
          </div>
          <XTerminal key={`${name}-${shell}-${key}`} wsUrl={wsUrl} className="w-full h-full" style={{ padding: '8px' }} />
        </div>
      </div>
    </div>
  )
}

// ─── Metrics bar ─────────────────────────────────────────────────────────────
function MetricsBar({ stat }: { stat: ContainerStats }) {
  const cpu = parsePercent(stat.CPUPerc)
  const mem = parsePercent(stat.MemPerc)

  const cpuColor = cpu > 80 ? 'bg-red-500' : cpu > 50 ? 'bg-yellow-500' : 'bg-blue-500'
  const memColor = mem > 80 ? 'bg-red-500' : mem > 60 ? 'bg-yellow-500' : 'bg-green-500'

  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="flex items-center gap-1.5 min-w-[90px]">
        <span className="text-slate-600 w-7 shrink-0">CPU</span>
        <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden w-14">
          <div className={`h-full rounded-full ${cpuColor}`} style={{ width: `${Math.min(cpu, 100)}%` }} />
        </div>
        <span className="text-slate-400 tabular-nums w-9 text-right">{stat.CPUPerc}</span>
      </div>
      <div className="flex items-center gap-1.5 min-w-[120px]">
        <span className="text-slate-600 w-7 shrink-0">MEM</span>
        <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden w-14">
          <div className={`h-full rounded-full ${memColor}`} style={{ width: `${Math.min(mem, 100)}%` }} />
        </div>
        <span className="text-slate-400 tabular-nums w-9 text-right">{stat.MemPerc}</span>
      </div>
      <span className="text-slate-600 hidden lg:inline tabular-nums">{stat.NetIO}</span>
    </div>
  )
}

// ─── Delete confirmation ───────────────────────────────────────────────────────
function DeleteConfirm({ name, onConfirm, onCancel }: {
  name: string; onConfirm: () => void; onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-red-900/50 rounded-xl p-6 w-full max-w-sm shadow-2xl">
        <h3 className="text-sm font-semibold text-white mb-2">Delete Container?</h3>
        <p className="text-xs text-slate-400 mb-5">
          This will force-remove <span className="font-mono text-slate-200">{name}</span>.
          Any unsaved data inside the container will be lost.
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="btn-ghost text-xs">Cancel</button>
          <button onClick={onConfirm}
            className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium transition-colors">
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ContainersPage() {
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [stats, setStats] = useState<Record<string, ContainerStats>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<'all' | 'running' | 'exited'>('all')
  const [actionBusy, setActionBusy] = useState('')
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [execFor, setExecFor] = useState<string | null>(null)
  const [deleteFor, setDeleteFor] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [msg, setMsg] = useState('')
  const [msgErr, setMsgErr] = useState(false)
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = async () => {
    setLoading(true)
    try { setContainers(await api.listAllContainers()) } catch {}
    setLoading(false)
  }

  const loadStats = async () => {
    try {
      const s = await api.containerStats()
      const map: Record<string, ContainerStats> = {}
      for (const st of s) map[st.name] = st
      setStats(map)
    } catch {}
  }

  useEffect(() => {
    load()
    loadStats()
    statsTimerRef.current = setInterval(loadStats, 4000)
    return () => { if (statsTimerRef.current) clearInterval(statsTimerRef.current) }
  }, [])

  const showMsg = (text: string, err = false) => {
    setMsg(text); setMsgErr(err)
    setTimeout(() => setMsg(''), 3000)
  }

  const doAction = async (name: string, action: 'restart' | 'stop' | 'start') => {
    setActionBusy(name + ':' + action)
    try {
      await api.globalContainerAction(name, action)
      showMsg(`${action} → ${name}`)
      setTimeout(load, 1200)
    } catch (e) { showMsg(e instanceof Error ? e.message : 'Failed', true) }
    setActionBusy('')
  }

  const doDelete = async (name: string) => {
    setDeleteFor(null)
    setActionBusy(name + ':delete')
    try {
      await api.deleteContainer(name)
      showMsg(`Deleted ${name}`)
      setSelected(s => { const n = new Set(s); n.delete(name); return n })
      await load()
    } catch (e) { showMsg(e instanceof Error ? e.message : 'Delete failed', true) }
    setActionBusy('')
  }

  const doBulkAction = async (action: 'stop' | 'start' | 'restart' | 'delete') => {
    for (const name of selected) {
      if (action === 'delete') {
        try { await api.deleteContainer(name) } catch {}
      } else {
        try { await api.globalContainerAction(name, action) } catch {}
      }
    }
    setSelected(new Set())
    showMsg(`${action} applied to ${selected.size} container(s)`)
    setTimeout(load, 1200)
  }

  const toggleSelect = (name: string) => {
    setSelected(s => {
      const n = new Set(s)
      if (n.has(name)) n.delete(name); else n.add(name)
      return n
    })
  }

  const toggleAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map(c => c.Names)))
    }
  }

  const filtered = containers.filter(c => {
    const matchSearch = !search ||
      c.Names.toLowerCase().includes(search.toLowerCase()) ||
      c.Image.toLowerCase().includes(search.toLowerCase())
    const matchState = stateFilter === 'all' || c.State?.toLowerCase() === stateFilter
    return matchSearch && matchState
  })

  const counts = {
    all: containers.length,
    running: containers.filter(c => c.State?.toLowerCase() === 'running').length,
    exited: containers.filter(c => c.State?.toLowerCase() === 'exited').length,
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-full">
      {logsFor && <LogsModal name={logsFor} onClose={() => setLogsFor(null)} />}
      {execFor && <ExecModal name={execFor} onClose={() => setExecFor(null)} />}
      {deleteFor && (
        <DeleteConfirm
          name={deleteFor}
          onConfirm={() => doDelete(deleteFor)}
          onCancel={() => setDeleteFor(null)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-semibold text-white">Containers</h1>
          <p className="text-xs text-slate-600 mt-0.5">
            <span className="text-green-400">{counts.running} running</span>
            {counts.exited > 0 && <> · <span className="text-red-400">{counts.exited} exited</span></>}
            {' '}· {counts.all} total
          </p>
        </div>
        <div className="flex items-center gap-2">
          {msg && (
            <span className={`text-xs px-2 py-1 rounded border ${
              msgErr ? 'bg-red-950/60 text-red-300 border-red-900/40' : 'bg-green-950/60 text-green-300 border-green-900/40'
            }`}>{msg}</span>
          )}
          <button onClick={load} className="btn-ghost text-xs">↻ Refresh</button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-600" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
          <input className="input pl-8 text-xs w-full" placeholder="Search name or image…"
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1">
          {(['all', 'running', 'exited'] as const).map(f => (
            <button key={f} onClick={() => setStateFilter(f)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                stateFilter === f
                  ? 'bg-blue-600/20 text-blue-300 border-blue-700/50'
                  : 'text-slate-500 border-slate-800 hover:text-slate-300 hover:border-slate-700'
              }`}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
              <span className="ml-1.5 text-slate-600 tabular-nums">{counts[f]}</span>
            </button>
          ))}
        </div>

        {/* Bulk actions — visible when anything is selected */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 ml-auto pl-3 border-l border-slate-800">
            <span className="text-xs text-slate-500">{selected.size} selected</span>
            <button onClick={() => doBulkAction('start')}
              className="text-xs px-2 py-1 rounded border border-slate-700 text-green-400 hover:bg-green-950/30 transition-colors">
              Start all
            </button>
            <button onClick={() => doBulkAction('stop')}
              className="text-xs px-2 py-1 rounded border border-slate-700 text-yellow-400 hover:bg-yellow-950/30 transition-colors">
              Stop all
            </button>
            <button onClick={() => doBulkAction('restart')}
              className="text-xs px-2 py-1 rounded border border-slate-700 text-blue-400 hover:bg-blue-950/30 transition-colors">
              Restart all
            </button>
            <button onClick={() => {
              if (window.confirm(`Delete ${selected.size} container(s)?`)) doBulkAction('delete')
            }}
              className="text-xs px-2 py-1 rounded border border-red-900/50 text-red-400 hover:bg-red-950/30 transition-colors">
              Delete all
            </button>
            <button onClick={() => setSelected(new Set())} className="text-xs text-slate-600 hover:text-slate-300">✕</button>
          </div>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="card text-center py-16 text-slate-600 text-sm">
          <div className="w-5 h-5 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin mx-auto mb-3" />
          Loading containers…
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-16 text-sm border-dashed">
          {containers.length === 0 ? (
            <>
              <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center mx-auto mb-3">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5 text-slate-600">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
                </svg>
              </div>
              <p className="text-slate-500 text-sm mb-1">No containers running</p>
              <p className="text-slate-700 text-xs">Start a deployment to create containers</p>
            </>
          ) : (
            <p className="text-slate-600">{`No containers match "${search || stateFilter}"`}</p>
          )}
        </div>
      ) : (
        <div className="card p-0 overflow-x-auto">
          <table className="w-full text-sm min-w-[800px]">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-3 w-8">
                  <input type="checkbox"
                    className="rounded border-slate-700 bg-slate-800 cursor-pointer"
                    checked={selected.size === filtered.length && filtered.length > 0}
                    onChange={toggleAll}
                  />
                </th>
                <th className="text-left px-3 py-3 text-xs font-medium text-slate-500 w-6"></th>
                <th className="text-left px-3 py-3 text-xs font-medium text-slate-500">Name</th>
                <th className="text-left px-3 py-3 text-xs font-medium text-slate-500">Image</th>
                <th className="text-left px-3 py-3 text-xs font-medium text-slate-500">State</th>
                <th className="text-left px-3 py-3 text-xs font-medium text-slate-500">Ports</th>
                <th className="text-left px-3 py-3 text-xs font-medium text-slate-500 hidden xl:table-cell">Metrics</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => {
                const s = stateStyle(c.State)
                const isRunning = c.State?.toLowerCase() === 'running'
                const isBusy = actionBusy.startsWith(c.Names + ':')
                const isSelected = selected.has(c.Names)
                const stat = stats[c.Names]

                return (
                  <tr key={c.ID}
                    className={clsx(
                      'border-b border-slate-800/40 transition-colors',
                      isSelected ? 'bg-blue-950/20' : 'hover:bg-slate-800/20'
                    )}>
                    {/* Checkbox */}
                    <td className="px-4 py-3">
                      <input type="checkbox"
                        className="rounded border-slate-700 bg-slate-800 cursor-pointer"
                        checked={isSelected}
                        onChange={() => toggleSelect(c.Names)}
                      />
                    </td>

                    {/* Status dot */}
                    <td className="px-3 py-3">
                      <span className={`w-2 h-2 rounded-full block ${s.dot}`} />
                    </td>

                    {/* Name */}
                    <td className="px-3 py-3">
                      <span className="font-mono text-sm text-slate-200 font-medium">{c.Names}</span>
                    </td>

                    {/* Image */}
                    <td className="px-3 py-3 text-xs text-slate-500 font-mono max-w-[200px]">
                      <span className="truncate block" title={c.Image}>{c.Image}</span>
                    </td>

                    {/* State badge */}
                    <td className="px-3 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${s.badge}`}>
                        {c.Status || c.State}
                      </span>
                    </td>

                    {/* Ports */}
                    <td className="px-3 py-3 text-xs text-slate-600 font-mono max-w-[160px]">
                      <span className="truncate block" title={c.Ports}>{c.Ports || '—'}</span>
                    </td>

                    {/* Metrics */}
                    <td className="px-3 py-3 hidden xl:table-cell">
                      {stat
                        ? <MetricsBar stat={stat} />
                        : isRunning
                          ? <span className="text-xs text-slate-700">collecting…</span>
                          : <span className="text-xs text-slate-700">—</span>
                      }
                    </td>

                    {/* Actions */}
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1.5 justify-end">
                        <button onClick={() => setLogsFor(c.Names)}
                          className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
                          title="View logs">
                          Logs
                        </button>
                        {isRunning && (
                          <button onClick={() => setExecFor(c.Names)}
                            className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
                            title="Open terminal">
                            Exec
                          </button>
                        )}
                        <button onClick={() => doAction(c.Names, 'restart')} disabled={isBusy}
                          className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 transition-colors px-1.5"
                          title="Restart">
                          {actionBusy === c.Names + ':restart' ? (
                            <span className="animate-pulse">…</span>
                          ) : '↺'}
                        </button>
                        {isRunning ? (
                          <button onClick={() => doAction(c.Names, 'stop')} disabled={isBusy}
                            className="text-xs text-yellow-400 hover:text-yellow-300 disabled:opacity-40 transition-colors px-1.5"
                            title="Stop">
                            {actionBusy === c.Names + ':stop' ? '…' : '⏹'}
                          </button>
                        ) : (
                          <button onClick={() => doAction(c.Names, 'start')} disabled={isBusy}
                            className="text-xs text-green-400 hover:text-green-300 disabled:opacity-40 transition-colors px-1.5"
                            title="Start">
                            {actionBusy === c.Names + ':start' ? '…' : '▶'}
                          </button>
                        )}
                        <button onClick={() => setDeleteFor(c.Names)} disabled={isBusy}
                          className="text-xs text-red-500 hover:text-red-400 disabled:opacity-40 transition-colors px-1.5"
                          title="Delete container">
                          {actionBusy === c.Names + ':delete' ? '…' : '✕'}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
