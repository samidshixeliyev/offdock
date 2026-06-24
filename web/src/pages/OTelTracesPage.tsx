import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Activity, AlertTriangle, ChevronDown, ChevronRight,
  RefreshCw, GitBranch, Clock, Layers, Trash2, Search, X,
  Globe, Database, Zap, Copy, Check, Tag, Server, Boxes, AlertOctagon,
} from 'lucide-react'
import {
  api, OTelSpan, OTelTrace, OTelStatus, OTelDatabaseQuery, OTelDatabaseResult,
  OTelServiceStat, OTelOperationInfo,
} from '../api/client'
import { Select } from '../components/Select'
import { Pagination } from '../components/Pagination'
import ConfirmModal from '../components/ConfirmModal'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDuration(us: number): string {
  if (us >= 1_000_000) return (us / 1_000_000).toFixed(2) + 's'
  if (us >= 1_000) return (us / 1_000).toFixed(1) + 'ms'
  return us.toFixed(0) + 'μs'
}

function fmtAgo(startTimeMicros: number): string {
  const ms = Date.now() - startTimeMicros / 1000
  if (ms < 5_000) return 'just now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function getServiceForSpan(span: OTelSpan, trace: OTelTrace): string {
  return trace.processes[span.processID]?.serviceName ?? 'unknown'
}

function getRootSpan(trace: OTelTrace): OTelSpan | undefined {
  if (!trace.spans || trace.spans.length === 0) return undefined
  return trace.spans.find(s => !s.references || s.references.length === 0) ?? trace.spans[0]
}

function hasError(span: OTelSpan): boolean {
  return span.tags.some(t =>
    (t.key === 'error' && t.value === true) ||
    (t.key === 'otel.status_code' && t.value === 'ERROR') ||
    (t.key === 'http.status_code' && Number(t.value) >= 500)
  )
}

function traceHasError(trace: OTelTrace): boolean {
  return trace.spans.some(hasError)
}

// Build a flat ordered list of spans with depth, ordered depth-first by startTime.
interface SpanNode {
  span: OTelSpan
  depth: number
  service: string
}

function buildSpanTree(trace: OTelTrace): SpanNode[] {
  const byId = new Map<string, OTelSpan>()
  const children = new Map<string, OTelSpan[]>()

  for (const s of trace.spans) {
    byId.set(s.spanID, s)
    children.set(s.spanID, [])
  }

  const roots: OTelSpan[] = []
  for (const s of trace.spans) {
    const parentRef = s.references?.find(r => r.refType === 'CHILD_OF')
    if (parentRef && byId.has(parentRef.spanID)) {
      children.get(parentRef.spanID)!.push(s)
    } else {
      roots.push(s)
    }
  }

  // Sort children by startTime.
  const sortByStart = (a: OTelSpan, b: OTelSpan) => a.startTime - b.startTime
  for (const [, kids] of children) kids.sort(sortByStart)
  roots.sort(sortByStart)

  const result: SpanNode[] = []
  function walk(span: OTelSpan, depth: number) {
    result.push({ span, depth, service: getServiceForSpan(span, trace) })
    for (const child of (children.get(span.spanID) ?? [])) {
      walk(child, depth + 1)
    }
  }
  for (const root of roots) walk(root, 0)
  return result
}

// Deterministic service color from name hash.
const SERVICE_COLORS = [
  'bg-blue-500/20 text-blue-300 border-blue-500/30',
  'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  'bg-violet-500/20 text-violet-300 border-violet-500/30',
  'bg-amber-500/20 text-amber-300 border-amber-500/30',
  'bg-rose-500/20 text-rose-300 border-rose-500/30',
  'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30',
  'bg-orange-500/20 text-orange-300 border-orange-500/30',
]
const SPAN_BAR_COLORS = [
  'from-blue-500/70 to-blue-400/50',
  'from-emerald-500/70 to-emerald-400/50',
  'from-violet-500/70 to-violet-400/50',
  'from-amber-500/70 to-amber-400/50',
  'from-rose-500/70 to-rose-400/50',
  'from-cyan-500/70 to-cyan-400/50',
  'from-fuchsia-500/70 to-fuchsia-400/50',
  'from-orange-500/70 to-orange-400/50',
]

function serviceColorIdx(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h % SERVICE_COLORS.length
}

function ServiceBadge({ name, small }: { name: string; small?: boolean }) {
  const idx = serviceColorIdx(name)
  return (
    <span className={clsx(
      'inline-flex items-center rounded border font-mono font-medium truncate',
      small ? 'text-[9px] px-1.5 py-0.5 max-w-[80px]' : 'text-[10px] px-2 py-0.5 max-w-[120px]',
      SERVICE_COLORS[idx],
    )}>
      {name}
    </span>
  )
}

// ─── Span detail helpers ──────────────────────────────────────────────────────

function tagVal(span: OTelSpan, key: string): string {
  return String(span.tags.find(t => t.key === key)?.value ?? '')
}

function CopyBtn2({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={e => {
        e.stopPropagation()
        navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) })
      }}
      className="p-0.5 rounded text-slate-700 hover:text-slate-400 shrink-0"
      title="Copy"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
    </button>
  )
}

function fmtTimeUs(us: number): string {
  return new Date(us / 1000).toISOString().replace('T', ' ').replace('Z', ' UTC')
}

function SpanDetailPanel({ span, trace }: { span: OTelSpan; trace: OTelTrace }) {
  const process = trace.processes[span.processID]
  const httpMethod  = tagVal(span, 'http.method') || tagVal(span, 'http.request.method')
  const httpUrl     = tagVal(span, 'http.url') || tagVal(span, 'http.target') || tagVal(span, 'url.full')
  const httpStatus  = tagVal(span, 'http.status_code') || tagVal(span, 'http.response.status_code')
  const httpHost    = tagVal(span, 'http.host') || tagVal(span, 'server.address')
  const dbSystem    = tagVal(span, 'db.system')
  const dbStatement = tagVal(span, 'db.statement')
  const dbName      = tagVal(span, 'db.name')
  const dbTable     = tagVal(span, 'db.sql.table')
  const dbOp        = tagVal(span, 'db.operation')
  const grpcMethod  = tagVal(span, 'rpc.method')
  const grpcService = tagVal(span, 'rpc.service')
  const grpcStatus  = tagVal(span, 'rpc.grpc.status_code')
  const errMsg      = tagVal(span, 'error.message') || tagVal(span, 'exception.message')
  const errType     = tagVal(span, 'error.type') || tagVal(span, 'exception.type')
  const errStack    = tagVal(span, 'exception.stacktrace')
  const errCode     = tagVal(span, 'otel.status_description') || tagVal(span, 'status.message')
  const msgSystem   = tagVal(span, 'messaging.system')
  const msgDest     = tagVal(span, 'messaging.destination') || tagVal(span, 'messaging.destination.name')

  const hasHttp = httpMethod || httpUrl || httpStatus || httpHost
  const hasDb   = dbSystem || dbStatement || dbOp
  const hasGrpc = grpcMethod || grpcService
  const hasMq   = msgSystem || msgDest
  const hasErr  = errMsg || errType || errStack || errCode

  // Remaining "other" tags after extracting structured ones above
  const usedKeys = new Set([
    'http.method','http.request.method','http.url','http.target','url.full',
    'http.status_code','http.response.status_code','http.host','server.address',
    'db.system','db.statement','db.name','db.sql.table','db.operation',
    'rpc.method','rpc.service','rpc.grpc.status_code',
    'error.message','exception.message','error.type','exception.type',
    'exception.stacktrace','otel.status_description','status.message',
    'messaging.system','messaging.destination','messaging.destination.name',
    'span.kind','otel.status_code',
  ])
  const otherTags = span.tags.filter(t => !usedKeys.has(t.key))
  // Group remaining attributes by namespace (prefix before first dot) so every
  // captured attribute is shown, organized — like Dynatrace's attribute groups.
  const tagGroups = (() => {
    const m = new Map<string, { key: string; value: string }[]>()
    for (const t of otherTags) {
      const ns = t.key.includes('.') ? t.key.slice(0, t.key.indexOf('.')) : 'other'
      if (!m.has(ns)) m.set(ns, [])
      m.get(ns)!.push({ key: t.key, value: String(t.value) })
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })()

  const statusNum = httpStatus ? Number(httpStatus) : 0
  const statusColor = statusNum >= 500 ? 'text-red-400' : statusNum >= 400 ? 'text-amber-400' : statusNum >= 300 ? 'text-blue-400' : 'text-emerald-400'

  return (
    <div className="mx-3 mb-2 space-y-2 text-[10px] font-mono">
      {/* HTTP section */}
      {hasHttp && (
        <div className="rounded-lg border border-blue-500/20 bg-blue-950/10 px-3 py-2 space-y-1">
          <div className="flex items-center gap-1.5 mb-1">
            <Globe className="w-3 h-3 text-blue-400" />
            <span className="text-[9px] uppercase tracking-wider text-blue-400 font-semibold">HTTP</span>
          </div>
          {httpMethod && (
            <div className="flex items-center gap-2">
              <span className="text-slate-600 w-16 shrink-0">method</span>
              <span className="text-blue-200 font-bold">{httpMethod}</span>
            </div>
          )}
          {httpUrl && (
            <div className="flex items-start gap-2">
              <span className="text-slate-600 w-16 shrink-0">url</span>
              <span className="text-slate-300 break-all flex-1">{httpUrl}</span>
              <CopyBtn2 text={httpUrl} />
            </div>
          )}
          {httpHost && !httpUrl && (
            <div className="flex items-center gap-2">
              <span className="text-slate-600 w-16 shrink-0">host</span>
              <span className="text-slate-300">{httpHost}</span>
            </div>
          )}
          {httpStatus && (
            <div className="flex items-center gap-2">
              <span className="text-slate-600 w-16 shrink-0">status</span>
              <span className={clsx('font-bold', statusColor)}>{httpStatus}</span>
            </div>
          )}
        </div>
      )}

      {/* DB section */}
      {hasDb && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-950/10 px-3 py-2 space-y-1.5">
          <div className="flex items-center gap-1.5 mb-1">
            <Database className="w-3 h-3 text-amber-400" />
            <span className="text-[9px] uppercase tracking-wider text-amber-400 font-semibold">
              {dbSystem ? dbSystem.toUpperCase() : 'DATABASE'}
            </span>
            {dbName && <span className="text-slate-600">· {dbName}</span>}
            {dbTable && <span className="text-slate-600">· table: {dbTable}</span>}
            {dbOp && <span className="text-amber-300/60 font-bold">{dbOp}</span>}
          </div>
          {dbStatement && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-slate-600">statement</span>
                <CopyBtn2 text={dbStatement} />
              </div>
              <pre className="text-amber-200/90 whitespace-pre-wrap break-all leading-relaxed rounded px-2.5 py-2 bg-amber-950/30 max-h-40 overflow-y-auto text-[11px]">
                {dbStatement}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* gRPC section */}
      {hasGrpc && (
        <div className="rounded-lg border border-violet-500/20 bg-violet-950/10 px-3 py-2 space-y-1">
          <div className="flex items-center gap-1.5 mb-1">
            <Zap className="w-3 h-3 text-violet-400" />
            <span className="text-[9px] uppercase tracking-wider text-violet-400 font-semibold">gRPC</span>
          </div>
          {grpcService && (
            <div className="flex items-center gap-2">
              <span className="text-slate-600 w-16 shrink-0">service</span>
              <span className="text-slate-300">{grpcService}</span>
            </div>
          )}
          {grpcMethod && (
            <div className="flex items-center gap-2">
              <span className="text-slate-600 w-16 shrink-0">method</span>
              <span className="text-violet-200 font-bold">{grpcMethod}</span>
            </div>
          )}
          {grpcStatus && (
            <div className="flex items-center gap-2">
              <span className="text-slate-600 w-16 shrink-0">status</span>
              <span className={clsx('font-bold', grpcStatus === '0' ? 'text-emerald-400' : 'text-red-400')}>{grpcStatus}</span>
            </div>
          )}
        </div>
      )}

      {/* Messaging section */}
      {hasMq && (
        <div className="rounded-lg border border-cyan-500/20 bg-cyan-950/10 px-3 py-2 space-y-1">
          <div className="flex items-center gap-1.5 mb-1">
            <Activity className="w-3 h-3 text-cyan-400" />
            <span className="text-[9px] uppercase tracking-wider text-cyan-400 font-semibold">
              {msgSystem ? msgSystem.toUpperCase() : 'MESSAGING'}
            </span>
          </div>
          {msgDest && (
            <div className="flex items-center gap-2">
              <span className="text-slate-600 w-16 shrink-0">dest</span>
              <span className="text-cyan-200">{msgDest}</span>
            </div>
          )}
        </div>
      )}

      {/* Error section */}
      {hasErr && (
        <div className="rounded-lg border border-red-500/20 bg-red-950/10 px-3 py-2 space-y-1">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle className="w-3 h-3 text-red-400" />
            <span className="text-[9px] uppercase tracking-wider text-red-400 font-semibold">Error</span>
          </div>
          {errType && (
            <div className="flex items-center gap-2">
              <span className="text-slate-600 w-16 shrink-0">type</span>
              <span className="text-red-300 font-bold">{errType}</span>
            </div>
          )}
          {errMsg && (
            <div className="flex items-start gap-2">
              <span className="text-slate-600 w-16 shrink-0">message</span>
              <span className="text-red-200/90 break-all flex-1">{errMsg}</span>
            </div>
          )}
          {errCode && !errMsg && (
            <div className="flex items-start gap-2">
              <span className="text-slate-600 w-16 shrink-0">status</span>
              <span className="text-red-200/90 break-all flex-1">{errCode}</span>
            </div>
          )}
          {errStack && (
            <div className="pt-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-slate-600">stacktrace</span>
                <CopyBtn2 text={errStack} />
              </div>
              <pre className="text-[10px] text-red-200/80 font-mono whitespace-pre-wrap break-all leading-relaxed rounded px-2.5 py-2 bg-red-950/30 max-h-[32rem] overflow-y-auto">
                {errStack}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* All captured attributes — grouped by namespace (http.*, net.*, db.*, code.*…) */}
      {tagGroups.length > 0 && (
        <div className="rounded-lg border border-slate-700/50 bg-slate-900/40 px-3 py-2 space-y-2">
          <div className="flex items-center gap-1.5">
            <Tag className="w-3 h-3 text-slate-500" />
            <span className="text-[9px] uppercase tracking-wider text-slate-600 font-semibold">
              All attributes ({otherTags.length})
            </span>
          </div>
          {tagGroups.map(([ns, items]) => (
            <div key={ns} className="space-y-0.5">
              <div className="text-[9px] uppercase tracking-wider text-slate-500/80 font-semibold border-b border-slate-800/60 pb-0.5">{ns}</div>
              {items.map((t, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-slate-600 shrink-0 min-w-[7rem] max-w-[12rem] truncate" title={t.key}>{t.key}</span>
                  <span className="text-slate-300 break-all flex-1">{t.value}</span>
                  <CopyBtn2 text={t.value} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Span events (exception stack traces, custom events) */}
      {span.logs && span.logs.length > 0 && (
        <div className="rounded-lg border border-rose-500/20 bg-rose-950/8 px-3 py-2 space-y-2">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle className="w-3 h-3 text-rose-400" />
            <span className="text-[9px] uppercase tracking-wider text-rose-400 font-semibold">
              Span Events ({span.logs.length})
            </span>
          </div>
          {span.logs.map((log, i) => {
            const eventName = log.fields.find(f => f.key === 'event')?.value ?? 'event'
            const exType  = log.fields.find(f => f.key === 'exception.type')?.value
            const exMsg   = log.fields.find(f => f.key === 'exception.message')?.value
            const exStack = log.fields.find(f => f.key === 'exception.stacktrace')?.value
            const otherFields = log.fields.filter(f =>
              !['event','exception.type','exception.message','exception.stacktrace'].includes(f.key)
            )
            return (
              <div key={i} className="border border-rose-500/15 rounded-lg px-2.5 py-2 bg-rose-950/15 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-bold text-rose-300 uppercase">{String(eventName)}</span>
                  <span className="text-[9px] text-slate-600">{fmtTimeUs(log.timestamp)}</span>
                </div>
                {exType && (
                  <div className="flex items-center gap-2">
                    <span className="text-slate-600 w-20 shrink-0">type</span>
                    <span className="text-red-300 font-bold">{String(exType)}</span>
                  </div>
                )}
                {exMsg && (
                  <div className="flex items-start gap-2">
                    <span className="text-slate-600 w-20 shrink-0">message</span>
                    <span className="text-red-200/90 break-all">{String(exMsg)}</span>
                  </div>
                )}
                {exStack && (
                  <div>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-slate-600">stacktrace</span>
                      <CopyBtn2 text={String(exStack)} />
                    </div>
                    <pre className="text-[10px] text-rose-200/80 font-mono whitespace-pre-wrap break-all leading-relaxed rounded px-2 py-1.5 bg-rose-950/30 max-h-[32rem] overflow-y-auto">
                      {String(exStack)}
                    </pre>
                  </div>
                )}
                {otherFields.map((f, j) => (
                  <div key={j} className="flex gap-2">
                    <span className="text-slate-600 w-20 shrink-0">{f.key}</span>
                    <span className="text-slate-300 break-all">{String(f.value)}</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}

      {/* Resource / process info */}
      {process && (process.tags?.length > 0 || span.scopeName) && (
        <div className="rounded-lg border border-slate-700/40 bg-slate-900/30 px-3 py-2 space-y-0.5">
          <div className="flex items-center gap-1.5 mb-1">
            <Layers className="w-3 h-3 text-slate-600" />
            <span className="text-[9px] uppercase tracking-wider text-slate-600 font-semibold">
              Resource · {process.serviceName}
            </span>
          </div>
          {span.scopeName && (
            <div className="flex gap-2">
              <span className="text-slate-600 w-28 shrink-0">instrumented by</span>
              <span className="text-slate-400">
                {span.scopeName}{span.scopeVersion ? ` v${span.scopeVersion}` : ''}
              </span>
            </div>
          )}
          {process.tags?.filter(t => t.key !== 'service.name').map((t, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-slate-600 shrink-0 w-28 truncate">{t.key}</span>
              <span className="text-slate-400 break-all">{String(t.value)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Timing summary */}
      <div className="rounded-lg border border-slate-700/40 bg-slate-900/30 px-3 py-2 space-y-0.5">
        <div className="flex items-center gap-1.5 mb-1">
          <Clock className="w-3 h-3 text-slate-600" />
          <span className="text-[9px] uppercase tracking-wider text-slate-600 font-semibold">Timing</span>
        </div>
        <div className="flex gap-2">
          <span className="text-slate-600 w-16 shrink-0">start</span>
          <span className="text-slate-400 font-mono">{fmtTimeUs(span.startTime)}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-slate-600 w-16 shrink-0">duration</span>
          <span className="text-slate-200 font-mono font-semibold">{fmtDuration(span.duration)}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-slate-600 w-16 shrink-0">span id</span>
          <span className="text-slate-500 font-mono text-[9px]">{span.spanID}</span>
          <CopyBtn2 text={span.spanID} />
        </div>
        <div className="flex gap-2">
          <span className="text-slate-600 w-16 shrink-0">trace id</span>
          <span className="text-slate-500 font-mono text-[9px] truncate">{span.traceID}</span>
          <CopyBtn2 text={span.traceID} />
        </div>
      </div>
    </div>
  )
}

// ─── Trace header summary ─────────────────────────────────────────────────────

function TraceHeader({ trace, totalDuration }: { trace: OTelTrace; totalDuration: number }) {
  // Per-service span counts + error counts.
  const svc = new Map<string, { spans: number; errors: number }>()
  let dbCount = 0, httpCount = 0, errorCount = 0
  for (const s of trace.spans) {
    const name = getServiceForSpan(s, trace)
    const e = svc.get(name) ?? { spans: 0, errors: 0 }
    e.spans++
    const isE = hasError(s)
    if (isE) { e.errors++; errorCount++ }
    svc.set(name, e)
    if (s.tags.some(t => t.key === 'db.statement' || t.key === 'db.system')) dbCount++
    if (s.tags.some(t => t.key === 'http.method' || t.key === 'http.request.method')) httpCount++
  }
  const services = [...svc.entries()].sort((a, b) => b[1].spans - a[1].spans)

  const chip = (label: string, value: string | number, tone: string) => (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900/60 border border-slate-800">
      <span className={clsx('text-[10px] uppercase tracking-wider font-semibold', tone)}>{label}</span>
      <span className="text-xs font-semibold text-slate-200 tabular-nums">{value}</span>
    </div>
  )

  return (
    <div className="px-3 py-2.5 bg-slate-900/40 border-b border-slate-800/60 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {chip('Duration', fmtDuration(totalDuration), 'text-emerald-400')}
        {chip('Spans', trace.spans.length, 'text-blue-400')}
        {chip('Services', services.length, 'text-violet-400')}
        {httpCount > 0 && chip('HTTP', httpCount, 'text-cyan-400')}
        {dbCount > 0 && chip('DB calls', dbCount, 'text-amber-400')}
        {chip('Errors', errorCount, errorCount > 0 ? 'text-red-400' : 'text-slate-500')}
      </div>
      {/* Per-service breakdown */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[9px] uppercase tracking-wider text-slate-600 font-semibold mr-0.5">Services</span>
        {services.map(([name, s]) => (
          <span key={name} className="inline-flex items-center gap-1">
            <ServiceBadge name={name} small />
            <span className="text-[9px] text-slate-500 tabular-nums">{s.spans}{s.errors > 0 && <span className="text-red-400"> · {s.errors}✕</span>}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Waterfall time ruler ─────────────────────────────────────────────────────

function WaterfallRuler({ traceDuration }: { traceDuration: number }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-900/70 border-b border-slate-800/60 sticky top-0 z-10">
      <span className="w-3 shrink-0" />
      <div className="flex-1 text-[9px] text-slate-600 uppercase tracking-wider font-semibold">Span · service</div>
      <div className="shrink-0 w-[320px] relative h-3.5">
        {ticks.map((f, i) => (
          <div key={i} className="absolute top-0 bottom-0 border-l border-slate-700/30 flex items-start"
            style={{ left: `${f * 100}%` }}>
            <span className={clsx('text-[8px] text-slate-500 tabular-nums px-1', i === ticks.length - 1 && '-translate-x-full')}>
              {fmtDuration(traceDuration * f)}
            </span>
          </div>
        ))}
      </div>
      <div className="shrink-0 w-16 text-[9px] text-slate-600 uppercase tracking-wider font-semibold text-right">Offset</div>
    </div>
  )
}

// ─── Span detail row ─────────────────────────────────────────────────────────

interface SpanRowProps {
  node: SpanNode
  traceStart: number
  traceDuration: number
  trace: OTelTrace
}

function SpanRow({ node, traceStart, traceDuration, trace }: SpanRowProps) {
  const [open, setOpen] = useState(false)
  const { span, depth, service } = node
  const isErr = hasError(span)

  const offsetUs = span.startTime - traceStart
  const barLeft = traceDuration > 0 ? (offsetUs / traceDuration) * 100 : 0
  const barWidth = Math.max(
    traceDuration > 0 ? (span.duration / traceDuration) * 100 : 0,
    0.6,
  )
  const clampedLeft = Math.min(barLeft, 99)
  const clampedWidth = Math.max(Math.min(barWidth, 100 - clampedLeft), 0.6)

  // Colour the bar by service so each service reads as a consistent lane;
  // errors always go red regardless of service.
  const barGradient = isErr
    ? 'from-red-500/80 to-red-400/60'
    : SPAN_BAR_COLORS[serviceColorIdx(service) % SPAN_BAR_COLORS.length]

  // Show a sub-label for common span types
  const httpMethod = tagVal(span, 'http.method') || tagVal(span, 'http.request.method')
  const httpStatus = tagVal(span, 'http.status_code') || tagVal(span, 'http.response.status_code')
  const dbSystem   = tagVal(span, 'db.system')
  const dbOp       = tagVal(span, 'db.operation')

  return (
    <>
      <div
        onClick={() => setOpen(o => !o)}
        className="group flex items-start gap-2 px-3 py-1.5 hover:bg-slate-800/40 cursor-pointer border-b border-slate-800/30 transition-colors"
      >
        {/* Indent + arrow */}
        <div className="flex items-center shrink-0 mt-0.5" style={{ paddingLeft: depth * 16 }}>
          {open
            ? <ChevronDown className="w-3 h-3 text-slate-500" />
            : <ChevronRight className="w-3 h-3 text-slate-600 group-hover:text-slate-400" />
          }
        </div>

        {/* Left: service + operation + kind hints */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <ServiceBadge name={service} small />
          <span className={clsx(
            'text-[11px] font-mono truncate',
            isErr ? 'text-red-300' : 'text-slate-200',
          )}>
            {span.operationName}
          </span>
          {/* HTTP method + status inline hint */}
          {httpMethod && (
            <span className="shrink-0 text-[9px] font-bold text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-1 py-px">
              {httpMethod}
            </span>
          )}
          {httpStatus && (
            <span className={clsx(
              'shrink-0 text-[9px] font-bold rounded px-1 py-px border',
              Number(httpStatus) >= 500 ? 'text-red-400 bg-red-500/10 border-red-500/20'
              : Number(httpStatus) >= 400 ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
              : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
            )}>
              {httpStatus}
            </span>
          )}
          {/* DB type hint */}
          {dbSystem && !httpMethod && (
            <span className="shrink-0 text-[9px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1 py-px">
              {dbSystem.toUpperCase()}
              {dbOp ? ` ${dbOp}` : ''}
            </span>
          )}
          {isErr && (
            <span className="shrink-0 text-[9px] font-semibold text-red-400 bg-red-500/10 border border-red-500/20 rounded px-1 py-px">
              ERR
            </span>
          )}
        </div>

        {/* Waterfall bar column */}
        <div className="shrink-0 w-[320px] relative h-5 flex items-center"
          title={`${span.operationName}\nstart +${fmtDuration(offsetUs)} · ${fmtDuration(span.duration)}`}>
          <div className="absolute inset-0 flex items-center">
            {/* Grid lines aligned to the ruler ticks */}
            {[0, 25, 50, 75, 100].map(pct => (
              <div key={pct} className="absolute top-0 bottom-0 w-px bg-slate-700/25" style={{ left: `${pct}%` }} />
            ))}
            {/* Baseline */}
            <div className="absolute left-0 right-0 h-px bg-slate-800/60" />
            {/* Bar */}
            <div
              className={clsx('absolute h-[11px] rounded-[3px] bg-gradient-to-r shadow-sm', barGradient,
                isErr && 'ring-1 ring-red-400/40')}
              style={{ left: `${clampedLeft}%`, width: `${clampedWidth}%` }}
            />
            {/* Inline duration label, placed just after the bar */}
            <span
              className="absolute text-[9px] font-mono text-slate-400 tabular-nums whitespace-nowrap pointer-events-none"
              style={
                clampedLeft + clampedWidth > 82
                  ? { right: `${100 - clampedLeft}%`, paddingRight: 4 }
                  : { left: `${clampedLeft + clampedWidth}%`, paddingLeft: 4 }
              }
            >
              {fmtDuration(span.duration)}
            </span>
          </div>
        </div>

        {/* Offset from trace start */}
        <span className="shrink-0 text-[10px] font-mono text-slate-600 w-16 text-right tabular-nums">
          +{fmtDuration(offsetUs)}
        </span>
      </div>

      {/* Structured span detail */}
      {open && (
        <SpanDetailPanel span={span} trace={trace} />
      )}
    </>
  )
}

// ─── Trace row (accordion) ──────────────────────────────────────────────────

interface TraceRowProps {
  trace: OTelTrace
  idx: number
}

function TraceRow({ trace, idx }: TraceRowProps) {
  const [open, setOpen] = useState(false)
  const [loadedTrace, setLoadedTrace] = useState<OTelTrace | null>(null)
  const [loading, setLoading] = useState(false)

  if (!trace.spans || trace.spans.length === 0) return null
  const root = getRootSpan(trace)
  if (!root) return null
  const service = getServiceForSpan(root, trace)
  const isErr = traceHasError(trace)
  // Use earliest span start (not root.startTime) to avoid negative durations
  // when root span is not the earliest in the trace.
  const traceStartTime = Math.min(...trace.spans.map(s => s.startTime))
  const traceEndTime = Math.max(...trace.spans.map(s => s.startTime + s.duration))
  const totalDuration = Math.max(0, traceEndTime - traceStartTime)

  const toggle = async () => {
    if (!open && !loadedTrace) {
      setLoading(true)
      try {
        const res = await api.otelTrace(trace.traceID)
        const full = res.data?.[0] ?? trace
        setLoadedTrace(full)
      } catch {
        setLoadedTrace(trace)
      } finally { setLoading(false) }
    }
    setOpen(o => !o)
  }

  const displayTrace = loadedTrace ?? trace
  const nodes = open ? buildSpanTree(displayTrace) : []
  const traceStart = Math.min(...displayTrace.spans.map(s => s.startTime))
  const traceEnd = Math.max(...displayTrace.spans.map(s => s.startTime + s.duration))
  const traceDuration = traceEnd - traceStart || 1

  return (
    <div className={clsx('border-b border-slate-800/50', idx % 2 === 0 ? 'bg-slate-950/20' : '')}>
      {/* Summary row */}
      <div
        onClick={toggle}
        className={clsx(
          'flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors hover:bg-slate-800/30',
          open && 'bg-slate-800/20',
        )}
      >
        <span className="shrink-0">
          {open
            ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            : <ChevronRight className="w-3.5 h-3.5 text-slate-600" />
          }
        </span>

        {/* Service badge */}
        <ServiceBadge name={service} />

        {/* Operation */}
        <span className={clsx(
          'flex-1 min-w-0 text-[11px] font-mono truncate',
          isErr ? 'text-red-300' : 'text-slate-200',
        )}>
          {root.operationName}
        </span>

        {/* Duration */}
        <span className={clsx(
          'shrink-0 text-[11px] font-mono font-semibold',
          totalDuration > 2_000_000 ? 'text-red-400'
            : totalDuration > 500_000 ? 'text-amber-400'
            : 'text-emerald-400',
        )}>
          {fmtDuration(totalDuration)}
        </span>

        {/* Span count */}
        <span className="shrink-0 text-[9px] font-semibold text-slate-500 bg-slate-800 rounded px-1.5 py-0.5">
          {trace.spans.length} spans
        </span>

        {/* Status */}
        {isErr
          ? <span className="shrink-0 text-[9px] font-semibold text-red-400 bg-red-500/10 border border-red-500/20 rounded px-1.5 py-0.5">ERROR</span>
          : <span className="shrink-0 text-[9px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5">OK</span>
        }

        {/* Time */}
        <span className="shrink-0 text-[10px] text-slate-600 w-16 text-right">
          {fmtAgo(root.startTime)}
        </span>
      </div>

      {/* Waterfall */}
      {open && (
        <div className="border-t border-slate-800/50 bg-slate-950/40">
          {/* Trace summary header */}
          {!loading && <TraceHeader trace={displayTrace} totalDuration={traceDuration} />}
          {/* Time ruler */}
          <WaterfallRuler traceDuration={traceDuration} />
          {loading ? (
            <div className="p-4 text-center text-slate-600 text-xs flex items-center justify-center gap-2">
              <RefreshCw className="w-3 h-3 animate-spin" /> Loading spans…
            </div>
          ) : (
            <div>
              {nodes.map((node, i) => (
                <SpanRow
                  key={node.span.spanID + i}
                  node={node}
                  traceStart={traceStart}
                  traceDuration={traceDuration}
                  trace={displayTrace}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Integration guide ────────────────────────────────────────────────────────

const LANG_EXAMPLES: Array<{ id: string; label: string; code: string }> = [
  {
    id: 'java',
    label: 'Java (auto)',
    code: `# Nothing needed — the OTel Java agent is injected automatically
# by OffDock when "Enable OpenTelemetry tracing" is ON in Deploy Settings.
# Spring Boot, Quarkus, Micronaut, plain Java — all auto-instrumented.`,
  },
  {
    id: 'nodejs',
    label: 'Node.js (auto)',
    code: `# Nothing needed — offdock-tracer.js is injected automatically.
# Instruments http/https/fetch calls + express/fastify request handlers.
# AUTO DB SPANS: pg, mysql/mysql2, mongodb, redis/ioredis — captured
# automatically with db.system + db.statement (shows in the Database view).
# NODE_OPTIONS=--require /otel/node/tracer.js  ← set by OffDock`,
  },
  {
    id: 'php',
    label: 'PHP (auto)',
    code: `# Auto-injected via auto_prepend_file — no code change for request traces:
#  • continues the DISTRIBUTED trace (reads incoming W3C traceparent header)
#  • rich request span: method, route, status, sizes, client, user-agent
#  • uncaught exceptions + fatal errors captured (type, message, stacktrace)
# PHP_INI_SCAN_DIR=:/otel/php  ← set by OffDock (leading ":" keeps your app's inis)

# ── DB query spans: ONE-LINE opt-in (PHP can't auto-trace PDO) ──
# Unlike Node/Python, PHP cannot override its internal PDO class without a C
# extension, so swap new PDO(...) for offdock_pdo(...) at your DB bootstrap:
$pdo = offdock_pdo('pgsql:host=db;dbname=app', 'user', 'pass');  # mysql/mssql/sqlite too
# every $pdo->query()/exec()/prepare()->execute() now emits a child span with
# the full SQL, nested under the request — end-to-end like Dynatrace.

# Forward context on outgoing HTTP calls so downstream services join the trace:
curl_setopt($ch, CURLOPT_HTTPHEADER, ['traceparent: '.offdock_traceparent()]);`,
  },
  {
    id: 'python',
    label: 'Python (auto)',
    code: `# Nothing needed — sitecustomize.py is injected automatically.
# Instruments outgoing HTTP calls via http.client
# (covers requests, urllib, urllib3, httpx, and most HTTP libraries).
# AUTO DB SPANS: psycopg2, pymysql/MySQLdb, sqlite3, pyodbc, redis, pymongo —
# captured automatically with db.system + db.statement (Database view).
# PYTHONPATH=/otel/python  ← prepended by OffDock`,
  },
  {
    id: 'ruby',
    label: 'Ruby (auto)',
    code: `# Nothing needed — tracer.rb is injected automatically.
# Instruments outgoing HTTP/HTTPS calls via Net::HTTP
# (covers Faraday, HTTParty, open-uri, RestClient, and most HTTP libraries).
# RUBYOPT=-r /otel/ruby/tracer.rb  ← set by OffDock`,
  },
  {
    id: 'go',
    label: 'Go',
    code: `// POST /v1/span — works from any language, no SDK needed
import "net/http"; import "encoding/json"; import "bytes"; import "time"

func trace(service, name string, start time.Time, tags map[string]string) {
    span := map[string]any{
        "service":  service,
        "name":     name,
        "start_ms": start.UnixMilli(),
        "end_ms":   time.Now().UnixMilli(),
        "status":   "ok",
        "tags":     tags,
    }
    b, _ := json.Marshal(span)
    http.Post("http://host.docker.internal:7070/v1/span",
              "application/json", bytes.NewReader(b))
}`,
  },
  {
    id: 'php-manual',
    label: 'PHP (manual)',
    code: `<?php
// POST /v1/span — 5 lines, no Composer needed
function trace(string $name, int $startMs, array $tags = []): void {
    $body = json_encode(['service'=>$_ENV['OTEL_SERVICE_NAME']??'php-app',
        'name'=>$name, 'start_ms'=>$startMs, 'end_ms'=>(int)(microtime(true)*1000),
        'tags'=>$tags]);
    $ctx = stream_context_create(['http'=>['method'=>'POST','content'=>$body,
        'header'=>"Content-Type: application/json\r\n",'timeout'=>0.5]]);
    @file_get_contents('http://host.docker.internal:7070/v1/span', false, $ctx);
}`,
  },
  {
    id: 'delphi',
    label: 'Delphi',
    code: `// POST /v1/span — THTTPClient (no external libraries needed)
procedure TraceSpan(const Service, Name: string; StartMs, EndMs: Int64;
                    const Status: string = 'ok');
var
  Client: THTTPClient;
  Body: TStringStream;
begin
  Client := THTTPClient.Create;
  Body   := TStringStream.Create(Format(
    '{"service":"%s","name":"%s","start_ms":%d,"end_ms":%d,"status":"%s"}',
    [Service, Name, StartMs, EndMs, Status]), TEncoding.UTF8);
  try
    Client.Post('http://host.docker.internal:7070/v1/span', Body, nil,
                [TNameValuePair.Create('Content-Type','application/json')]);
  finally
    Body.Free; Client.Free;
  end;
end;`,
  },
  {
    id: 'curl',
    label: 'Any / cURL',
    code: `# POST /v1/span — works from shell scripts, any HTTP client
curl -s -X POST http://host.docker.internal:7070/v1/span \\
  -H "Content-Type: application/json" \\
  -d '{
    "service": "my-app",
    "name":    "processOrder",
    "start_ms": '"$(date +%s%3N)"',
    "end_ms":   '"$(date +%s%3N)"',
    "status":  "ok",
    "tags":    {"order.id": "12345"}
  }'

# For chaining spans, capture the returned trace_id/span_id:
# {"trace_id":"...","span_id":"..."}`,
  },
]

function IntegrationGuide() {
  const [active, setActive] = useState('java')
  const ex = LANG_EXAMPLES.find(e => e.id === active) ?? LANG_EXAMPLES[0]
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">
        Auto-injected on deploy — or use the universal <code className="text-blue-400">POST /v1/span</code> endpoint from any language:
      </p>
      {/* Language tabs */}
      <div className="flex flex-wrap gap-1">
        {LANG_EXAMPLES.map(e => (
          <button key={e.id} onClick={() => setActive(e.id)}
            className={clsx('text-[10px] px-2 py-1 rounded border transition-colors',
              e.id === active
                ? 'bg-blue-500/20 border-blue-500/40 text-blue-300'
                : 'border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-600')}>
            {e.label}
          </button>
        ))}
      </div>
      {/* Code block */}
      <pre className="bg-slate-950/80 border border-slate-800 rounded-lg p-3 text-[10px] text-slate-300 font-mono overflow-x-auto whitespace-pre-wrap leading-5">
        {ex.code}
      </pre>
    </div>
  )
}

// ─── Database (full-query) view — Dynatrace-style ─────────────────────────────

function fmtMsNum(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(2) + 's'
  if (ms >= 1) return ms.toFixed(1) + 'ms'
  return (ms * 1000).toFixed(0) + 'μs'
}

const OP_COLORS: Record<string, string> = {
  SELECT: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/25',
  INSERT: 'text-blue-300 bg-blue-500/10 border-blue-500/25',
  UPDATE: 'text-amber-300 bg-amber-500/10 border-amber-500/25',
  DELETE: 'text-red-300 bg-red-500/10 border-red-500/25',
}
function opColor(op: string): string {
  return OP_COLORS[op] ?? 'text-slate-300 bg-slate-700/30 border-slate-600/30'
}

function DbQueryRow({ q }: { q: OTelDatabaseQuery }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <tr onClick={() => setOpen(o => !o)} className="border-b border-slate-800/40 hover:bg-slate-800/30 cursor-pointer">
        <td className="px-3 py-2">
          {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-600" />}
        </td>
        <td className="px-3 py-2"><span className={clsx('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border', opColor(q.operation))}>{q.operation}</span></td>
        <td className="px-3 py-2 font-mono text-[11px] text-slate-300 max-w-[460px] truncate" title={q.normalized}>
          {q.service && <span className="mr-1.5 align-middle inline-flex"><ServiceBadge name={q.service} small /></span>}
          {q.normalized}
        </td>
        <td className="px-3 py-2 text-[11px] text-slate-500 whitespace-nowrap">{q.db_system || '—'}{q.table ? <span className="text-slate-600"> · {q.table}</span> : null}</td>
        <td className="px-3 py-2 text-right tabular-nums text-xs text-slate-300">{q.count.toLocaleString()}</td>
        <td className="px-3 py-2 text-right tabular-nums text-xs text-slate-400">{fmtMsNum(q.avg_ms)}</td>
        <td className={clsx('px-3 py-2 text-right tabular-nums text-xs', q.max_ms > 1000 ? 'text-red-400' : q.max_ms > 200 ? 'text-amber-400' : 'text-slate-400')}>{fmtMsNum(q.max_ms)}</td>
        <td className="px-3 py-2 text-right tabular-nums text-xs text-slate-200 font-semibold">{fmtMsNum(q.total_ms)}</td>
        <td className="px-3 py-2 text-right tabular-nums text-xs">{q.errors > 0 ? <span className="text-red-400 font-semibold">{q.errors}</span> : <span className="text-slate-600">0</span>}</td>
      </tr>
      {open && (
        <tr className="bg-slate-950/70">
          <td colSpan={9} className="px-4 py-3">
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold flex items-center gap-1.5"><Database className="w-3 h-3" /> Full statement</span>
                  <CopyBtn2 text={q.sample || q.normalized} />
                </div>
                <pre className="text-[11px] text-amber-200/90 font-mono whitespace-pre-wrap break-all leading-relaxed rounded-lg px-3 py-2.5 bg-amber-950/20 border border-amber-500/15 max-h-72 overflow-y-auto">
                  {q.sample || q.normalized}
                </pre>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                {[
                  ['Executions', q.count.toLocaleString()],
                  ['Total time', fmtMsNum(q.total_ms)],
                  ['Avg', fmtMsNum(q.avg_ms)],
                  ['Min', fmtMsNum(q.min_ms)],
                  ['Max', fmtMsNum(q.max_ms)],
                  ['Errors', String(q.errors)],
                  ['Database', q.db_name || '—'],
                  ['Table', q.table || '—'],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-slate-800 bg-slate-900/50 px-2.5 py-1.5">
                    <div className="text-[9px] uppercase tracking-wider text-slate-600">{k}</div>
                    <div className="text-slate-200 font-mono truncate" title={v}>{v}</div>
                  </div>
                ))}
              </div>
              {q.services.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[9px] uppercase tracking-wider text-slate-600 font-semibold mr-1">Services</span>
                  {q.services.map(s => <ServiceBadge key={s} name={s} small />)}
                </div>
              )}
              <div className="flex items-center gap-2 text-[10px] text-slate-600">
                <Clock className="w-3 h-3" /> last seen {fmtAgo(q.last_seen_us)}
                {q.example_trace_id && <span className="font-mono">· slowest trace {q.example_trace_id.slice(0, 16)}…</span>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function DatabaseView() {
  const [rows, setRows] = useState<OTelDatabaseQuery[]>([])
  const [systems, setSystems] = useState<string[]>([])
  const [services, setServices] = useState<string[]>([])
  const [totals, setTotals] = useState<OTelDatabaseResult['totals']>({ queries: 0, executions: 0, total_ms: 0, slowest_ms: 0 })
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const [service, setService] = useState('')
  const [dbSystem, setDbSystem] = useState('')
  const [timeRange, setTimeRange] = useState('')
  const [sortBy, setSortBy] = useState('total')
  const [search, setSearch] = useState('')
  const [minMs, setMinMs] = useState('')
  const [byService, setByService] = useState(false)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const loadRef = useRef(0)

  useEffect(() => { api.otelServices().then(r => setServices(r.data ?? [])).catch(() => {}) }, [])
  useEffect(() => { setPage(0) }, [service, dbSystem, timeRange, sortBy, search, minMs, byService, pageSize])

  useEffect(() => {
    const t = setTimeout(async () => {
      const id = ++loadRef.current
      setLoading(true)
      try {
        const res = await api.otelDatabase({
          service: service || undefined,
          db_system: dbSystem || undefined,
          time_range: timeRange || undefined,
          sort: sortBy,
          search: search || undefined,
          min_duration_ms: minMs ? Number(minMs) : undefined,
          by_service: byService || undefined,
          limit: pageSize,
          offset: page * pageSize,
        })
        if (id === loadRef.current) {
          setRows(res.data ?? [])
          setTotal(res.total ?? 0)
          setTotals(res.totals)
          setSystems(res.systems ?? [])
        }
      } catch {
        if (id === loadRef.current) { setRows([]); setTotal(0) }
      } finally {
        if (id === loadRef.current) setLoading(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [service, dbSystem, timeRange, sortBy, search, minMs, byService, page, pageSize])

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Filters */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-800 bg-slate-900/30">
        <Select size="sm" icon={Server} className="w-40" value={service} onChange={setService}
          placeholder="All services"
          options={[{ value: '', label: 'All services' }, ...services.map(s => ({ value: s, label: s }))]} />
        <Select size="sm" icon={Database} className="w-36" value={dbSystem} onChange={setDbSystem}
          placeholder="All databases"
          options={[{ value: '', label: 'All databases' }, ...systems.map(s => ({ value: s, label: s }))]} />
        <Select size="sm" icon={Clock} className="w-32" value={timeRange} onChange={setTimeRange}
          options={[
            { value: '', label: 'All time' }, { value: '1h', label: 'Last 1h' },
            { value: '6h', label: 'Last 6h' }, { value: '24h', label: 'Last 24h' }, { value: '7d', label: 'Last 7d' },
          ]} />
        <Select size="sm" className="w-40" value={sortBy} onChange={setSortBy}
          options={[
            { value: 'total', label: 'Sort: total time' },
            { value: 'avg', label: 'Sort: avg time' },
            { value: 'max', label: 'Sort: slowest' },
            { value: 'count', label: 'Sort: executions' },
            { value: 'last', label: 'Sort: most recent' },
          ]} />
        <div className="relative flex-1 min-w-[160px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search statement text…"
            className="w-full pl-8 pr-7 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500" />
          {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"><X className="w-3.5 h-3.5" /></button>}
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-slate-500 whitespace-nowrap">Min</label>
          <div className="relative">
            <input type="number" min="0" value={minMs} onChange={e => setMinMs(e.target.value)} placeholder="0"
              className="w-20 pl-2 pr-7 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-slate-500" />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-500">ms</span>
          </div>
        </div>
        <button
          onClick={() => setByService(v => !v)}
          title="Group identical statements separately per service"
          className={clsx('inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors',
            byService ? 'border-blue-500/50 bg-blue-500/15 text-blue-300' : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200')}>
          <Server className="w-3.5 h-3.5" /> By service
        </button>
      </div>

      {/* Stats strip */}
      <div className="shrink-0 grid grid-cols-2 sm:grid-cols-4 divide-x divide-slate-800/60 border-b border-slate-800 bg-slate-950/40">
        {[
          { icon: Database, tone: 'text-blue-400', val: totals.queries.toLocaleString(), label: 'Distinct queries' },
          { icon: Layers, tone: 'text-violet-400', val: totals.executions.toLocaleString(), label: 'Executions' },
          { icon: Clock, tone: 'text-emerald-400', val: fmtMsNum(totals.total_ms), label: 'Total DB time' },
          { icon: AlertOctagon, tone: 'text-amber-400', val: fmtMsNum(totals.slowest_ms), label: 'Slowest query' },
        ].map(c => (
          <div key={c.label} className="px-4 py-2 flex items-center gap-2.5">
            <c.icon className={clsx('w-4 h-4 shrink-0', c.tone)} />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-200 tabular-nums leading-none">{c.val}</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">{c.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto min-h-0">
        {loading ? (
          <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-9 rounded-lg bg-slate-800/30 animate-pulse" style={{ opacity: 1 - i * 0.1 }} />)}</div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-6">
            <div className="w-12 h-12 rounded-xl bg-slate-800/60 border border-slate-700 flex items-center justify-center mb-4">
              <Database className="w-6 h-6 text-slate-600" />
            </div>
            <p className="text-sm font-medium text-slate-400 mb-1">No database queries captured</p>
            <p className="text-xs text-slate-600 max-w-md">
              Database statements appear when an app is deployed with OpenTelemetry enabled and its instrumentation
              emits <span className="font-mono">db.statement</span> spans (Java, .NET, Node, Python auto-instrumentation).
            </p>
          </div>
        ) : (
          <table className="w-full min-w-[860px]">
            <thead className="sticky top-0 bg-slate-900/80 backdrop-blur z-10">
              <tr className="border-b border-slate-800 text-[9px] uppercase tracking-wider text-slate-600">
                <th className="w-6" />
                <th className="px-3 py-2 text-left font-semibold">Op</th>
                <th className="px-3 py-2 text-left font-semibold">Statement</th>
                <th className="px-3 py-2 text-left font-semibold">Database</th>
                <th className="px-3 py-2 text-right font-semibold">Count</th>
                <th className="px-3 py-2 text-right font-semibold">Avg</th>
                <th className="px-3 py-2 text-right font-semibold">Max</th>
                <th className="px-3 py-2 text-right font-semibold">Total</th>
                <th className="px-3 py-2 text-right font-semibold">Err</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q, i) => <DbQueryRow key={q.db_system + q.normalized + i} q={q} />)}
            </tbody>
          </table>
        )}
      </div>

      {!loading && total > 0 && (
        <div className="shrink-0 border-t border-slate-800/50 bg-slate-950/40">
          <Pagination total={total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} itemLabel="query" />
        </div>
      )}
    </div>
  )
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function OTelTracesPage() {
  const [status, setStatus] = useState<OTelStatus | null>(null)
  const [services, setServices] = useState<OTelServiceStat[]>([])
  const [operations, setOperations] = useState<OTelOperationInfo[]>([])
  const [traces, setTraces] = useState<OTelTrace[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [view, setView] = useState<'traces' | 'database'>('traces')

  const [selectedService, setSelectedService] = useState('')
  const [selectedOp, setSelectedOp] = useState('')
  const [pageSize, setPageSize] = useState(25)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [minDurationMs, setMinDurationMs] = useState('')
  const [timeRange, setTimeRange] = useState('')
  const [spanKind, setSpanKind] = useState('')
  const [attrKey, setAttrKey] = useState('')
  const [attrVal, setAttrVal] = useState('')

  const loadRef = useRef(0)

  type Filters = {
    svc: string; op: string; lim: number; off: number; srch: string; stat: string
    minDur: string; tRange: string; kind: string; aKey: string; aVal: string
  }
  const filters: Filters = {
    svc: selectedService, op: selectedOp, lim: pageSize, off: page * pageSize, srch: search, stat: statusFilter,
    minDur: minDurationMs, tRange: timeRange, kind: spanKind, aKey: attrKey, aVal: attrVal,
  }

  const loadTraces = useCallback(async (f: Filters, isRefresh = false) => {
    const id = ++loadRef.current
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const res = await api.otelTraces({
        service: f.svc || undefined,
        operation: f.op || undefined,
        limit: f.lim,
        offset: f.off || undefined,
        search: f.srch || undefined,
        status: f.stat || undefined,
        min_duration_ms: f.minDur ? Number(f.minDur) : undefined,
        time_range: f.tRange || undefined,
        span_kind: f.kind || undefined,
        attr_key: f.aKey || undefined,
        attr_val: f.aVal || undefined,
      })
      if (id === loadRef.current) { setTraces(res.data ?? []); setTotal(res.total ?? 0) }
    } catch {
      if (id === loadRef.current) { setTraces([]); setTotal(0) }
    } finally {
      if (id === loadRef.current) { setLoading(false); setRefreshing(false) }
    }
  }, [])

  // Initial load
  useEffect(() => {
    api.otelStatus().then(setStatus).catch(() => setStatus({ available: false }))
    api.otelServiceStats().then(r => setServices(r.data ?? [])).catch(() => {})
  }, []) // eslint-disable-line

  // Service change → load operations
  useEffect(() => {
    if (!selectedService) { setOperations([]); setSelectedOp(''); return }
    api.otelOperations(selectedService).then(r => setOperations(r.data ?? [])).catch(() => {})
    setSelectedOp('')
  }, [selectedService])

  // Any filter change → reset to first page.
  useEffect(() => {
    setPage(0)
  }, [selectedService, selectedOp, pageSize, search, statusFilter, minDurationMs, timeRange, spanKind, attrKey, attrVal])

  // Filter/page change (debounced for text inputs)
  useEffect(() => {
    const t = setTimeout(() => loadTraces(filters), 250)
    return () => clearTimeout(t)
  }, [selectedService, selectedOp, pageSize, page, search, statusFilter, minDurationMs, timeRange, spanKind, attrKey, attrVal]) // eslint-disable-line

  const refresh = () => loadTraces(filters, true)
  const resetFilters = () => {
    setSelectedService(''); setSelectedOp(''); setSearch(''); setStatusFilter('')
    setMinDurationMs(''); setTimeRange(''); setSpanKind(''); setAttrKey(''); setAttrVal('')
  }

  const clearAll = async () => {
    setConfirmClear(false)
    setClearing(true)
    try { await api.otelDeleteTraces(); setTraces([]); setTotal(0); setStatus(s => s ? { ...s, span_count: 0 } : s) }
    catch { /* ignore */ } finally { setClearing(false) }
  }

  const hasFilters = !!(selectedService || selectedOp || search || statusFilter || minDurationMs || timeRange || spanKind || (attrKey && attrKey.trim()))
  const errorCount = traces.filter(traceHasError).length

  // Active-filter chips for at-a-glance visibility + one-click removal.
  const chips: Array<{ label: string; clear: () => void }> = []
  if (selectedService) chips.push({ label: `service: ${selectedService}`, clear: () => setSelectedService('') })
  if (selectedOp) chips.push({ label: `op: ${selectedOp}`, clear: () => setSelectedOp('') })
  if (timeRange) chips.push({ label: `time: ${timeRange}`, clear: () => setTimeRange('') })
  if (statusFilter) chips.push({ label: 'errors only', clear: () => setStatusFilter('') })
  if (spanKind) chips.push({ label: `kind: ${spanKind}`, clear: () => setSpanKind('') })
  if (minDurationMs) chips.push({ label: `≥ ${minDurationMs}ms`, clear: () => setMinDurationMs('') })
  if (search) chips.push({ label: `“${search}”`, clear: () => setSearch('') })
  if (attrKey && attrKey.trim()) chips.push({ label: `${attrKey}${attrVal ? `=${attrVal}` : ''}`, clear: () => { setAttrKey(''); setAttrVal('') } })

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Header: title + view tabs */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-slate-800 bg-slate-950/40">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-blue-500/10 border border-blue-500/30 flex items-center justify-center">
            <Activity className="w-4 h-4 text-blue-400" />
          </div>
          <span className="text-sm font-semibold text-slate-200">App Traces</span>
        </div>
        <div className="flex items-center gap-1 p-0.5 bg-slate-900 border border-slate-800 rounded-lg">
          {([['traces', 'Traces', GitBranch], ['database', 'Database', Database]] as const).map(([id, label, Ico]) => (
            <button key={id} onClick={() => setView(id)}
              className={clsx('inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all',
                view === id ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200')}>
              <Ico className="w-3.5 h-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>

      {view === 'database' ? <DatabaseView /> : (
      <>
      {/* Toolbar — row 1: primary filters */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-800 bg-slate-900/30">

        {/* Service filter */}
        <Select
          size="sm" icon={Server} className="w-40"
          value={selectedService}
          onChange={setSelectedService}
          placeholder="All services"
          options={[
            { value: '', label: 'All services', hint: `${services.reduce((a, s) => a + s.spans, 0)} spans` },
            ...services.map(s => ({ value: s.name, label: s.name, hint: s.errors > 0 ? `${s.spans} · ${s.errors} err` : `${s.spans} spans` })),
          ]}
        />

        {/* Operation filter */}
        {operations.length > 0 && (
          <Select
            size="sm" icon={GitBranch} className="w-56"
            value={selectedOp}
            onChange={setSelectedOp}
            placeholder="All operations"
            options={[
              { value: '', label: 'All operations' },
              ...operations.map(o => ({
                value: o.name,
                label: o.name,
                hint: `${o.count}× · ${o.avg_ms >= 1 ? o.avg_ms.toFixed(0) + 'ms' : '<1ms'}${o.errors > 0 ? ' · ' + o.errors + ' err' : ''}`,
              })),
            ]}
          />
        )}

        {/* Time range */}
        <Select
          size="sm" icon={Clock} className="w-32"
          value={timeRange}
          onChange={setTimeRange}
          options={[
            { value: '', label: 'All time' },
            { value: '1h', label: 'Last 1h' },
            { value: '6h', label: 'Last 6h' },
            { value: '24h', label: 'Last 24h' },
            { value: '7d', label: 'Last 7d' },
          ]}
        />

        {/* Status */}
        <Select
          size="sm" className="w-28"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: '', label: 'All status' },
            { value: 'error', label: 'Errors only' },
          ]}
        />

        {/* Span kind */}
        <Select
          size="sm" className="w-28"
          value={spanKind}
          onChange={setSpanKind}
          options={[
            { value: '', label: 'All kinds' },
            { value: 'server', label: 'Server' },
            { value: 'client', label: 'Client' },
            { value: 'producer', label: 'Producer' },
            { value: 'consumer', label: 'Consumer' },
            { value: 'internal', label: 'Internal' },
          ]}
        />

        <div className="ml-auto flex items-center gap-1">
          {traces.length > 0 && (
            <button onClick={() => setConfirmClear(true)} disabled={clearing}
              title="Clear all traces"
              className="p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-red-400 transition-colors">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={refresh} disabled={refreshing}
            className="p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-slate-300 transition-colors">
            <RefreshCw className={clsx('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="shrink-0 grid grid-cols-3 divide-x divide-slate-800/60 border-b border-slate-800 bg-slate-950/40">
        <div className="px-4 py-2 flex items-center gap-2.5">
          <Boxes className="w-4 h-4 text-blue-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-200 tabular-nums leading-none">{total.toLocaleString()}</div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">Matching traces</div>
          </div>
        </div>
        <div className="px-4 py-2 flex items-center gap-2.5">
          <AlertOctagon className={clsx('w-4 h-4 shrink-0', errorCount > 0 ? 'text-red-400' : 'text-slate-600')} />
          <div className="min-w-0">
            <div className={clsx('text-sm font-semibold tabular-nums leading-none', errorCount > 0 ? 'text-red-300' : 'text-slate-200')}>{errorCount}</div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">Errors on page</div>
          </div>
        </div>
        <div className="px-4 py-2 flex items-center gap-2.5">
          <Layers className="w-4 h-4 text-violet-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-200 tabular-nums leading-none">{(status?.span_count ?? 0).toLocaleString()}</div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">Spans stored</div>
          </div>
        </div>
      </div>

      {/* Toolbar — row 2: full-text search + span-attribute filter + min duration */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-b border-slate-800/60 bg-slate-900/10">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search spans, services, attributes…"
            className="w-full pl-8 pr-7 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500 transition-colors"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Span attribute filter: key [= value] (e.g. http.status_code = 500) */}
        <div className="flex items-center gap-1" title="Keep traces with a span whose attribute matches (value optional, substring)">
          <input
            value={attrKey}
            onChange={e => setAttrKey(e.target.value)}
            placeholder="attribute key"
            list="otel-attr-keys"
            className="w-36 px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500 font-mono"
          />
          <datalist id="otel-attr-keys">
            {['http.status_code','http.method','http.route','http.target','db.system','db.statement','db.operation','db.name','rpc.method','rpc.service','messaging.system','net.peer.name','error'].map(k => <option key={k} value={k} />)}
          </datalist>
          <span className="text-slate-600 text-xs">=</span>
          <input
            value={attrVal}
            onChange={e => setAttrVal(e.target.value)}
            placeholder="value"
            disabled={!attrKey}
            className="w-24 px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500 font-mono disabled:opacity-40"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-slate-500 whitespace-nowrap">Min duration</label>
          <div className="relative">
            <input
              type="number"
              min="0"
              value={minDurationMs}
              onChange={e => setMinDurationMs(e.target.value)}
              placeholder="0"
              className="w-20 pl-2 pr-7 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-slate-500 transition-colors"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-500">ms</span>
          </div>
        </div>
      </div>

      {/* Active-filter chips */}
      {chips.length > 0 && (
        <div className="shrink-0 flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-slate-800/40 bg-slate-900/5">
          <span className="text-[10px] text-slate-600 uppercase tracking-wider font-semibold mr-1">Filters</span>
          {chips.map((c, i) => (
            <button key={i} onClick={c.clear}
              className="inline-flex items-center gap-1 pl-2 pr-1.5 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/25 text-blue-300 text-[11px] hover:bg-blue-500/20 transition-colors">
              {c.label}
              <X className="w-3 h-3 opacity-70" />
            </button>
          ))}
          <button onClick={resetFilters}
            className="ml-1 text-[11px] text-slate-500 hover:text-slate-300 flex items-center gap-1 transition-colors">
            Clear all
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Status warning */}
        {status && !status.available && (
          <div className="mx-4 mt-4 p-4 rounded-xl border border-amber-500/30 bg-amber-500/5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-amber-300 mb-1">OpenTelemetry not configured</p>
                <p className="text-xs text-slate-400 mb-3">
                  Enable it in your project's <strong className="text-slate-200">Deploy Settings → Enable OpenTelemetry tracing</strong>, then
                  deploy your app. Jaeger starts automatically during installation.
                </p>
                <IntegrationGuide />
              </div>
            </div>
          </div>
        )}

        {/* Table header */}
        {!loading && traces.length > 0 && (
          <div className="flex items-center gap-3 px-4 py-2 bg-slate-900/50 border-b border-slate-800/50 sticky top-0 z-10">
            <span className="w-3.5 shrink-0" />
            <span className="text-[9px] text-slate-600 uppercase tracking-wider font-semibold w-[120px] shrink-0">Service</span>
            <span className="text-[9px] text-slate-600 uppercase tracking-wider font-semibold flex-1">Operation</span>
            <span className="text-[9px] text-slate-600 uppercase tracking-wider font-semibold w-16 text-right shrink-0">Duration</span>
            <span className="text-[9px] text-slate-600 uppercase tracking-wider font-semibold w-16 shrink-0">Spans</span>
            <span className="text-[9px] text-slate-600 uppercase tracking-wider font-semibold w-12 shrink-0">Status</span>
            <span className="text-[9px] text-slate-600 uppercase tracking-wider font-semibold w-16 text-right shrink-0">When</span>
          </div>
        )}

        {/* Trace list */}
        {loading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-10 rounded-lg bg-slate-800/30 animate-pulse" style={{ opacity: 1 - i * 0.1 }} />
            ))}
          </div>
        ) : traces.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-6">
            <div className="w-12 h-12 rounded-xl bg-slate-800/60 border border-slate-700 flex items-center justify-center mb-4">
              <GitBranch className="w-6 h-6 text-slate-600" />
            </div>
            <p className="text-sm font-medium text-slate-400 mb-1">{hasFilters ? 'No traces match your filters' : 'No traces found'}</p>
            <p className="text-xs text-slate-600 max-w-sm">
              {hasFilters
                ? 'Try widening the time range or clearing some filters.'
                : 'Deploy an app with OpenTelemetry enabled, then trigger some requests. Traces appear here within seconds.'}
            </p>
            {hasFilters && (
              <button onClick={resetFilters} className="mt-3 text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                <X className="w-3 h-3" /> Clear all filters
              </button>
            )}
          </div>
        ) : (
          <div>
            {traces.map((trace, idx) => (
              <TraceRow key={trace.traceID} trace={trace} idx={idx} />
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {!loading && total > 0 && (
        <div className="shrink-0 border-t border-slate-800/50 bg-slate-950/40">
          <Pagination
            total={total}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            itemLabel="trace"
          />
        </div>
      )}

      {/* Footer hint */}
      {!loading && traces.length > 0 && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-t border-slate-800/50 text-[10px] text-slate-600">
          <Layers className="w-3 h-3" />
          Click a row to expand the span waterfall · Click a span to see its tags
          <span className="ml-auto flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {status?.otlp_http && <span className="font-mono text-blue-500/60">{status.otlp_http}</span>}
          </span>
        </div>
      )}
      </>
      )}

      {confirmClear && (
        <ConfirmModal
          danger
          title="Delete all stored traces?"
          message="Every captured trace and span will be permanently removed. This cannot be undone."
          confirmLabel="Delete all traces"
          onConfirm={clearAll}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  )
}
