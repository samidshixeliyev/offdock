import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ContainerInfo, TraceEvent } from '../api/client'
import { useToast } from '../components/Toast'
import { useAuth } from '../hooks/useAuth'
import {
  Radio, Globe, Database, Zap, Activity, RefreshCw,
  Trash2, ChevronDown, ChevronRight, Filter, X,
  Container as ContainerIcon, Play, Square,
} from 'lucide-react'
import clsx from 'clsx'

// ─── Types ────────────────────────────────────────────────────────────────────

type SpanKind = 'sql' | 'redis' | 'http_resp'

interface ChildSpan {
  id: number
  kind: SpanKind
  time: string
  query?: string
  db_type?: string
  status?: number
  duration_ms?: number
  src?: string
  dst?: string
}

interface Transaction {
  id: number
  time: string
  method: string
  path: string
  host?: string
  src?: string
  dst?: string
  startedAt: number          // ms epoch when the http_req arrived (for the 500ms grouping window)
  status?: number            // populated when matching http_resp arrives
  duration_ms?: number       // populated when matching http_resp arrives
  children: ChildSpan[]
}

type FilterMode = 'all' | 'http' | 'sql' | 'redis' | 'errors'

const MAX_TRANSACTIONS = 200
const GROUP_WINDOW_MS = 500

// ─── Color helpers ────────────────────────────────────────────────────────────

function methodColor(m: string): string {
  switch (m.toUpperCase()) {
    case 'GET': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
    case 'POST': return 'text-blue-400 bg-blue-500/10 border-blue-500/20'
    case 'PUT':
    case 'PATCH': return 'text-amber-400 bg-amber-500/10 border-amber-500/20'
    case 'DELETE': return 'text-red-400 bg-red-500/10 border-red-500/20'
    default: return 'text-slate-400 bg-slate-700/30 border-slate-600/30'
  }
}

function methodDotColor(m: string): string {
  switch (m.toUpperCase()) {
    case 'GET': return 'bg-emerald-400'
    case 'POST': return 'bg-blue-400'
    case 'PUT':
    case 'PATCH': return 'bg-amber-400'
    case 'DELETE': return 'bg-red-400'
    default: return 'bg-slate-500'
  }
}

function statusTextColor(s: number): string {
  if (s >= 500) return 'text-red-400'
  if (s >= 400) return 'text-amber-400'
  if (s >= 300) return 'text-blue-400'
  return 'text-emerald-400'
}

function statusBadgeColor(s: number): string {
  if (s >= 500) return 'text-red-400 bg-red-500/10 border-red-500/20'
  if (s >= 400) return 'text-amber-400 bg-amber-500/10 border-amber-500/20'
  if (s >= 300) return 'text-blue-400 bg-blue-500/10 border-blue-500/20'
  return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
}

function durationColor(ms: number): string {
  if (ms > 2000) return 'text-red-400'
  if (ms > 500) return 'text-amber-400'
  return 'text-emerald-400'
}

function durationBarColor(ms: number): string {
  if (ms > 2000) return 'bg-red-500/60'
  if (ms > 500) return 'bg-amber-500/60'
  return 'bg-emerald-500/60'
}

function fmtDuration(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(2) + 's'
  return ms.toFixed(0) + 'ms'
}

// ─── Transaction grouping ─────────────────────────────────────────────────────
//
// A transaction begins with an http_req event. Subsequent sql / redis / http_resp
// events that arrive within GROUP_WINDOW_MS are attached to the most recent
// unmatched http_req from the same src→dst pair. http_resp also closes (matches)
// the transaction so later events open a new window.

function ingestEvent(
  prev: Transaction[],
  ev: TraceEvent,
  now: number,
  nextId: () => number,
): Transaction[] {
  // New request — open a transaction.
  if (ev.type === 'http_req') {
    const tx: Transaction = {
      id: nextId(),
      time: ev.time,
      method: ev.method ?? 'GET',
      path: ev.path ?? '/',
      host: ev.host,
      src: ev.src,
      dst: ev.dst,
      startedAt: now,
      children: [],
    }
    const next = [...prev, tx]
    return next.length > MAX_TRANSACTIONS ? next.slice(-MAX_TRANSACTIONS) : next
  }

  // Child / response events — try to attach to a recent matching request.
  if (ev.type === 'sql' || ev.type === 'redis' || ev.type === 'http_resp') {
    // Search newest-first for an open request within the time window.
    let matchIdx = -1
    for (let i = prev.length - 1; i >= 0; i--) {
      const tx = prev[i]
      if (now - tx.startedAt > GROUP_WINDOW_MS) break // older than window — stop scanning
      const sameRoute = sameEndpoint(tx, ev)
      if (ev.type === 'http_resp') {
        // Response closes the matching request (only if not already closed).
        if (sameRoute && tx.status === undefined) { matchIdx = i; break }
      } else {
        // sql / redis attach to the most recent open request.
        if (sameRoute && tx.status === undefined) { matchIdx = i; break }
        if (matchIdx === -1 && tx.status === undefined) matchIdx = i
      }
    }

    if (matchIdx === -1) return prev // orphan event — drop (no parent request in window)

    const child: ChildSpan = {
      id: nextId(),
      kind: ev.type,
      time: ev.time,
      query: ev.query,
      db_type: ev.db_type,
      status: ev.status,
      duration_ms: ev.duration_ms,
      src: ev.src,
      dst: ev.dst,
    }

    return prev.map((tx, i) => {
      if (i !== matchIdx) return tx
      if (ev.type === 'http_resp') {
        return {
          ...tx,
          status: ev.status,
          duration_ms: ev.duration_ms,
          children: [...tx.children, child],
        }
      }
      return { ...tx, children: [...tx.children, child] }
    })
  }

  // info / error events are not part of the waterfall.
  return prev
}

// Match a child/response event to a request transaction by endpoint.
// Requests are src→dst (client→server); responses flow dst→src, so we match
// either direction.
function sameEndpoint(tx: Transaction, ev: TraceEvent): boolean {
  if (!tx.src && !tx.dst) return true
  if (ev.src === tx.src && ev.dst === tx.dst) return true
  if (ev.src === tx.dst && ev.dst === tx.src) return true
  // Fall back to host endpoint comparison when ports differ.
  return false
}

// ─── Stat bar ─────────────────────────────────────────────────────────────────

interface Stats {
  total: number
  errors: number
  avgMs: number
  sql: number
  redis: number
}

function StatCard({ icon: Icon, label, value, color }: {
  icon: typeof Globe
  label: string
  value: string
  color: string
}) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-slate-900/60 border border-slate-800">
      <Icon className={clsx('w-4 h-4 shrink-0', color)} />
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-slate-600 leading-none">{label}</p>
        <p className="text-sm font-semibold text-slate-200 tabular-nums mt-0.5">{value}</p>
      </div>
    </div>
  )
}

// ─── Child span row ───────────────────────────────────────────────────────────

function childIcon(kind: SpanKind) {
  switch (kind) {
    case 'sql': return <Database className="w-3 h-3 text-amber-400 shrink-0" />
    case 'redis': return <Zap className="w-3 h-3 text-red-400 shrink-0" />
    case 'http_resp': return <Globe className="w-3 h-3 text-indigo-400 shrink-0" />
  }
}

function ChildSpanRow({ span, last }: { span: ChildSpan; last: boolean }) {
  return (
    <div className="flex items-start gap-2 pl-8 pr-4 py-1.5 text-[11px] font-mono hover:bg-slate-800/20">
      <span className="text-slate-700 select-none">{last ? '└─' : '├─'}</span>
      {childIcon(span.kind)}

      {span.kind === 'sql' && (
        <>
          <span className="text-amber-300/90 font-bold text-[10px] uppercase w-10 shrink-0">SQL</span>
          <pre className="flex-1 min-w-0 text-amber-200/80 whitespace-pre-wrap break-all leading-relaxed">{span.query}</pre>
          {span.db_type && <span className="text-[10px] text-amber-500/60 uppercase shrink-0">{span.db_type}</span>}
        </>
      )}

      {span.kind === 'redis' && (
        <>
          <span className="text-red-300/90 font-bold text-[10px] uppercase w-10 shrink-0">REDIS</span>
          <pre className="flex-1 min-w-0 text-red-200/80 whitespace-pre-wrap break-all leading-relaxed">{span.query}</pre>
        </>
      )}

      {span.kind === 'http_resp' && (
        <>
          <span className="text-indigo-300/90 font-bold text-[10px] uppercase w-10 shrink-0">RESP</span>
          <span className={clsx('flex-1 min-w-0 font-bold', statusTextColor(span.status ?? 0))}>{span.status ?? '—'}</span>
          {span.duration_ms !== undefined && span.duration_ms > 0 && (
            <span className={clsx('shrink-0 font-semibold', durationColor(span.duration_ms))}>
              {fmtDuration(span.duration_ms)}
            </span>
          )}
        </>
      )}
    </div>
  )
}

// ─── Transaction row (waterfall) ──────────────────────────────────────────────

function TransactionRow({ tx, maxDuration }: { tx: Transaction; maxDuration: number }) {
  const [expanded, setExpanded] = useState(false)
  const dur = tx.duration_ms ?? 0
  const barWidth = maxDuration > 0 ? Math.min(100, (dur / maxDuration) * 100) : 0
  const sqlCount = tx.children.filter(c => c.kind === 'sql').length
  const redisCount = tx.children.filter(c => c.kind === 'redis').length
  const hasChildren = tx.children.length > 0

  return (
    <div className="border-b border-slate-800/50">
      <div
        onClick={() => hasChildren && setExpanded(e => !e)}
        className={clsx(
          'flex items-center gap-3 px-4 py-2.5 text-xs font-mono transition-colors',
          hasChildren && 'cursor-pointer hover:bg-slate-800/25',
        )}
      >
        {/* Expand chevron */}
        <span className="w-3.5 shrink-0 text-slate-600">
          {hasChildren ? (expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />) : null}
        </span>

        {/* Timestamp */}
        <span className="text-slate-600 w-20 shrink-0 tabular-nums">{tx.time}</span>

        {/* Colored dot + method badge */}
        <span className={clsx('w-2 h-2 rounded-full shrink-0', methodDotColor(tx.method))} />
        <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold border shrink-0 w-16 text-center', methodColor(tx.method))}>
          {tx.method}
        </span>

        {/* Path */}
        <span className="text-slate-200 truncate flex-1 min-w-0" title={tx.path}>{tx.path}</span>

        {/* Nested span counts */}
        <div className="flex items-center gap-1.5 shrink-0">
          {sqlCount > 0 && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/20">
              <Database className="w-2.5 h-2.5" />{sqlCount}
            </span>
          )}
          {redisCount > 0 && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-500/10 text-red-300 border border-red-500/20">
              <Zap className="w-2.5 h-2.5" />{redisCount}
            </span>
          )}
        </div>

        {/* Status badge */}
        <span className="w-12 shrink-0 text-right">
          {tx.status !== undefined ? (
            <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold border', statusBadgeColor(tx.status))}>
              {tx.status}
            </span>
          ) : (
            <span className="text-slate-700 text-[10px]">…</span>
          )}
        </span>

        {/* Duration bar (waterfall) */}
        <div className="w-28 shrink-0 h-3.5 rounded bg-slate-800/40 overflow-hidden relative">
          {dur > 0 && (
            <div
              className={clsx('h-full rounded transition-all', durationBarColor(dur))}
              style={{ width: `${barWidth}%` }}
            />
          )}
        </div>

        {/* Duration text */}
        <span className={clsx('w-14 shrink-0 text-right font-semibold tabular-nums', dur > 0 ? durationColor(dur) : 'text-slate-700')}>
          {dur > 0 ? fmtDuration(dur) : '—'}
        </span>
      </div>

      {/* Expanded child spans */}
      {expanded && hasChildren && (
        <div className="bg-slate-950/40 border-t border-slate-800/40 py-1">
          {tx.children.map((c, i) => (
            <ChildSpanRow key={c.id} span={c} last={i === tx.children.length - 1} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Live trace panel (waterfall + stats) ─────────────────────────────────────

function LiveTracePanel({ container, onStop }: { container: string; onStop: () => void }) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting')
  const [filter, setFilter] = useState<FilterMode>('all')
  const [autoScroll, setAutoScroll] = useState(true)

  const esRef = useRef<EventSource | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const idRef = useRef(0)
  // Running tally of all response times (kept outside React state to avoid re-deriving every render).
  const respStatsRef = useRef<{ count: number; totalMs: number }>({ count: 0, totalMs: 0 })
  const [respStats, setRespStats] = useState<{ count: number; totalMs: number }>({ count: 0, totalMs: 0 })

  useEffect(() => {
    const es = new EventSource(api.traceUrl(container))
    esRef.current = es

    es.onopen = () => setStatus('live')
    es.onerror = () => { setStatus('error'); es.close() }
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as TraceEvent
        const now = Date.now()
        const nextId = () => ++idRef.current

        if (data.type === 'http_resp' && data.duration_ms !== undefined && data.duration_ms > 0) {
          respStatsRef.current.count += 1
          respStatsRef.current.totalMs += data.duration_ms
          setRespStats({ ...respStatsRef.current })
        }

        setTransactions(prev => ingestEvent(prev, data, now, nextId))
      } catch {
        // ignore malformed SSE payloads
      }
    }

    return () => { es.close(); esRef.current = null }
  }, [container])

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transactions, autoScroll])

  const handleClear = () => {
    setTransactions([])
    respStatsRef.current = { count: 0, totalMs: 0 }
    setRespStats({ count: 0, totalMs: 0 })
  }

  // ── Stats ──
  const stats: Stats = useMemo(() => {
    let errors = 0
    let sql = 0
    let redis = 0
    for (const tx of transactions) {
      if (tx.status !== undefined && tx.status >= 400) errors += 1
      for (const c of tx.children) {
        if (c.kind === 'sql') sql += 1
        else if (c.kind === 'redis') redis += 1
      }
    }
    return {
      total: transactions.length,
      errors,
      avgMs: respStats.count > 0 ? respStats.totalMs / respStats.count : 0,
      sql,
      redis,
    }
  }, [transactions, respStats])

  // ── Filtering ──
  const filtered = useMemo(() => {
    switch (filter) {
      case 'all': return transactions
      case 'http': return transactions
      case 'errors': return transactions.filter(t => t.status !== undefined && t.status >= 400)
      case 'sql': return transactions.filter(t => t.children.some(c => c.kind === 'sql'))
      case 'redis': return transactions.filter(t => t.children.some(c => c.kind === 'redis'))
      default: return transactions
    }
  }, [transactions, filter])

  // ── Scale for waterfall bars ──
  const maxDuration = useMemo(() => {
    let max = 0
    for (const tx of filtered) {
      if (tx.duration_ms !== undefined && tx.duration_ms > max) max = tx.duration_ms
    }
    return max
  }, [filtered])

  const filterTabs: { id: FilterMode; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'http', label: 'HTTP' },
    { id: 'sql', label: 'SQL' },
    { id: 'redis', label: 'Redis' },
    { id: 'errors', label: 'Errors' },
  ]

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Stats bar */}
      <div className="px-4 py-3 border-b border-slate-800 shrink-0 bg-slate-900/40">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className={clsx('w-2 h-2 rounded-full shrink-0',
              status === 'live' ? 'bg-emerald-400 animate-pulse' : status === 'error' ? 'bg-red-400' : 'bg-amber-400 animate-pulse')} />
            <span className="text-sm font-mono text-slate-200 truncate">{container}</span>
            <span className={clsx('text-[10px] font-semibold uppercase tracking-wider shrink-0',
              status === 'live' ? 'text-emerald-400' : status === 'error' ? 'text-red-400' : 'text-amber-400')}>
              {status === 'connecting' ? 'connecting' : status === 'live' ? 'live' : 'disconnected'}
            </span>
          </div>
          <button onClick={onStop} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-400 hover:text-red-400 hover:border-red-500/30 text-xs transition-colors shrink-0">
            <Square className="w-3 h-3" /> Stop trace
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <StatCard icon={Activity} label="Requests" value={String(stats.total)} color="text-blue-400" />
          <StatCard icon={X} label="Errors" value={String(stats.errors)} color={stats.errors > 0 ? 'text-red-400' : 'text-slate-500'} />
          <StatCard icon={Radio} label="Avg time" value={stats.avgMs > 0 ? fmtDuration(stats.avgMs) : '—'} color="text-indigo-400" />
          <StatCard icon={Database} label="SQL" value={String(stats.sql)} color="text-amber-400" />
          <StatCard icon={Zap} label="Redis" value={String(stats.redis)} color="text-red-400" />
        </div>
      </div>

      {/* Controls bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-800 shrink-0 flex-wrap gap-y-2 bg-slate-950/30">
        <div className="flex items-center gap-1.5 text-slate-600">
          <Filter className="w-3.5 h-3.5" />
        </div>
        <div className="flex items-center gap-0.5 p-0.5 bg-slate-950 border border-slate-800 rounded-lg">
          {filterTabs.map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className={clsx('px-2.5 py-1 rounded text-[11px] font-medium transition-all',
                filter === f.id
                  ? f.id === 'errors' ? 'bg-red-500/15 text-red-300' : 'bg-slate-800 text-slate-100'
                  : 'text-slate-500 hover:text-slate-300')}>
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
            <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)}
              className="rounded border-slate-700 bg-slate-800" />
            Auto-scroll
          </label>
          <button onClick={handleClear} className="flex items-center gap-1 p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-slate-300" title="Clear">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Waterfall column header */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-slate-800 shrink-0 bg-slate-900/20 text-[10px] uppercase tracking-wider text-slate-600 font-semibold">
        <span className="w-3.5 shrink-0" />
        <span className="w-20 shrink-0">Time</span>
        <span className="w-2 shrink-0" />
        <span className="w-16 shrink-0 text-center">Method</span>
        <span className="flex-1 min-w-0">Path</span>
        <span className="shrink-0">Spans</span>
        <span className="w-12 shrink-0 text-right">Status</span>
        <span className="w-28 shrink-0">Timeline</span>
        <span className="w-14 shrink-0 text-right">Duration</span>
      </div>

      {/* Waterfall body */}
      <div className="flex-1 overflow-y-auto min-h-0 bg-slate-950/50">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-slate-600 gap-2">
            <Radio className="w-6 h-6 animate-pulse" />
            <p className="text-sm">
              {transactions.length === 0 ? 'Waiting for traffic…' : 'No requests match this filter'}
            </p>
            {transactions.length === 0 && (
              <p className="text-xs">Send HTTP requests to this container to capture transactions</p>
            )}
          </div>
        ) : (
          filtered.map(tx => <TransactionRow key={tx.id} tx={tx} maxDuration={maxDuration} />)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TracingPage() {
  const { user } = useAuth()
  const toast = useToast()
  const canTrace = user?.permissions?.includes('terminal') || user?.role === 'superadmin' || user?.role === 'admin'

  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [tracedNames, setTracedNames] = useState<Set<string>>(new Set())
  const [activeTrace, setActiveTrace] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      const [cs, ts] = await Promise.all([
        api.listAllContainers(),
        api.getTraceStatus(),
      ])
      setContainers(cs.filter(c => c.State?.toLowerCase() === 'running'))
      setTracedNames(new Set(ts.traced))
    } catch {
      // ignore — sidebar simply shows nothing
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const handleToggle = async (name: string, enable: boolean) => {
    try {
      if (enable) {
        await api.enableTrace(name)
        setTracedNames(prev => new Set([...prev, name]))
        setActiveTrace(name)
        toast.success(`Tracing enabled for ${name}`)
      } else {
        await api.disableTrace(name)
        setTracedNames(prev => { const s = new Set(prev); s.delete(name); return s })
        if (activeTrace === name) setActiveTrace(null)
        toast.success(`Tracing stopped for ${name}`)
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar — container list */}
      <aside className="w-72 border-r border-slate-800 flex flex-col shrink-0 bg-slate-900/30">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-200">Request Tracing</p>
            <p className="text-xs text-slate-500 mt-0.5">HTTP · SQL · Redis · live</p>
          </div>
          <button onClick={load} className="p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-slate-300">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {!canTrace && (
          <div className="m-3 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/20 text-amber-300 text-xs">
            Terminal permission required to enable tracing.
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-2">
          {loading ? (
            <div className="px-4 py-8 text-center text-slate-600 text-sm">Loading…</div>
          ) : containers.length === 0 ? (
            <div className="px-4 py-8 text-center text-slate-600 text-sm">No running containers</div>
          ) : (
            containers.map(c => {
              const name = c.Names
              const isEnabled = tracedNames.has(name)
              const isActive = activeTrace === name
              return (
                <div
                  key={c.ID}
                  onClick={() => isEnabled && setActiveTrace(name)}
                  className={clsx(
                    'flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors border-b border-slate-800/40',
                    isActive ? 'bg-blue-950/30 border-l-2 border-l-blue-500' : 'hover:bg-slate-800/30',
                    !isEnabled && 'opacity-70',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <ContainerIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span className="text-xs font-mono text-slate-200 truncate">{name}</span>
                      {isEnabled && (
                        <span className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          LIVE
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-600 mt-0.5 truncate">{c.Image}</p>
                  </div>

                  {canTrace && (
                    <button
                      onClick={ev => { ev.stopPropagation(); handleToggle(name, !isEnabled) }}
                      className={clsx(
                        'shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium transition-all border',
                        isEnabled
                          ? 'bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20'
                          : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20',
                      )}
                    >
                      {isEnabled ? <><Square className="w-2.5 h-2.5" /> Stop</> : <><Play className="w-2.5 h-2.5" /> Trace</>}
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Legend */}
        <div className="px-4 py-3 border-t border-slate-800 space-y-1.5">
          <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-2">Captured protocols</p>
          {[
            { icon: Globe, color: 'text-blue-400', label: 'HTTP/HTTPS requests & responses' },
            { icon: Database, color: 'text-amber-400', label: 'PostgreSQL / MySQL queries' },
            { icon: Zap, color: 'text-red-400', label: 'Redis commands' },
          ].map(({ icon: Icon, color, label }) => (
            <div key={label} className="flex items-center gap-2 text-[10px] text-slate-500">
              <Icon className={clsx('w-3 h-3 shrink-0', color)} />
              {label}
            </div>
          ))}
          <div className="mt-2 pt-2 border-t border-slate-800">
            <p className="text-[10px] text-slate-700 leading-relaxed">
              Requests are grouped into transactions; nested SQL & Redis spans within 500ms are correlated automatically. Encrypted (TLS) traffic is not visible.
            </p>
          </div>
        </div>
      </aside>

      {/* Main panel */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {activeTrace ? (
          <LiveTracePanel
            key={activeTrace}
            container={activeTrace}
            onStop={() => handleToggle(activeTrace, false)}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-slate-600 p-8">
            <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center">
              <Activity className="w-8 h-8" />
            </div>
            <div className="text-center max-w-sm">
              <p className="text-sm font-medium text-slate-400 mb-1">No active trace</p>
              <p className="text-xs text-slate-600 leading-relaxed">
                Select a container and click <strong className="text-slate-500">Trace</strong> to capture a live request waterfall — each HTTP transaction with its nested SQL queries and Redis commands.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3 mt-4 w-full max-w-lg">
              {[
                { icon: Globe, color: 'text-blue-400 bg-blue-500/10 border-blue-500/20', label: 'HTTP', desc: 'Method, path, status, timing' },
                { icon: Database, color: 'text-amber-400 bg-amber-500/10 border-amber-500/20', label: 'SQL', desc: 'PostgreSQL & MySQL queries' },
                { icon: Zap, color: 'text-red-400 bg-red-500/10 border-red-500/20', label: 'Redis', desc: 'GET, SET, HGET & all commands' },
              ].map(({ icon: Icon, color, label, desc }) => (
                <div key={label} className={clsx('rounded-xl border p-3 text-center', color)}>
                  <Icon className="w-5 h-5 mx-auto mb-1.5" />
                  <p className="text-xs font-semibold">{label}</p>
                  <p className="text-[10px] mt-0.5 opacity-70">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
