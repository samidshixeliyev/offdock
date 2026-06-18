import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ContainerInfo, TraceEvent, TraceSessionSummary } from '../api/client'
import { useToast } from '../components/Toast'
import { useAuth } from '../hooks/useAuth'
import {
  Radio, Globe, Database, Zap, Activity, RefreshCw,
  Trash2, ChevronDown, ChevronRight, Filter, X,
  Container as ContainerIcon, Play, Square, History, ArrowLeft,
  Network, BarChart2, ArrowRight, AlertTriangle, Menu, ShieldCheck,
  Copy, Check, ExternalLink,
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
  table_name?: string
  rows_affected?: number
  span_id?: string
  parent_span_id?: string
}

// Service topology edge: traffic between two services
interface ServiceEdge {
  srcLabel: string
  dstLabel: string
  reqCount: number
  errCount: number
  totalMs: number
}

// Aggregated SQL query for analysis
interface AggQuery {
  normalized: string
  count: number
  totalMs: number
  avgMs: number
  maxMs: number
  table: string
  dbType: string
  opType: 'SELECT'|'INSERT'|'UPDATE'|'DELETE'|'OTHER'
}

interface Transaction {
  id: number
  time: string
  method: string   // HTTP method OR 'SQL'/'REDIS' for standalone DB transactions
  path: string     // HTTP path OR query text for standalone DB transactions
  host?: string
  src?: string
  dst?: string
  startedAt: number          // ms epoch when the event arrived (for the GROUP_WINDOW_MS logic)
  status?: number            // HTTP status (populated when matching http_resp arrives)
  duration_ms?: number       // populated when matching http_resp arrives
  children: ChildSpan[]
  isDbTx?: boolean           // true for standalone SQL/Redis transactions (no parent HTTP)
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

    if (matchIdx === -1) {
      // No parent HTTP request found. Create a standalone DB transaction so
      // SQL/Redis activity from database containers is visible in the waterfall.
      // Also handles background DB queries that fire after an HTTP response closes.
      const query = ev.query ?? ev.type
      const dbTx: Transaction = {
        id: nextId(),
        time: ev.time,
        method: ev.type === 'redis' ? 'REDIS' : 'SQL',
        path: query.length > 80 ? query.slice(0, 80) + '…' : query,
        src: ev.src,
        dst: ev.dst,
        startedAt: now,
        children: [],
        isDbTx: true,
      }
      const next = [...prev, dbTx]
      return next.length > MAX_TRANSACTIONS ? next.slice(-MAX_TRANSACTIONS) : next
    }

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
      table_name: ev.table_name,
      rows_affected: ev.rows_affected,
      span_id: ev.span_id,
      parent_span_id: ev.parent_span_id,
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

// ─── Copy button helper ───────────────────────────────────────────────────────

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={e => {
        e.stopPropagation()
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
      className="p-1 rounded text-slate-700 hover:text-slate-400 transition-colors shrink-0"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
    </button>
  )
}

// ─── Child span row ───────────────────────────────────────────────────────────

function ChildSpanRow({ span }: { span: ChildSpan }) {
  const leftBar = span.kind === 'sql'
    ? 'border-l-amber-500/70'
    : span.kind === 'redis'
    ? 'border-l-red-500/70'
    : 'border-l-indigo-500/50'

  const bg = span.kind === 'sql'
    ? 'bg-amber-950/10'
    : span.kind === 'redis'
    ? 'bg-red-950/10'
    : 'bg-indigo-950/8'

  return (
    <div className={clsx('ml-7 mr-0 border-l-2 pl-3 pr-3 py-2', leftBar, bg)}>
      {/* Header row */}
      <div className="flex items-center gap-2 flex-wrap">
        {span.kind === 'sql' && (
          <>
            <Database className="w-3 h-3 text-amber-400 shrink-0" />
            <SqlOpBadge query={span.query} />
            <DbBadge dbType={span.db_type} />
            {span.table_name && (
              <span className="text-[10px] text-amber-400/70 font-mono">
                <span className="text-slate-600">table:</span> {span.table_name}
              </span>
            )}
          </>
        )}
        {span.kind === 'redis' && (
          <>
            <Zap className="w-3 h-3 text-red-400 shrink-0" />
            <span className="text-[10px] font-bold text-red-300 uppercase tracking-wider">Redis</span>
          </>
        )}
        {span.kind === 'http_resp' && (
          <>
            <Globe className="w-3 h-3 text-indigo-400 shrink-0" />
            <span className="text-[10px] font-bold text-indigo-300 uppercase tracking-wider">Response</span>
            {span.status !== undefined && (
              <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold border', statusBadgeColor(span.status))}>
                {span.status}
              </span>
            )}
          </>
        )}

        {/* Right-aligned meta */}
        <div className="ml-auto flex items-center gap-2 text-[10px] shrink-0">
          {span.rows_affected !== undefined && span.rows_affected > 0 && (
            <span className="text-slate-600 tabular-nums">{span.rows_affected} rows</span>
          )}
          {span.duration_ms !== undefined && span.duration_ms > 0 && (
            <span className={clsx('font-semibold tabular-nums', durationColor(span.duration_ms))}>
              {fmtDuration(span.duration_ms)}
            </span>
          )}
          {span.dst && (
            <span className="text-slate-700 font-mono text-[9px]">{span.dst}</span>
          )}
          {span.query && span.kind !== 'http_resp' && <CopyBtn text={span.query} />}
        </div>
      </div>

      {/* Query / command body */}
      {span.query && span.kind === 'sql' && (
        <pre className="mt-1.5 text-[11px] text-amber-200/85 font-mono whitespace-pre-wrap break-all leading-relaxed rounded px-2.5 py-2 bg-amber-950/25 max-h-40 overflow-y-auto">
          {span.query}
        </pre>
      )}
      {span.query && span.kind === 'redis' && (
        <pre className="mt-1.5 text-[11px] text-red-200/85 font-mono whitespace-pre-wrap break-all leading-relaxed rounded px-2.5 py-2 bg-red-950/25 max-h-24 overflow-y-auto">
          {span.query}
        </pre>
      )}

      {/* HTTP response timing bar */}
      {span.kind === 'http_resp' && span.duration_ms !== undefined && span.duration_ms > 0 && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex-1 h-1 rounded bg-slate-800/60 overflow-hidden">
            <div className={clsx('h-full rounded', durationBarColor(span.duration_ms))} style={{ width: '100%' }} />
          </div>
          <span className={clsx('text-[10px] font-semibold tabular-nums', durationColor(span.duration_ms))}>
            {fmtDuration(span.duration_ms)}
          </span>
        </div>
      )}
    </div>
  )
}

// ─── Transaction row (waterfall) ──────────────────────────────────────────────

function TransactionRow({ tx, maxDuration }: { tx: Transaction; maxDuration: number }) {
  const [expanded, setExpanded] = useState(false)
  const dur = tx.duration_ms ?? 0
  const barWidth = maxDuration > 0 ? Math.min(100, (dur / maxDuration) * 100) : 0
  const sqlChildren = tx.children.filter(c => c.kind === 'sql')
  const redisChildren = tx.children.filter(c => c.kind === 'redis')
  const hasChildren = tx.children.length > 0
  const isError = tx.status !== undefined && tx.status >= 400
  const isSlow = dur > 500 && !isError
  const isExternal = !!tx.host && !tx.isDbTx

  const leftBorder = isError
    ? 'border-l-red-500'
    : isSlow
    ? 'border-l-amber-500'
    : dur > 0
    ? 'border-l-emerald-500/50'
    : 'border-l-slate-700/50'

  return (
    <div className={clsx('border-b border-slate-800/40 border-l-2', leftBorder)}>
      <div
        onClick={() => hasChildren && setExpanded(e => !e)}
        className={clsx(
          'flex items-start gap-2 px-3 py-2.5 text-xs transition-colors',
          hasChildren ? 'cursor-pointer hover:bg-slate-800/20' : '',
        )}
      >
        {/* Expand chevron */}
        <span className="w-4 shrink-0 text-slate-600 pt-0.5">
          {hasChildren
            ? (expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />)
            : null}
        </span>

        {/* Content block */}
        <div className="flex-1 min-w-0 space-y-0.5">
          {/* Primary row: method + path + status */}
          <div className="flex items-center gap-2 min-w-0">
            {tx.isDbTx ? (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold border shrink-0 text-amber-400 bg-amber-500/10 border-amber-500/20">
                {tx.method}
              </span>
            ) : (
              <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold border shrink-0 min-w-[3.5rem] text-center', methodColor(tx.method))}>
                {tx.method}
              </span>
            )}
            <span
              className={clsx('flex-1 min-w-0 truncate font-mono', tx.isDbTx ? 'text-amber-200/80 text-[10px]' : 'text-slate-200 text-xs')}
              title={tx.path}
            >
              {tx.path}
            </span>
            {tx.status !== undefined ? (
              <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold border shrink-0', statusBadgeColor(tx.status))}>
                {tx.status}
              </span>
            ) : !tx.isDbTx && (
              <span className="text-slate-700 text-[10px] shrink-0">…</span>
            )}
          </div>

          {/* Secondary row: timestamp + host + spans + timeline */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-700 text-[10px] tabular-nums shrink-0">{tx.time}</span>

            {isExternal && (
              <span className="flex items-center gap-1 text-[10px] text-indigo-400/80 shrink-0">
                <ExternalLink className="w-2.5 h-2.5" />
                {tx.host}
              </span>
            )}

            {tx.src && tx.dst && (
              <span className="text-[10px] text-slate-700 font-mono shrink-0">
                {tx.src.split(':')[0]} → {tx.dst.split(':')[0]}
              </span>
            )}

            {sqlChildren.length > 0 && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/20 shrink-0">
                <Database className="w-2 h-2" />{sqlChildren.length} SQL
              </span>
            )}
            {redisChildren.length > 0 && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-semibold bg-red-500/10 text-red-300 border border-red-500/20 shrink-0">
                <Zap className="w-2 h-2" />{redisChildren.length} Redis
              </span>
            )}

            {/* Waterfall bar */}
            {maxDuration > 0 && dur > 0 && (
              <div className="flex items-center gap-1.5 flex-1 min-w-[80px] max-w-[200px]">
                <div className="flex-1 h-1.5 rounded bg-slate-800/60 overflow-hidden">
                  <div
                    className={clsx('h-full rounded transition-all', durationBarColor(dur))}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
                <span className={clsx('text-[10px] font-semibold tabular-nums shrink-0', durationColor(dur))}>
                  {fmtDuration(dur)}
                </span>
              </div>
            )}
            {dur === 0 && (
              <span className="text-slate-700 text-[10px] tabular-nums shrink-0">—</span>
            )}
          </div>
        </div>
      </div>

      {/* Expanded child spans */}
      {expanded && hasChildren && (
        <div className="bg-slate-950/40 border-t border-slate-800/30 py-1 space-y-1">
          {tx.children.map(c => (
            <ChildSpanRow key={c.id} span={c} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Reusable waterfall view (used by live + replay) ──────────────────────────

function buildTransactions(events: TraceEvent[]): Transaction[] {
  let txs: Transaction[] = []
  let id = 0
  const nextId = () => ++id
  // Replay events in order using the same grouping logic as the live stream.
  // Use a monotonically increasing virtual clock so the GROUP_WINDOW_MS logic
  // attaches children to their request without relying on wall-clock arrival.
  let clock = 0
  for (const ev of events) {
    clock += 1
    txs = ingestEvent(txs, ev, clock, nextId)
  }
  return txs
}

function statsFor(transactions: Transaction[]): Stats {
  let errors = 0, sql = 0, redis = 0, respCount = 0, respTotal = 0
  for (const tx of transactions) {
    if (tx.status !== undefined && tx.status >= 400) errors += 1
    if (tx.duration_ms !== undefined && tx.duration_ms > 0) { respCount += 1; respTotal += tx.duration_ms }
    // Count standalone DB transactions
    if (tx.isDbTx && tx.method === 'SQL') sql += 1
    else if (tx.isDbTx && tx.method === 'REDIS') redis += 1
    for (const c of tx.children) {
      if (c.kind === 'sql') sql += 1
      else if (c.kind === 'redis') redis += 1
    }
  }
  return { total: transactions.length, errors, avgMs: respCount > 0 ? respTotal / respCount : 0, sql, redis }
}

function WaterfallBody({ transactions, filter }: { transactions: Transaction[]; filter: FilterMode }) {
  const filtered = useMemo(() => {
    switch (filter) {
      case 'errors': return transactions.filter(t => t.status !== undefined && t.status >= 400)
      case 'sql': return transactions.filter(t => (t.isDbTx && t.method === 'SQL') || t.children.some(c => c.kind === 'sql'))
      case 'redis': return transactions.filter(t => (t.isDbTx && t.method === 'REDIS') || t.children.some(c => c.kind === 'redis'))
      default: return transactions
    }
  }, [transactions, filter])

  const maxDuration = useMemo(() => {
    let max = 0
    for (const tx of filtered) if (tx.duration_ms !== undefined && tx.duration_ms > max) max = tx.duration_ms
    return max
  }, [filtered])

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 shrink-0 bg-slate-900/20 text-[10px] uppercase tracking-wider text-slate-600 font-semibold">
        <span className="w-4 shrink-0" />
        <span className="w-14 shrink-0 text-center">Method</span>
        <span className="flex-1 min-w-0">Path · Host · Timing</span>
        <span className="w-12 shrink-0 text-right">Status</span>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 bg-slate-950/50">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-slate-600 gap-2">
            <Radio className="w-6 h-6" />
            <p className="text-sm">{transactions.length === 0 ? 'No transactions captured' : 'No requests match this filter'}</p>
          </div>
        ) : (
          filtered.map(tx => <TransactionRow key={tx.id} tx={tx} maxDuration={maxDuration} />)
        )}
      </div>
    </>
  )
}

const FILTER_TABS: { id: FilterMode; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'http', label: 'HTTP' },
  { id: 'sql', label: 'SQL' },
  { id: 'redis', label: 'Redis' },
  { id: 'errors', label: 'Errors' },
]

function FilterTabs({ filter, onChange }: { filter: FilterMode; onChange: (f: FilterMode) => void }) {
  return (
    <div className="flex items-center gap-0.5 p-0.5 bg-slate-950 border border-slate-800 rounded-lg">
      {FILTER_TABS.map(f => (
        <button key={f.id} onClick={() => onChange(f.id)}
          className={clsx('px-2.5 py-1 rounded text-[11px] font-medium transition-all',
            filter === f.id
              ? f.id === 'errors' ? 'bg-red-500/15 text-red-300' : 'bg-slate-800 text-slate-100'
              : 'text-slate-500 hover:text-slate-300')}>
          {f.label}
        </button>
      ))}
    </div>
  )
}

function StatsRow({ stats }: { stats: Stats }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
      <StatCard icon={Activity} label="Requests" value={String(stats.total)} color="text-blue-400" />
      <StatCard icon={X} label="Errors" value={String(stats.errors)} color={stats.errors > 0 ? 'text-red-400' : 'text-slate-500'} />
      <StatCard icon={Radio} label="Avg time" value={stats.avgMs > 0 ? fmtDuration(stats.avgMs) : '—'} color="text-indigo-400" />
      <StatCard icon={Database} label="SQL" value={String(stats.sql)} color="text-amber-400" />
      <StatCard icon={Zap} label="Redis" value={String(stats.redis)} color="text-red-400" />
    </div>
  )
}

// ─── Session replay panel (read-only waterfall from stored data) ──────────────

function SessionReplayPanel({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [meta, setMeta] = useState<{ container: string; started: string; ended: string | null; count: number } | null>(null)
  const [filter, setFilter] = useState<FilterMode>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.getTraceSession(sessionId)
      .then(s => {
        if (cancelled) return
        setTransactions(buildTransactions(s.events ?? []))
        setMeta({ container: s.container_name, started: s.started_at, ended: s.ended_at, count: s.event_count })
      })
      .catch(() => { if (!cancelled) setError('Could not load session') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [sessionId])

  const stats = useMemo(() => statsFor(transactions), [transactions])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-3 border-b border-slate-800 shrink-0 bg-slate-900/40">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={onBack} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-slate-200 shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <History className="w-4 h-4 text-indigo-400 shrink-0" />
            <span className="text-sm font-mono text-slate-200 truncate">{meta?.container ?? '…'}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-400 shrink-0">replay</span>
          </div>
          {meta && (
            <span className="text-[11px] text-slate-500 shrink-0">
              {new Date(meta.started).toLocaleString()}
            </span>
          )}
        </div>
        <StatsRow stats={stats} />
      </div>

      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-800 shrink-0 bg-slate-950/30">
        <div className="flex items-center gap-1.5 text-slate-600"><Filter className="w-3.5 h-3.5" /></div>
        <FilterTabs filter={filter} onChange={setFilter} />
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-slate-600 text-sm">Loading session…</div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-red-400 text-sm">{error}</div>
      ) : (
        <WaterfallBody transactions={transactions} filter={filter} />
      )}
    </div>
  )
}

// ─── Sessions list panel ──────────────────────────────────────────────────────

function SessionsListPanel({ onOpen, onOpenSidebar }: { onOpen: (id: string) => void; onOpenSidebar: () => void }) {
  const toast = useToast()
  const [sessions, setSessions] = useState<TraceSessionSummary[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try { setSessions(await api.listTraceSessions()) } catch { /* ignore */ }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const fmtDur = (started: string, ended: string | null): string => {
    if (!ended) return '—'
    const ms = new Date(ended).getTime() - new Date(started).getTime()
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
  }

  const handleDelete = async (id: string) => {
    try {
      await api.deleteTraceSession(id)
      setSessions(prev => prev.filter(s => s.id !== id))
      toast.success('Session deleted')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2">
          <button onClick={onOpenSidebar} className="md:hidden p-1.5 -ml-1.5 rounded hover:bg-slate-800 text-slate-400 shrink-0" title="Sessions menu">
            <Menu className="w-4 h-4" />
          </button>
          <History className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-semibold text-slate-200">Saved trace sessions</span>
        </div>
        <button onClick={load} className="p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-slate-300">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-auto min-h-0">
        {loading ? (
          <div className="py-12 text-center text-slate-600 text-sm">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-2 py-12">
            <History className="w-8 h-8 opacity-40" />
            <p className="text-sm">No saved sessions yet</p>
            <p className="text-xs">Run a live trace — it is saved automatically when you stop.</p>
          </div>
        ) : (
          <table className="w-full min-w-[640px] text-sm">
            <thead className="sticky top-0 bg-slate-900 z-10">
              <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-600">
                <th className="text-left px-4 py-2.5 font-medium">Container</th>
                <th className="text-left px-4 py-2.5 font-medium">Started</th>
                <th className="text-right px-4 py-2.5 font-medium">Duration</th>
                <th className="text-right px-4 py-2.5 font-medium">Events</th>
                <th className="text-left px-4 py-2.5 font-medium">Breakdown</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {sessions.map(s => (
                <tr key={s.id} onClick={() => onOpen(s.id)}
                  className="border-b border-slate-800/50 hover:bg-slate-800/30 cursor-pointer group">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-200">
                    <span className="flex items-center gap-2">
                      <ContainerIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span className="truncate max-w-[180px]">{s.container_name}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{new Date(s.started_at).toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-500 text-right tabular-nums">{fmtDur(s.started_at, s.ended_at)}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-300 text-right tabular-nums">{s.event_count}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-blue-500/10 text-blue-300 border border-blue-500/20">
                        <Globe className="w-2.5 h-2.5" />{s.http_count}
                      </span>
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/20">
                        <Database className="w-2.5 h-2.5" />{s.sql_count}
                      </span>
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-500/10 text-red-300 border border-red-500/20">
                        <Zap className="w-2.5 h-2.5" />{s.redis_count}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={e => { e.stopPropagation(); handleDelete(s.id) }}
                      title="Delete session"
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-all">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─── Trace requirements + error card ──────────────────────────────────────────

const TRACE_REQUIREMENTS: { label: string; detail: string }[] = [
  { label: 'tcpdump installed', detail: 'Run "which tcpdump" on the host — install the tcpdump package if missing.' },
  { label: 'Root or CAP_NET_RAW', detail: 'OffDock must run as root or the service needs the CAP_NET_RAW capability.' },
  { label: 'Bridge networking', detail: 'The container must use a Docker bridge network, not --network host.' },
]

function TraceErrorCard({ message, permanent }: { message: string; permanent: boolean }) {
  return (
    <div className="w-full rounded-xl border border-red-500/30 bg-red-500/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-red-300">
            {permanent ? 'Tracing cannot start' : 'Trace connection lost'}
          </p>
          <p className="text-xs text-red-200/80 mt-1 break-words font-mono leading-relaxed">{message}</p>
          <div className="mt-3 space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Requirements checklist</p>
            {TRACE_REQUIREMENTS.map(req => (
              <div key={req.label} className="flex items-start gap-2 text-xs">
                <ShieldCheck className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                <span className="text-slate-300">
                  <span className="font-medium">{req.label}</span>
                  <span className="text-slate-500"> — {req.detail}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Live trace panel (waterfall + stats) ─────────────────────────────────────

type PanelTab = 'waterfall' | 'graph' | 'sql'

const MAX_RECONNECTS = 5
const RECONNECT_DELAY_MS = 3000

function isPermanentTraceError(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes('tcpdump failed to start') ||
    m.includes('tcpdump not found') ||
    m.includes('executable file not found') ||
    m.includes('cap_net_raw') ||
    m.includes('permission denied') ||
    m.includes('could not find container network') ||
    m.includes('host networking') ||
    m.includes('is not running') ||
    m.includes('non-standard bridge')
  )
}

function LiveTracePanel({ container, onStop, onOpenSidebar }: { container: string; onStop: () => void; onOpenSidebar: () => void }) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [permanent, setPermanent] = useState(false)
  const [reconnectKey, setReconnectKey] = useState(0)
  const [retryCount, setRetryCount] = useState(0)
  const [filter, setFilter] = useState<FilterMode>('all')
  const [panelTab, setPanelTab] = useState<PanelTab>('waterfall')
  const [autoScroll, setAutoScroll] = useState(true)

  const esRef = useRef<EventSource | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const idRef = useRef(0)
  const permanentErrorRef = useRef(false)
  const retriesRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Running tally of all response times (kept outside React state to avoid re-deriving every render).
  const respStatsRef = useRef<{ count: number; totalMs: number }>({ count: 0, totalMs: 0 })
  const [respStats, setRespStats] = useState<{ count: number; totalMs: number }>({ count: 0, totalMs: 0 })

  useEffect(() => {
    // Reset permanent-error and retry state on every new connection attempt
    // (including container changes) so a previous failure doesn't block a new trace.
    permanentErrorRef.current = false
    retriesRef.current = 0
    setRetryCount(0)
    setErrorMsg(null)
    setPermanent(false)

    setStatus('connecting')
    const es = new EventSource(api.traceUrl(container))
    esRef.current = es

    es.onopen = () => {
      setStatus('live')
      retriesRef.current = 0
      setRetryCount(0)
    }

    es.onerror = () => {
      es.close()
      esRef.current = null
      if (permanentErrorRef.current) {
        setStatus('error')
        return
      }
      if (retriesRef.current >= MAX_RECONNECTS) {
        setStatus('error')
        const baseMsg = `connection lost — gave up after ${MAX_RECONNECTS} retries`
        setErrorMsg(prev => prev ?? baseMsg)
        // After exhausting retries, check auth — Keycloak/OAuth sessions may have
        // expired, causing a 401 that EventSource reports as a generic onerror.
        api.me().catch(() => {
          window.location.href = '/login'
        })
        return
      }
      retriesRef.current += 1
      setRetryCount(retriesRef.current)
      setStatus('connecting')
      reconnectTimerRef.current = setTimeout(() => setReconnectKey(k => k + 1), RECONNECT_DELAY_MS)
    }

    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as TraceEvent
        const now = Date.now()
        const nextId = () => ++idRef.current

        if (data.type === 'error' && data.message) {
          setErrorMsg(data.message)
          if (isPermanentTraceError(data.message)) {
            permanentErrorRef.current = true
            setPermanent(true)
            setStatus('error')
            es.close()
            esRef.current = null
          }
          return
        }

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

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      es.close()
      esRef.current = null
    }
  }, [container, reconnectKey])

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
      if (tx.isDbTx && tx.method === 'SQL') sql += 1
      else if (tx.isDbTx && tx.method === 'REDIS') redis += 1
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
      case 'http': return transactions.filter(t => !t.isDbTx)
      case 'errors': return transactions.filter(t => t.status !== undefined && t.status >= 400)
      case 'sql': return transactions.filter(t => (t.isDbTx && t.method === 'SQL') || t.children.some(c => c.kind === 'sql'))
      case 'redis': return transactions.filter(t => (t.isDbTx && t.method === 'REDIS') || t.children.some(c => c.kind === 'redis'))
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
            <button onClick={onOpenSidebar} className="md:hidden p-1.5 -ml-1.5 rounded hover:bg-slate-800 text-slate-400 shrink-0" title="Containers">
              <Menu className="w-4 h-4" />
            </button>
            <span className={clsx('w-2 h-2 rounded-full shrink-0',
              status === 'live' ? 'bg-emerald-400 animate-pulse' : status === 'error' ? 'bg-red-400' : 'bg-amber-400 animate-pulse')} />
            <span className="text-sm font-mono text-slate-200 truncate">{container}</span>
            <span className={clsx('text-[10px] font-semibold uppercase tracking-wider shrink-0',
              status === 'live' ? 'text-emerald-400' : status === 'error' ? 'text-red-400' : 'text-amber-400')}>
              {status === 'connecting' ? (retryCount > 0 ? `reconnecting ${retryCount}/${MAX_RECONNECTS}` : 'connecting') : status === 'live' ? 'live' : 'disconnected'}
            </span>
          </div>
          <button onClick={onStop} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-400 hover:text-red-400 hover:border-red-500/30 text-xs transition-colors shrink-0">
            <Square className="w-3 h-3" /> Stop trace
          </button>
        </div>

        {status === 'error' && errorMsg && (
          <div className="mb-3">
            <TraceErrorCard message={errorMsg} permanent={permanent} />
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <StatCard icon={Activity} label="Requests" value={String(stats.total)} color="text-blue-400" />
          <StatCard icon={X} label="Errors" value={String(stats.errors)} color={stats.errors > 0 ? 'text-red-400' : 'text-slate-500'} />
          <StatCard icon={Radio} label="Avg time" value={stats.avgMs > 0 ? fmtDuration(stats.avgMs) : '—'} color="text-indigo-400" />
          <StatCard icon={Database} label="SQL" value={String(stats.sql)} color="text-amber-400" />
          <StatCard icon={Zap} label="Redis" value={String(stats.redis)} color="text-red-400" />
        </div>
      </div>

      {/* Tab bar + controls */}
      <div className="flex items-center gap-0.5 px-4 py-2 border-b border-slate-800 shrink-0 bg-slate-950/30">
        {/* View tabs */}
        <div className="flex items-center gap-0.5 p-0.5 bg-slate-950 border border-slate-800 rounded-lg mr-3">
          {([
            { id: 'waterfall', label: 'Waterfall', icon: Activity },
            { id: 'graph',     label: 'Service Map', icon: Network },
            { id: 'sql',       label: 'SQL Analysis', icon: BarChart2 },
          ] as const).map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setPanelTab(id)}
              className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium transition-all',
                panelTab === id ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>
              <Icon className="w-3 h-3" />{label}
            </button>
          ))}
        </div>

        {panelTab === 'waterfall' && <>
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
        </>}

        <div className="flex items-center gap-2 ml-auto">
          {panelTab === 'waterfall' && (
            <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
              <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)}
                className="rounded border-slate-700 bg-slate-800" />
              Auto-scroll
            </label>
          )}
          <button onClick={handleClear} className="flex items-center gap-1 p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-slate-300" title="Clear all data">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Panel content */}
      {panelTab === 'waterfall' && <>
        {/* Waterfall column header */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 shrink-0 bg-slate-900/20 text-[10px] uppercase tracking-wider text-slate-600 font-semibold">
          <span className="w-4 shrink-0" />
          <span className="w-14 shrink-0 text-center">Method</span>
          <span className="flex-1 min-w-0">Path · Host · Timing</span>
          <span className="w-12 shrink-0 text-right">Status</span>
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
      </>}

      {panelTab === 'graph' && (
        <div className="flex-1 overflow-y-auto min-h-0">
          <ServiceGraphPanel transactions={transactions} />
        </div>
      )}

      {panelTab === 'sql' && (
        <div className="flex-1 overflow-y-auto min-h-0">
          <SqlAnalysisPanel transactions={transactions} />
        </div>
      )}
    </div>
  )
}

// ─── DB type badge ────────────────────────────────────────────────────────────

function DbBadge({ dbType }: { dbType?: string }) {
  if (!dbType) return null
  const cfg: Record<string, { label: string; cls: string }> = {
    postgresql: { label: 'PG',    cls: 'bg-blue-500/15 text-blue-300 border-blue-500/20' },
    mysql:      { label: 'MY',    cls: 'bg-orange-500/15 text-orange-300 border-orange-500/20' },
    mssql:      { label: 'MS',    cls: 'bg-red-500/15 text-red-300 border-red-500/20' },
    redis:      { label: 'RE',    cls: 'bg-red-500/15 text-red-400 border-red-500/25' },
    mongodb:    { label: 'MO',    cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20' },
  }
  const c = cfg[dbType.toLowerCase()] ?? { label: dbType.toUpperCase().slice(0, 2), cls: 'bg-slate-700 text-slate-400 border-slate-600' }
  return (
    <span className={clsx('inline-flex items-center px-1 py-0.5 rounded text-[9px] font-bold border shrink-0', c.cls)}>
      {c.label}
    </span>
  )
}

// ─── SQL op badge ────────────────────────────────────────────────────────────

function SqlOpBadge({ query }: { query?: string }) {
  if (!query) return null
  const op = query.trim().split(/\s+/)[0]?.toUpperCase() ?? ''
  const cfg: Record<string, string> = {
    SELECT: 'text-blue-300 bg-blue-500/10',
    INSERT: 'text-emerald-300 bg-emerald-500/10',
    UPDATE: 'text-amber-300 bg-amber-500/10',
    DELETE: 'text-red-300 bg-red-500/10',
    BEGIN:  'text-slate-400 bg-slate-700/40',
    COMMIT: 'text-slate-400 bg-slate-700/40',
    ROLLBACK: 'text-orange-300 bg-orange-500/10',
  }
  return (
    <span className={clsx('px-1 py-0.5 rounded text-[9px] font-bold shrink-0', cfg[op] ?? 'text-slate-500 bg-slate-800')}>
      {op}
    </span>
  )
}

// ─── Service Graph ────────────────────────────────────────────────────────────

function buildServiceEdges(transactions: Transaction[]): ServiceEdge[] {
  const edges = new Map<string, ServiceEdge>()
  for (const tx of transactions) {
    const srcLabel = tx.src ? tx.src.split(':')[0] : 'client'
    const dstLabel = tx.host || (tx.dst ? tx.dst.split(':')[0] : 'server')
    const key = `${srcLabel}→${dstLabel}`
    const existing = edges.get(key) ?? { srcLabel, dstLabel, reqCount: 0, errCount: 0, totalMs: 0 }
    existing.reqCount++
    if (tx.status !== undefined && tx.status >= 400) existing.errCount++
    if (tx.duration_ms) existing.totalMs += tx.duration_ms
    edges.set(key, existing)

    // DB / Redis edges from child spans
    for (const c of tx.children) {
      if ((c.kind === 'sql' || c.kind === 'redis') && c.dst) {
        const dbSrc = dstLabel
        const dbDst = c.db_type ?? (c.kind === 'redis' ? 'redis' : 'db')
        const dbKey = `${dbSrc}→${dbDst}`
        const dbEdge = edges.get(dbKey) ?? { srcLabel: dbSrc, dstLabel: dbDst, reqCount: 0, errCount: 0, totalMs: 0 }
        dbEdge.reqCount++
        if (c.duration_ms) dbEdge.totalMs += c.duration_ms
        edges.set(dbKey, dbEdge)
      }
    }
  }
  return Array.from(edges.values())
}

function ServiceGraphPanel({ transactions }: { transactions: Transaction[] }) {
  const edges = useMemo(() => buildServiceEdges(transactions), [transactions])
  const nodes = useMemo(() => {
    const set = new Set<string>()
    for (const e of edges) { set.add(e.srcLabel); set.add(e.dstLabel) }
    return Array.from(set)
  }, [edges])

  if (edges.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-slate-600 gap-2">
        <Network className="w-8 h-8" />
        <p className="text-sm">No service topology data yet — send requests to see the graph</p>
      </div>
    )
  }

  // Lay out nodes in a simple left-to-right topology:
  // clients → app servers → databases/caches
  const nodeTypeOrder = (n: string): number => {
    if (n === 'client') return 0
    const lower = n.toLowerCase()
    if (['redis', 'postgresql', 'mysql', 'mssql', 'mongodb', 'db'].some(d => lower.includes(d))) return 2
    return 1
  }
  const sortedNodes = [...nodes].sort((a, b) => nodeTypeOrder(a) - nodeTypeOrder(b))
  const nodeColor = (n: string): string => {
    const lower = n.toLowerCase()
    if (lower === 'client') return 'bg-slate-700 border-slate-600 text-slate-300'
    if (lower.includes('redis')) return 'bg-red-900/30 border-red-500/30 text-red-300'
    if (lower.includes('postgresql') || lower.includes('pg')) return 'bg-blue-900/30 border-blue-500/30 text-blue-300'
    if (lower.includes('mysql')) return 'bg-orange-900/30 border-orange-500/30 text-orange-300'
    if (lower.includes('mssql') || lower.includes('sql')) return 'bg-red-900/20 border-red-400/30 text-red-300'
    if (lower.includes('mongo')) return 'bg-emerald-900/30 border-emerald-500/30 text-emerald-300'
    return 'bg-blue-900/20 border-blue-500/20 text-blue-200'
  }

  return (
    <div className="p-4 space-y-4">
      {/* Edge list — clean topology table */}
      <div className="space-y-2">
        <p className="text-[10px] text-slate-600 font-semibold uppercase tracking-wider">Service Connections ({edges.length})</p>
        {edges.map(e => {
          const avgMs = e.reqCount > 0 ? e.totalMs / e.reqCount : 0
          const errRate = e.reqCount > 0 ? (e.errCount / e.reqCount) * 100 : 0
          return (
            <div key={`${e.srcLabel}-${e.dstLabel}`}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition-colors">
              <span className={clsx('px-2.5 py-1 rounded-lg border text-xs font-mono font-medium', nodeColor(e.srcLabel))}>
                {e.srcLabel}
              </span>
              <ArrowRight className="w-4 h-4 text-slate-600 shrink-0" />
              <span className={clsx('px-2.5 py-1 rounded-lg border text-xs font-mono font-medium', nodeColor(e.dstLabel))}>
                {e.dstLabel}
              </span>
              <div className="ml-auto flex items-center gap-4 text-xs">
                <span className="text-slate-500 tabular-nums">{e.reqCount} req</span>
                {avgMs > 0 && <span className={clsx('tabular-nums', avgMs > 500 ? 'text-amber-400' : 'text-slate-500')}>{fmtDuration(avgMs)} avg</span>}
                {errRate > 0 && <span className="text-red-400 tabular-nums">{errRate.toFixed(0)}% err</span>}
              </div>
            </div>
          )
        })}
      </div>

      {/* Node summary */}
      <div className="space-y-1">
        <p className="text-[10px] text-slate-600 font-semibold uppercase tracking-wider">Discovered Services ({sortedNodes.length})</p>
        <div className="flex flex-wrap gap-2">
          {sortedNodes.map(n => (
            <span key={n} className={clsx('px-2.5 py-1 rounded-lg border text-xs font-mono', nodeColor(n))}>{n}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── SQL Analysis Panel ───────────────────────────────────────────────────────

function normalizeSql(q: string): string {
  if (!q) return ''
  return q
    .replace(/\s+/g, ' ')
    .replace(/'[^']*'/g, '?')                  // string literals
    .replace(/\b\d+\b/g, '?')                  // numeric literals
    .replace(/\(\s*\?(?:\s*,\s*\?)*\s*\)/g, '(?)') // IN (?, ?, ?) → (?)
    .trim()
    .slice(0, 120)
}

function getOpType(q: string): AggQuery['opType'] {
  const op = q.trim().split(/\s+/)[0]?.toUpperCase()
  if (op === 'SELECT') return 'SELECT'
  if (op === 'INSERT') return 'INSERT'
  if (op === 'UPDATE') return 'UPDATE'
  if (op === 'DELETE') return 'DELETE'
  return 'OTHER'
}

function buildAggQueries(transactions: Transaction[]): AggQuery[] {
  const map = new Map<string, AggQuery>()
  for (const tx of transactions) {
    for (const c of tx.children) {
      if (c.kind !== 'sql' || !c.query) continue
      const key = normalizeSql(c.query)
      const existing = map.get(key) ?? {
        normalized: key,
        count: 0,
        totalMs: 0,
        avgMs: 0,
        maxMs: 0,
        table: c.table_name ?? '',
        dbType: c.db_type ?? '',
        opType: getOpType(c.query),
      }
      existing.count++
      const ms = c.duration_ms ?? 0
      existing.totalMs += ms
      if (ms > existing.maxMs) existing.maxMs = ms
      existing.avgMs = existing.totalMs / existing.count
      if (!existing.table && c.table_name) existing.table = c.table_name
      map.set(key, existing)
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count)
}

function SqlAnalysisPanel({ transactions }: { transactions: Transaction[] }) {
  const queries = useMemo(() => buildAggQueries(transactions), [transactions])
  const [sort, setSort] = useState<'count' | 'avgMs' | 'maxMs'>('count')

  const sorted = useMemo(() => {
    return [...queries].sort((a, b) => b[sort] - a[sort])
  }, [queries, sort])

  const totals = useMemo(() => ({
    total: queries.reduce((s, q) => s + q.count, 0),
    tables: new Set(queries.map(q => q.table).filter(Boolean)).size,
    select: queries.filter(q => q.opType === 'SELECT').reduce((s, q) => s + q.count, 0),
    writes: queries.filter(q => ['INSERT','UPDATE','DELETE'].includes(q.opType)).reduce((s, q) => s + q.count, 0),
  }), [queries])

  if (queries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-slate-600 gap-2">
        <Database className="w-8 h-8" />
        <p className="text-sm">No SQL queries captured yet</p>
      </div>
    )
  }

  const opColor = (op: AggQuery['opType']) => ({
    SELECT: 'text-blue-300', INSERT: 'text-emerald-300', UPDATE: 'text-amber-300',
    DELETE: 'text-red-300', OTHER: 'text-slate-400',
  }[op])

  return (
    <div className="p-4 space-y-4">
      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: 'Unique queries', value: queries.length },
          { label: 'Total executions', value: totals.total },
          { label: 'Tables touched', value: totals.tables },
          { label: 'Read / Write', value: `${totals.select} / ${totals.writes}` },
        ].map(s => (
          <div key={s.label} className="px-3 py-2 rounded-lg bg-slate-900/60 border border-slate-800">
            <p className="text-[10px] uppercase tracking-wider text-slate-600">{s.label}</p>
            <p className="text-base font-semibold text-slate-200 tabular-nums">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Sort controls */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-600">Sort by:</span>
        {([['count','Frequency'],['avgMs','Avg time'],['maxMs','Max time']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setSort(id)}
            className={clsx('px-2.5 py-1 rounded text-xs font-medium transition-all',
              sort === id ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>
            {label}
          </button>
        ))}
      </div>

      {/* Query table */}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {sorted.map((q, i) => (
          <div key={i} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={clsx('font-bold text-xs', opColor(q.opType))}>{q.opType}</span>
              <DbBadge dbType={q.dbType} />
              {q.table && <span className="text-[10px] text-slate-500 font-mono">table: {q.table}</span>}
              <div className="ml-auto flex items-center gap-3 text-xs tabular-nums shrink-0">
                <span className="text-slate-400">{q.count}×</span>
                {q.avgMs > 0 && <span className={clsx(q.avgMs > 500 ? 'text-amber-400' : 'text-slate-500')}>avg {fmtDuration(q.avgMs)}</span>}
                {q.maxMs > 0 && <span className={clsx(q.maxMs > 1000 ? 'text-red-400' : 'text-slate-600')}>max {fmtDuration(q.maxMs)}</span>}
              </div>
            </div>
            <pre className="text-[11px] text-slate-400 font-mono whitespace-pre-wrap break-all leading-relaxed">{q.normalized}</pre>
          </div>
        ))}
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
  const [view, setView] = useState<'live' | 'sessions'>('live')
  const [replaySessionId, setReplaySessionId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

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
        setSidebarOpen(false)
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
    <div className="flex h-full overflow-hidden relative">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-30 md:hidden"
        />
      )}

      {/* Sidebar — container list */}
      <aside className={clsx(
        'w-72 border-r border-slate-800 flex flex-col shrink-0 bg-slate-900/95 md:bg-slate-900/30',
        'fixed inset-y-0 left-0 z-40 transition-transform duration-300 ease-in-out md:relative md:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
      )}>
        <div className="px-4 py-3 border-b border-slate-800">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-sm font-semibold text-slate-200">Request Tracing</p>
              <p className="text-xs text-slate-500 mt-0.5">HTTP · SQL · Redis</p>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={load} className="p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-slate-300">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setSidebarOpen(false)} className="md:hidden p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-slate-300">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-0.5 p-0.5 bg-slate-950 border border-slate-800 rounded-lg">
            <button onClick={() => { setView('live') }}
              className={clsx('flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium transition-all',
                view === 'live' ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>
              <Radio className="w-3 h-3" /> Live
            </button>
            <button onClick={() => { setView('sessions'); setReplaySessionId(null) }}
              className={clsx('flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium transition-all',
                view === 'sessions' ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>
              <History className="w-3 h-3" /> Sessions
            </button>
          </div>
        </div>

        {!canTrace && (
          <div className="m-3 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/20 text-amber-300 text-xs">
            Terminal permission required to enable tracing.
          </div>
        )}

        {view === 'live' && <div className="flex-1 overflow-y-auto py-2">
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
                  onClick={() => { if (isEnabled) { setActiveTrace(name); setSidebarOpen(false) } }}
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
        </div>}

        {/* Sessions sidebar hint */}
        {view === 'sessions' && (
          <div className="flex-1 overflow-y-auto px-4 py-4 text-[11px] text-slate-500 leading-relaxed">
            Saved trace sessions are listed in the main panel. Click any row to replay its request waterfall — including nested SQL and Redis spans — exactly as captured.
          </div>
        )}

        {/* Legend + system requirements */}
        {view === 'live' && <div className="px-4 py-3 border-t border-slate-800 space-y-1.5">
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

          <div className="mt-3 pt-2 border-t border-slate-800 space-y-1.5">
            <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-1">System requirements</p>
            {TRACE_REQUIREMENTS.map(req => (
              <div key={req.label} className="flex items-start gap-2 text-[10px] text-slate-500">
                <ShieldCheck className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                <span><span className="text-slate-400 font-medium">{req.label}</span> — {req.detail}</span>
              </div>
            ))}
          </div>

          <div className="mt-2 pt-2 border-t border-slate-800">
            <p className="text-[10px] text-slate-700 leading-relaxed">
              Requests are grouped into transactions; nested SQL & Redis spans within 500ms are correlated automatically. Encrypted (TLS) traffic is not visible.
            </p>
          </div>
        </div>}
      </aside>

      {/* Main panel */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {view === 'sessions' ? (
          replaySessionId ? (
            <SessionReplayPanel
              key={replaySessionId}
              sessionId={replaySessionId}
              onBack={() => setReplaySessionId(null)}
            />
          ) : (
            <SessionsListPanel onOpen={id => setReplaySessionId(id)} onOpenSidebar={() => setSidebarOpen(true)} />
          )
        ) : activeTrace ? (
          <LiveTracePanel
            key={activeTrace}
            container={activeTrace}
            onStop={() => handleToggle(activeTrace, false)}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-slate-600 p-8 relative">
            <button onClick={() => setSidebarOpen(true)} className="md:hidden absolute top-4 left-4 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-800 text-slate-400 text-xs">
              <Menu className="w-4 h-4" /> Containers
            </button>
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
