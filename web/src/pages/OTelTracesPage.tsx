import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Activity, AlertTriangle, ChevronDown, ChevronRight,
  RefreshCw, GitBranch, Clock, Layers, Trash2, Search, X,
} from 'lucide-react'
import {
  api, OTelSpan, OTelTrace, OTelStatus,
} from '../api/client'

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

function spanKind(span: OTelSpan): 'server' | 'client' | 'internal' | 'producer' | 'consumer' {
  const kind = span.tags.find(t => t.key === 'span.kind')?.value
  if (kind === 'server') return 'server'
  if (kind === 'client') return 'client'
  if (kind === 'producer') return 'producer'
  if (kind === 'consumer') return 'consumer'
  return 'internal'
}

// ─── Span detail row ─────────────────────────────────────────────────────────

interface SpanRowProps {
  node: SpanNode
  traceStart: number
  traceDuration: number
  colorIdx: number
}

function SpanRow({ node, traceStart, traceDuration, colorIdx }: SpanRowProps) {
  const [open, setOpen] = useState(false)
  const { span, depth, service } = node
  const isErr = hasError(span)
  const kind = spanKind(span)

  const barLeft = traceDuration > 0 ? ((span.startTime - traceStart) / traceDuration) * 100 : 0
  const barWidth = Math.max(
    traceDuration > 0 ? (span.duration / traceDuration) * 100 : 0,
    0.5,
  )

  const barGradient = isErr
    ? 'from-red-500/70 to-red-400/50'
    : kind === 'server' ? SPAN_BAR_COLORS[colorIdx % SPAN_BAR_COLORS.length]
    : kind === 'client' ? 'from-slate-400/50 to-slate-300/30'
    : 'from-slate-600/50 to-slate-500/30'

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

        {/* Left: service + operation */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <ServiceBadge name={service} small />
          <span className={clsx(
            'text-[11px] font-mono truncate',
            isErr ? 'text-red-300' : 'text-slate-200',
          )}>
            {span.operationName}
          </span>
          {isErr && (
            <span className="shrink-0 text-[9px] font-semibold text-red-400 bg-red-500/10 border border-red-500/20 rounded px-1 py-px">
              ERR
            </span>
          )}
        </div>

        {/* Waterfall bar column */}
        <div className="shrink-0 w-[180px] relative h-5 flex items-center">
          <div className="absolute inset-0 flex items-center">
            {/* Grid lines */}
            {[25, 50, 75].map(pct => (
              <div key={pct} className="absolute top-0 bottom-0 w-px bg-slate-700/30" style={{ left: `${pct}%` }} />
            ))}
            {/* Bar */}
            <div
              className={clsx(
                'absolute h-[10px] rounded-full bg-gradient-to-r',
                barGradient,
                'shadow-sm',
              )}
              style={{ left: `${Math.min(barLeft, 98)}%`, width: `${Math.min(barWidth, 100 - barLeft)}%` }}
            />
          </div>
        </div>

        {/* Duration */}
        <span className="shrink-0 text-[10px] font-mono text-slate-500 w-16 text-right">
          {fmtDuration(span.duration)}
        </span>
      </div>

      {/* Tags */}
      {open && span.tags.length > 0 && (
        <div className="mx-3 mb-2 ml-[calc(0.75rem+16px)] bg-slate-950/70 border border-slate-800 rounded-lg p-3 text-[10px] font-mono space-y-0.5">
          {span.tags.map((t, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-slate-500 shrink-0">{t.key}</span>
              <span className="text-slate-300 truncate">{String(t.value)}</span>
            </div>
          ))}
        </div>
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

  if (trace.spans.length === 0) return null
  const root = getRootSpan(trace)
  if (!root) return null
  const service = getServiceForSpan(root, trace)
  const isErr = traceHasError(trace)
  const colorIdx = serviceColorIdx(service)
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
          {/* Column header */}
          <div className="flex items-center gap-2 px-3 py-1 bg-slate-900/60 border-b border-slate-800/50">
            <div className="flex-1 text-[9px] text-slate-600 uppercase tracking-wider font-semibold">Operation</div>
            <div className="shrink-0 w-[180px] text-[9px] text-slate-600 uppercase tracking-wider font-semibold">Timeline</div>
            <div className="shrink-0 w-16 text-[9px] text-slate-600 uppercase tracking-wider font-semibold text-right">Duration</div>
          </div>
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
                  colorIdx={colorIdx}
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
# NODE_OPTIONS=--require /otel/node/tracer.js  ← set by OffDock`,
  },
  {
    id: 'php',
    label: 'PHP (auto)',
    code: `# Nothing needed — offdock-tracer.php auto_prepend_file is injected.
# Instruments every incoming HTTP request + outgoing curl calls.
# PHP_INI_SCAN_DIR=/otel/php  ← set by OffDock`,
  },
  {
    id: 'python',
    label: 'Python (auto)',
    code: `# Nothing needed — sitecustomize.py is injected automatically.
# Instruments outgoing HTTP calls via http.client
# (covers requests, urllib, urllib3, httpx, and most HTTP libraries).
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

// ─── Main page ───────────────────────────────────────────────────────────────

export default function OTelTracesPage() {
  const [status, setStatus] = useState<OTelStatus | null>(null)
  const [services, setServices] = useState<string[]>([])
  const [operations, setOperations] = useState<Array<{ name: string; spanKind: string }>>([])
  const [traces, setTraces] = useState<OTelTrace[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [clearing, setClearing] = useState(false)

  const [selectedService, setSelectedService] = useState('')
  const [selectedOp, setSelectedOp] = useState('')
  const [limit, setLimit] = useState(20)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [minDurationMs, setMinDurationMs] = useState('')
  const [timeRange, setTimeRange] = useState('')

  const loadRef = useRef(0)

  const loadTraces = useCallback(async (
    svc: string, op: string, lim: number,
    srch: string, stat: string, minDur: string, tRange: string,
    isRefresh = false,
  ) => {
    const id = ++loadRef.current
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const res = await api.otelTraces({
        service: svc || undefined,
        operation: op || undefined,
        limit: lim,
        search: srch || undefined,
        status: stat || undefined,
        min_duration_ms: minDur ? Number(minDur) : undefined,
        time_range: tRange || undefined,
      })
      if (id === loadRef.current) setTraces(res.data ?? [])
    } catch {
      if (id === loadRef.current) setTraces([])
    } finally {
      if (id === loadRef.current) { setLoading(false); setRefreshing(false) }
    }
  }, [])

  // Initial load
  useEffect(() => {
    api.otelStatus().then(setStatus).catch(() => setStatus({ available: false }))
    api.otelServices().then(r => setServices(r.data ?? [])).catch(() => {})
    loadTraces('', '', limit, '', '', '', '')
  }, []) // eslint-disable-line

  // Service change → load operations
  useEffect(() => {
    if (!selectedService) { setOperations([]); setSelectedOp(''); return }
    api.otelOperations(selectedService).then(r => setOperations(r.data ?? [])).catch(() => {})
    setSelectedOp('')
  }, [selectedService])

  // Filter/limit change
  useEffect(() => {
    loadTraces(selectedService, selectedOp, limit, search, statusFilter, minDurationMs, timeRange)
  }, [selectedService, selectedOp, limit, search, statusFilter, minDurationMs, timeRange]) // eslint-disable-line

  const refresh = () => loadTraces(selectedService, selectedOp, limit, search, statusFilter, minDurationMs, timeRange, true)

  const clearAll = async () => {
    if (!confirm('Delete all stored traces? This cannot be undone.')) return
    setClearing(true)
    try { await api.otelDeleteTraces(); setTraces([]); setStatus(s => s ? { ...s, span_count: 0 } : s) }
    catch { /* ignore */ } finally { setClearing(false) }
  }

  const inputCls = 'bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-slate-500 transition-colors'
  const hasFilters = search || statusFilter || minDurationMs || timeRange

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Toolbar — row 1: title + primary filters */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-800 bg-slate-900/30">
        <Activity className="w-4 h-4 text-blue-400 shrink-0" />
        <span className="text-sm font-semibold text-slate-200 mr-1">App Traces</span>

        {/* Service filter */}
        <select value={selectedService} onChange={e => setSelectedService(e.target.value)} className={inputCls}>
          <option value="">All services</option>
          {services.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        {/* Operation filter */}
        {operations.length > 0 && (
          <select value={selectedOp} onChange={e => setSelectedOp(e.target.value)} className={inputCls}>
            <option value="">All operations</option>
            {operations.map(o => <option key={o.name} value={o.name}>{o.name}</option>)}
          </select>
        )}

        {/* Time range */}
        <select value={timeRange} onChange={e => setTimeRange(e.target.value)} className={inputCls}>
          <option value="">All time</option>
          <option value="1h">Last 1h</option>
          <option value="6h">Last 6h</option>
          <option value="24h">Last 24h</option>
          <option value="7d">Last 7d</option>
        </select>

        {/* Status */}
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={inputCls}>
          <option value="">All status</option>
          <option value="error">Errors only</option>
        </select>

        {/* Limit */}
        <select value={limit} onChange={e => setLimit(Number(e.target.value))} className={inputCls}>
          <option value={20}>20 traces</option>
          <option value={50}>50 traces</option>
          <option value={100}>100 traces</option>
        </select>

        <div className="ml-auto flex items-center gap-2">
          {status?.span_count !== undefined && (
            <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">
              {status.span_count.toLocaleString()} spans stored
            </span>
          )}
          {traces.length > 0 && (
            <button onClick={clearAll} disabled={clearing}
              title="Clear all traces"
              className="p-1.5 rounded hover:bg-slate-800 text-slate-700 hover:text-red-400 transition-colors">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={refresh} disabled={refreshing}
            className="p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-slate-300 transition-colors">
            <RefreshCw className={clsx('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Toolbar — row 2: search + min duration */}
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

        {hasFilters && (
          <button
            onClick={() => { setSearch(''); setStatusFilter(''); setMinDurationMs(''); setTimeRange('') }}
            className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1 transition-colors">
            <X className="w-3 h-3" /> Clear filters
          </button>
        )}
      </div>

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
            <p className="text-sm font-medium text-slate-400 mb-1">No traces found</p>
            <p className="text-xs text-slate-600 max-w-sm">
              Deploy an app with OpenTelemetry enabled, then trigger some requests. Traces appear here within seconds.
            </p>
          </div>
        ) : (
          <div>
            {traces.map((trace, idx) => (
              <TraceRow key={trace.traceID} trace={trace} idx={idx} />
            ))}
          </div>
        )}
      </div>

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
    </div>
  )
}
