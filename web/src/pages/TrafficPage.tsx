import { useEffect, useMemo, useRef, useState } from 'react'
import { api, TrafficReport, TrafficBucket, TrafficCount, TrafficEntry, HostStat, ConnectionsReport } from '../api/client'
import { Page, PageHeader, Panel, StatCard, EmptyState, Tabs } from '../components/ui'
import { formatBytes } from '../lib/format'
import clsx from 'clsx'
import {
  Activity, RefreshCw, Globe, AlertTriangle, Network, Gauge, ArrowDownToLine,
  ChevronDown, Users, Search, X, Clock, Zap, Server, Wifi, Monitor,
} from 'lucide-react'

type TabId = 'overview' | 'hosts' | 'response' | 'requests' | 'connections'

const WINDOWS = [
  { label: '1h', hours: 1 }, { label: '6h', hours: 6 },
  { label: '24h', hours: 24 }, { label: '7d', hours: 168 },
]

function fmtMs(ms: number) {
  if (!ms || ms === 0) return '—'
  if (ms >= 1000) return (ms / 1000).toFixed(2) + 's'
  return ms.toFixed(1) + 'ms'
}

// ─── Sparkline area chart ─────────────────────────────────────────────────────
function AreaChart({ series, height = 180 }: { series: TrafficBucket[]; height?: number }) {
  const W = 800, H = height, P = 4
  if (series.length < 2) return (
    <div className="flex items-center justify-center text-sm text-slate-600" style={{ height }}>
      Not enough data
    </div>
  )
  const maxCount = Math.max(...series.map(b => b.count), 1)
  const stepX = (W - P * 2) / (series.length - 1)
  const x = (i: number) => P + i * stepX
  const y = (v: number, max: number) => H - P - (v / max) * (H - P * 2)
  const countLine = series.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(b.count, maxCount).toFixed(1)}`).join(' ')
  const errLine = series.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(b.err, maxCount).toFixed(1)}`).join(' ')
  const area = `${countLine} L${x(series.length - 1).toFixed(1)},${H - P} L${x(0).toFixed(1)},${H - P} Z`
  const fmtT = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="p-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} preserveAspectRatio="none">
        <defs>
          <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map(f => (
          <line key={f} x1={P} y1={H * f} x2={W - P} y2={H * f} stroke="#1e293b" strokeWidth="1" />
        ))}
        <path d={area} fill="url(#ag)" />
        <path d={countLine} fill="none" stroke="#3b82f6" strokeWidth="2" />
        <path d={errLine} fill="none" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.7" />
      </svg>
      <div className="flex items-center justify-between mt-1 text-[10px] text-slate-600 px-1">
        <span>{fmtT(series[0].t)}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-blue-500 rounded" /> requests</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-red-500 rounded" /> errors</span>
          <span>peak {maxCount.toLocaleString()}</span>
        </span>
        <span>{fmtT(series[series.length - 1].t)}</span>
      </div>
    </div>
  )
}

// ─── Response time chart ──────────────────────────────────────────────────────
function ResponseTimeChart({ series }: { series: TrafficBucket[] }) {
  const with_ms = series.filter(b => b.avg_ms > 0)
  if (with_ms.length < 2) return (
    <div className="flex items-center justify-center text-sm text-slate-600 h-44">
      No response time data yet — requires the offdock_main nginx log format
    </div>
  )
  const W = 800, H = 160, P = 4
  const maxMs = Math.max(...with_ms.map(b => b.avg_ms), 1)
  const stepX = (W - P * 2) / (with_ms.length - 1)
  const x = (i: number) => P + i * stepX
  const y = (v: number) => H - P - (v / maxMs) * (H - P * 2)
  const line = with_ms.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(b.avg_ms).toFixed(1)}`).join(' ')
  const area = `${line} L${x(with_ms.length - 1).toFixed(1)},${H - P} L${x(0).toFixed(1)},${H - P} Z`
  const fmtT = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="p-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 160 }} preserveAspectRatio="none">
        <defs>
          <linearGradient id="rtg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map(f => (
          <line key={f} x1={P} y1={H * f} x2={W - P} y2={H * f} stroke="#1e293b" strokeWidth="1" />
        ))}
        <path d={area} fill="url(#rtg)" />
        <path d={line} fill="none" stroke="#8b5cf6" strokeWidth="2" />
      </svg>
      <div className="flex items-center justify-between mt-1 text-[10px] text-slate-600 px-1">
        <span>{fmtT(with_ms[0].t)}</span>
        <span>peak {fmtMs(maxMs)}</span>
        <span>{fmtT(with_ms[with_ms.length - 1].t)}</span>
      </div>
    </div>
  )
}

// ─── Status donut ─────────────────────────────────────────────────────────────
function StatusDonut({ s }: { s: TrafficReport['summary'] }) {
  const parts = [
    { label: '2xx', value: s.status_2xx, color: '#10b981' },
    { label: '3xx', value: s.status_3xx, color: '#3b82f6' },
    { label: '4xx', value: s.status_4xx, color: '#f59e0b' },
    { label: '5xx', value: s.status_5xx, color: '#ef4444' },
  ]
  const total = parts.reduce((a, p) => a + p.value, 0) || 1
  const R = 52, C = 2 * Math.PI * R
  let offset = 0
  return (
    <div className="p-4 flex items-center gap-5">
      <svg viewBox="0 0 130 130" className="w-32 h-32 shrink-0 -rotate-90">
        <circle cx="65" cy="65" r={R} fill="none" stroke="#1e293b" strokeWidth="14" />
        {parts.map(p => {
          const len = (p.value / total) * C
          const el = (
            <circle key={p.label} cx="65" cy="65" r={R} fill="none" stroke={p.color}
              strokeWidth="14" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />
          )
          offset += len
          return el
        })}
      </svg>
      <div className="space-y-1.5 flex-1">
        {parts.map(p => (
          <div key={p.label} className="flex items-center gap-2 text-sm">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: p.color }} />
            <span className="text-slate-300 w-9">{p.label}</span>
            <span className="text-slate-500 tabular-nums flex-1 text-right">{p.value.toLocaleString()}</span>
            <span className="text-slate-600 tabular-nums w-12 text-right">{((p.value / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Bar list ─────────────────────────────────────────────────────────────────
function BarList({ items, color = 'bg-blue-500', valueLabel }: {
  items: TrafficCount[]; color?: string; valueLabel?: (v: number) => string
}) {
  const max = Math.max(...items.map(i => i.count), 1)
  if (!items.length) return <p className="text-sm text-slate-600 text-center py-6">No data</p>
  const fmt = valueLabel ?? ((v: number) => v.toLocaleString())
  return (
    <div className="p-3 space-y-1">
      {items.map(it => (
        <div key={it.key} className="relative flex items-center gap-2 px-2 py-1.5 rounded-lg overflow-hidden group">
          <div className={clsx('absolute inset-y-0 left-0 rounded-lg opacity-10 group-hover:opacity-20 transition-opacity', color)}
            style={{ width: `${(it.count / max) * 100}%` }} />
          <span className="relative font-mono text-xs text-slate-300 truncate flex-1" title={it.key}>{it.key}</span>
          <span className="relative tabular-nums text-xs text-slate-400 shrink-0">{fmt(it.count)}</span>
        </div>
      ))}
    </div>
  )
}

function statusColor(s: number) {
  if (s >= 500) return 'text-red-400 bg-red-500/10'
  if (s >= 400) return 'text-amber-400 bg-amber-500/10'
  if (s >= 300) return 'text-blue-400 bg-blue-500/10'
  return 'text-emerald-400 bg-emerald-500/10'
}

function methodColor(m: string) {
  switch (m) {
    case 'GET': return 'text-emerald-400 bg-emerald-500/10'
    case 'POST': return 'text-blue-400 bg-blue-500/10'
    case 'PUT': case 'PATCH': return 'text-amber-400 bg-amber-500/10'
    case 'DELETE': return 'text-red-400 bg-red-500/10'
    default: return 'text-slate-400 bg-slate-800'
  }
}

// ─── Request row ──────────────────────────────────────────────────────────────
function RequestRow({ e }: { e: TrafficEntry }) {
  const t = new Date(e.time)
  const timeStr = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <tr className="border-b border-slate-800/40 hover:bg-slate-800/20 transition-colors">
      <td className="px-3 py-2 text-xs text-slate-600 tabular-nums whitespace-nowrap">{timeStr}</td>
      <td className="px-3 py-2">
        <span className={clsx('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold', methodColor(e.method))}>
          {e.method}
        </span>
      </td>
      <td className="px-3 py-2 font-mono text-xs text-slate-300 max-w-xs truncate" title={e.path}>{e.path}</td>
      <td className="px-3 py-2">
        <span className={clsx('inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold tabular-nums', statusColor(e.status))}>
          {e.status}
        </span>
      </td>
      <td className="px-3 py-2 text-xs text-slate-500 font-mono">{e.host || '—'}</td>
      <td className="px-3 py-2 text-xs text-slate-600 font-mono">{e.ip}</td>
      <td className="px-3 py-2 text-xs text-slate-600 max-w-[160px] truncate" title={e.user_agent || ''}>{e.user_agent || '—'}</td>
      <td className="px-3 py-2 text-xs text-slate-600 tabular-nums text-right">{formatBytes(e.bytes)}</td>
      {e.response_ms > 0 && (
        <td className={clsx('px-3 py-2 text-xs tabular-nums text-right', e.response_ms > 1000 ? 'text-red-400' : e.response_ms > 500 ? 'text-amber-400' : 'text-slate-500')}>
          {fmtMs(e.response_ms)}
        </td>
      )}
    </tr>
  )
}

// ─── Host stats table ─────────────────────────────────────────────────────────
function HostTable({ stats }: { stats: HostStat[] }) {
  if (!stats.length) return <EmptyState icon={Globe} title="No per-host data" description="Enable access log on proxy hosts to see per-host breakdown." />
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-xs text-slate-500 uppercase tracking-wider">
            <th className="px-4 py-3 text-left font-medium">Host</th>
            <th className="px-4 py-3 text-right font-medium">Requests</th>
            <th className="px-4 py-3 text-right font-medium">Bandwidth</th>
            <th className="px-4 py-3 text-right font-medium">Errors</th>
            <th className="px-4 py-3 text-right font-medium">Error Rate</th>
            <th className="px-4 py-3 text-right font-medium">Avg Response</th>
            <th className="px-4 py-3 text-right font-medium">P95</th>
          </tr>
        </thead>
        <tbody>
          {stats.map(h => (
            <tr key={h.host} className="border-b border-slate-800/40 hover:bg-slate-800/20 transition-colors">
              <td className="px-4 py-3 font-mono text-xs text-blue-300">{h.host}</td>
              <td className="px-4 py-3 text-right tabular-nums text-slate-300">{h.total.toLocaleString()}</td>
              <td className="px-4 py-3 text-right tabular-nums text-slate-500">{formatBytes(h.bytes)}</td>
              <td className="px-4 py-3 text-right tabular-nums text-slate-500">{h.errors.toLocaleString()}</td>
              <td className="px-4 py-3 text-right tabular-nums">
                <span className={clsx('text-xs font-medium', h.error_rate > 5 ? 'text-red-400' : h.error_rate > 1 ? 'text-amber-400' : 'text-emerald-400')}>
                  {h.error_rate.toFixed(1)}%
                </span>
              </td>
              <td className={clsx('px-4 py-3 text-right tabular-nums text-xs', h.avg_ms > 1000 ? 'text-red-400' : h.avg_ms > 0 ? 'text-slate-400' : 'text-slate-700')}>
                {fmtMs(h.avg_ms)}
              </td>
              <td className={clsx('px-4 py-3 text-right tabular-nums text-xs', h.p95_ms > 2000 ? 'text-red-400' : h.p95_ms > 0 ? 'text-slate-500' : 'text-slate-700')}>
                {fmtMs(h.p95_ms)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function TrafficPage() {
  const [tab, setTab] = useState<TabId>('overview')
  const [hours, setHours] = useState(24)
  const [host, setHost] = useState('')
  const [report, setReport] = useState<TrafficReport | null>(null)
  const [connections, setConnections] = useState<ConnectionsReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [hostOpen, setHostOpen] = useState(false)
  const [fSearch, setFSearch] = useState('')
  const [fStatus, setFStatus] = useState<'all' | '2xx' | '3xx' | '4xx' | '5xx'>('all')
  const [fMethod, setFMethod] = useState('all')
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = async () => {
    try {
      const [r] = await Promise.all([api.traffic(hours, host || undefined)])
      setReport(r)
    } catch { } finally { setLoading(false) }
  }

  const loadConnections = async () => {
    try { setConnections(await api.trafficConnections()) } catch { }
  }

  useEffect(() => {
    setLoading(true); load()
    timer.current = setInterval(load, 15000)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [hours, host]) // eslint-disable-line

  useEffect(() => {
    if (tab === 'connections') loadConnections()
  }, [tab]) // eslint-disable-line

  const s = report?.summary
  const errRate = s && s.total > 0 ? ((s.status_4xx + s.status_5xx) / s.total) * 100 : 0
  const hasData = (s?.total ?? 0) > 0
  const availableHosts = report?.hosts ?? []

  const feedMethods = useMemo(() => {
    const set = new Set<string>()
    for (const e of report?.recent ?? []) set.add(e.method)
    return Array.from(set).sort()
  }, [report])

  const filteredRecent = useMemo(() => {
    const q = fSearch.trim().toLowerCase()
    return (report?.recent ?? []).filter(e => {
      if (fMethod !== 'all' && e.method !== fMethod) return false
      if (fStatus !== 'all' && Math.floor(e.status / 100) !== Number(fStatus[0])) return false
      if (q && !e.path.toLowerCase().includes(q) && !e.ip.includes(q) && !e.host.toLowerCase().includes(q)) return false
      return true
    })
  }, [report, fSearch, fStatus, fMethod])

  const hasTimingData = (s?.avg_response_ms ?? 0) > 0

  return (
    <Page>
      <PageHeader
        title="Traffic"
        subtitle="nginx access-log analytics & request tracing"
        icon={Activity}
        actions={
          <div className="flex items-center gap-2">
            {/* Host filter */}
            <div className="relative">
              <button onClick={() => setHostOpen(o => !o)} className="btn-secondary gap-1.5">
                <Globe className="w-3.5 h-3.5" />
                <span className="max-w-[120px] truncate">{host || 'All hosts'}</span>
                <ChevronDown className="w-3 h-3" />
              </button>
              {hostOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setHostOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 z-20 w-56 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl py-1 max-h-72 overflow-y-auto animate-scaleIn">
                    <button onClick={() => { setHost(''); setHostOpen(false) }}
                      className={clsx('w-full text-left px-3 py-2 text-sm hover:bg-slate-800/60', !host && 'text-blue-400')}>
                      All hosts
                    </button>
                    {availableHosts.map(hh => (
                      <button key={hh} onClick={() => { setHost(hh); setHostOpen(false) }}
                        className={clsx('w-full text-left px-3 py-2 text-xs font-mono truncate hover:bg-slate-800/60', host === hh && 'text-blue-400')}>
                        {hh}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {/* Time window */}
            <div className="flex items-center gap-0.5 p-1 bg-slate-900 border border-slate-800 rounded-lg">
              {WINDOWS.map(w => (
                <button key={w.hours} onClick={() => setHours(w.hours)}
                  className={clsx('px-2.5 py-1 rounded-md text-xs font-medium transition-all',
                    hours === w.hours ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200')}>
                  {w.label}
                </button>
              ))}
            </div>
            <button onClick={() => { setLoading(true); load() }} className="btn-secondary p-2">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        }
      />

      <Tabs
        tabs={[
          { id: 'overview' as TabId, label: 'Overview', icon: Activity },
          { id: 'hosts' as TabId, label: 'By Host', icon: Globe },
          { id: 'response' as TabId, label: 'Response Times', icon: Clock },
          { id: 'requests' as TabId, label: 'Requests', icon: Search, count: report?.recent.length },
          { id: 'connections' as TabId, label: 'Connections', icon: Network },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div className="mt-4">
        {loading && !report ? (
          <div className="space-y-4 mt-4">
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
              {[0,1,2,3,4,5].map(i => <div key={i} className="h-24 skeleton rounded-xl" />)}
            </div>
            <div className="h-56 skeleton rounded-xl" />
          </div>
        ) : !hasData && tab !== 'connections' ? (
          <Panel className="mt-4">
            <EmptyState icon={Activity} title="No traffic in this window"
              description="Once requests hit your proxy hosts, metrics appear here. Make sure 'Access log' is enabled on proxy hosts." />
          </Panel>
        ) : (
          <>
            {/* ── OVERVIEW ── */}
            {tab === 'overview' && s && report && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
                  <StatCard label="Requests" value={s.total.toLocaleString()} icon={Activity} tone="blue" sublabel={`last ${s.window_hours}h`} />
                  <StatCard label="Req / sec" value={s.rps.toFixed(s.rps < 1 ? 2 : 1)} icon={Gauge} tone="violet" />
                  <StatCard label="Error rate" value={`${errRate.toFixed(1)}%`} icon={AlertTriangle}
                    tone={errRate > 5 ? 'red' : 'emerald'} sublabel={`${(s.status_4xx + s.status_5xx).toLocaleString()} errors`} />
                  <StatCard label="Bandwidth" value={formatBytes(s.bytes)} icon={ArrowDownToLine} tone="amber"
                    sublabel={s.avg_bytes_per_req > 0 ? `${formatBytes(s.avg_bytes_per_req)}/req avg` : undefined} />
                  <StatCard label="Unique IPs" value={s.unique_ips.toLocaleString()} icon={Users} tone="slate" />
                  <StatCard label="Avg Response" value={hasTimingData ? fmtMs(s.avg_response_ms) : '—'} icon={Clock}
                    tone={s.avg_response_ms > 1000 ? 'red' : s.avg_response_ms > 0 ? 'violet' : 'slate'} sublabel={hasTimingData ? `p95 ${fmtMs(s.p95_response_ms)}` : 'needs timing logs'} />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <Panel title="Requests over time" icon={Activity} className="lg:col-span-2">
                    <AreaChart series={report.series} />
                  </Panel>
                  <Panel title="Status codes" icon={Gauge}>
                    <StatusDonut s={s} />
                  </Panel>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <Panel title="Top paths" icon={Search}>
                    <BarList items={report.top_paths} color="bg-blue-500" />
                  </Panel>
                  <Panel title="Top clients" icon={Users}>
                    <BarList items={report.top_ips} color="bg-violet-500" />
                  </Panel>
                  <Panel title="By host" icon={Globe}>
                    <BarList items={report.by_host} color="bg-emerald-500" />
                  </Panel>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Panel title="HTTP methods" icon={Zap}>
                    <BarList items={report.methods} color="bg-amber-500" />
                  </Panel>
                  <Panel title="By upstream container" icon={Server}>
                    {report.by_upstream.length > 0
                      ? <BarList items={report.by_upstream} color="bg-cyan-500" />
                      : <EmptyState icon={Server} title="No upstream data"
                          description="Upstream info requires offdock_main log format with $upstream_addr." />
                    }
                  </Panel>
                </div>

                <Panel title="Top user agents" icon={Monitor}>
                  {report.top_user_agents.length > 0
                    ? <BarList items={report.top_user_agents} color="bg-indigo-500" />
                    : <EmptyState icon={Monitor} title="No user agent data" description="No requests with a User-Agent header in this window." />
                  }
                </Panel>
              </div>
            )}

            {/* ── HOSTS ── */}
            {tab === 'hosts' && report && (
              <Panel title="Per-host breakdown" icon={Globe}>
                <HostTable stats={report.host_stats} />
              </Panel>
            )}

            {/* ── RESPONSE TIMES ── */}
            {tab === 'response' && s && report && (
              <div className="space-y-4">
                {!hasTimingData && (
                  <div className="px-4 py-3 rounded-xl bg-amber-500/5 border border-amber-500/20 text-amber-300 text-sm flex items-center gap-2">
                    <Clock className="w-4 h-4 shrink-0" />
                    Response time data is only available with the <code className="font-mono text-xs bg-slate-800 px-1.5 py-0.5 rounded">offdock_main</code> nginx log format. New requests will include timing automatically.
                  </div>
                )}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                  <StatCard label="Avg Response Time" value={fmtMs(s.avg_response_ms)} icon={Clock} tone="violet" />
                  <StatCard label="P95 Response Time" value={fmtMs(s.p95_response_ms)} icon={Gauge}
                    tone={s.p95_response_ms > 2000 ? 'red' : s.p95_response_ms > 500 ? 'amber' : 'emerald'} />
                  <StatCard label="P99 Response Time" value={fmtMs(s.p99_response_ms)} icon={AlertTriangle}
                    tone={s.p99_response_ms > 5000 ? 'red' : 'slate'} />
                </div>

                <Panel title="Avg response time over time" icon={Clock}>
                  <ResponseTimeChart series={report.series} />
                </Panel>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Panel title="Slowest requests" icon={AlertTriangle}
                    actions={<span className="text-xs text-slate-600">{report.slow_requests.length} shown</span>}>
                    {report.slow_requests.length === 0 ? (
                      <EmptyState icon={Clock} title="No slow request data" description="Requires offdock_main log format." />
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-slate-800 text-slate-600">
                              <th className="px-3 py-2 text-left">Method</th>
                              <th className="px-3 py-2 text-left">Path</th>
                              <th className="px-3 py-2 text-left">Host</th>
                              <th className="px-3 py-2 text-right">Response</th>
                              <th className="px-3 py-2 text-right">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.slow_requests.map((e, i) => (
                              <tr key={i} className="border-b border-slate-800/40 hover:bg-slate-800/20">
                                <td className="px-3 py-2">
                                  <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold', methodColor(e.method))}>
                                    {e.method}
                                  </span>
                                </td>
                                <td className="px-3 py-2 font-mono text-slate-300 max-w-[200px] truncate" title={e.path}>{e.path}</td>
                                <td className="px-3 py-2 font-mono text-slate-500 truncate max-w-[120px]">{e.host}</td>
                                <td className={clsx('px-3 py-2 text-right tabular-nums font-semibold', e.response_ms > 2000 ? 'text-red-400' : 'text-amber-400')}>
                                  {fmtMs(e.response_ms)}
                                </td>
                                <td className="px-3 py-2 text-right">
                                  <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-semibold', statusColor(e.status))}>{e.status}</span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Panel>

                  <Panel title="Upstream container response times" icon={Server}>
                    {report.by_upstream.length > 0 ? (
                      <BarList items={report.by_upstream} color="bg-cyan-500" />
                    ) : (
                      <EmptyState icon={Server} title="No upstream data"
                        description="Requires offdock_main log format with $upstream_addr field." />
                    )}
                  </Panel>
                </div>
              </div>
            )}

            {/* ── REQUESTS FEED ── */}
            {tab === 'requests' && report && (
              <Panel
                title="Live request feed"
                actions={
                  <span className="text-xs text-slate-500">
                    {fSearch || fStatus !== 'all' || fMethod !== 'all'
                      ? `${filteredRecent.length} of ${report.recent.length} filtered`
                      : `${report.recent.length} recent · auto-refreshes 15s`}
                  </span>
                }
              >
                <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap gap-2 items-center">
                  <div className="relative flex-1 min-w-36">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-600" />
                    <input className="input pl-8 text-xs w-full py-1.5"
                      placeholder="Filter by path, IP, or host…"
                      value={fSearch}
                      onChange={e => setFSearch(e.target.value)} />
                  </div>
                  <div className="flex gap-0.5 p-0.5 bg-slate-950 border border-slate-800 rounded-lg">
                    {(['all', '2xx', '3xx', '4xx', '5xx'] as const).map(s => (
                      <button key={s} onClick={() => setFStatus(s)}
                        className={clsx('px-2 py-1 rounded text-[11px] font-medium transition-all',
                          fStatus === s ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300')}>
                        {s}
                      </button>
                    ))}
                  </div>
                  <select className="select text-xs py-1.5" value={fMethod} onChange={e => setFMethod(e.target.value)}>
                    <option value="all">All methods</option>
                    {feedMethods.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  {(fSearch || fStatus !== 'all' || fMethod !== 'all') && (
                    <button onClick={() => { setFSearch(''); setFStatus('all'); setFMethod('all') }}
                      className="text-slate-500 hover:text-slate-200 p-1.5 rounded hover:bg-slate-800">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
                  {filteredRecent.length === 0 ? (
                    <div className="py-12 text-center text-sm text-slate-600">No matching requests</div>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-slate-900 z-10">
                        <tr className="border-b border-slate-800 text-slate-600 text-[11px] uppercase tracking-wider">
                          <th className="px-3 py-2 text-left font-medium">Time</th>
                          <th className="px-3 py-2 text-left font-medium">Method</th>
                          <th className="px-3 py-2 text-left font-medium">Path</th>
                          <th className="px-3 py-2 text-left font-medium">Status</th>
                          <th className="px-3 py-2 text-left font-medium">Host</th>
                          <th className="px-3 py-2 text-left font-medium">Client</th>
                          <th className="px-3 py-2 text-left font-medium">User Agent</th>
                          <th className="px-3 py-2 text-right font-medium">Size</th>
                          {(report.recent[0]?.response_ms ?? 0) > 0 && (
                            <th className="px-3 py-2 text-right font-medium">Time</th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRecent.map((e, i) => <RequestRow key={i} e={e} />)}
                      </tbody>
                    </table>
                  )}
                </div>
              </Panel>
            )}

            {/* ── CONNECTIONS ── */}
            {tab === 'connections' && (
              <div className="space-y-4">
                <div className="flex justify-end">
                  <button onClick={loadConnections} className="btn-secondary gap-2 text-xs">
                    <RefreshCw className="w-3.5 h-3.5" /> Refresh
                  </button>
                </div>
                {!connections ? (
                  <Panel><div className="py-12 text-center text-sm text-slate-600">Loading connections…</div></Panel>
                ) : (
                  <>
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                      <StatCard label="Active connections" value={connections.connections.length.toLocaleString()} icon={Wifi} tone="blue" />
                      <StatCard label="Listening ports" value={connections.listen_ports.length.toLocaleString()} icon={Server} tone="emerald" />
                      <StatCard label="Interfaces" value={connections.interfaces.length.toLocaleString()} icon={Network} tone="violet" />
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <Panel title="Listening ports" icon={Server}>
                        <div className="overflow-x-auto max-h-72 overflow-y-auto">
                          <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-slate-900">
                              <tr className="border-b border-slate-800 text-slate-600 text-[11px] uppercase">
                                <th className="px-3 py-2 text-left">Port</th>
                                <th className="px-3 py-2 text-left">Proto</th>
                                <th className="px-3 py-2 text-left">Program</th>
                                <th className="px-3 py-2 text-left">Addr</th>
                              </tr>
                            </thead>
                            <tbody>
                              {connections.listen_ports.map((p, i) => (
                                <tr key={i} className="border-b border-slate-800/40 hover:bg-slate-800/20">
                                  <td className="px-3 py-2 tabular-nums font-mono text-blue-300">{p.port}</td>
                                  <td className="px-3 py-2 text-slate-500">{p.proto}</td>
                                  <td className="px-3 py-2 text-slate-300">{p.program || '—'}</td>
                                  <td className="px-3 py-2 font-mono text-slate-600">{p.addr}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </Panel>

                      <Panel title="Network interfaces" icon={Network}>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-slate-800 text-slate-600 text-[11px] uppercase">
                                <th className="px-3 py-2 text-left">Interface</th>
                                <th className="px-3 py-2 text-right">RX</th>
                                <th className="px-3 py-2 text-right">TX</th>
                                <th className="px-3 py-2 text-right">Packets In</th>
                                <th className="px-3 py-2 text-right">Packets Out</th>
                              </tr>
                            </thead>
                            <tbody>
                              {connections.interfaces.map((iface, i) => (
                                <tr key={i} className="border-b border-slate-800/40 hover:bg-slate-800/20">
                                  <td className="px-3 py-2 font-mono text-emerald-300">{iface.name}</td>
                                  <td className="px-3 py-2 text-right tabular-nums text-slate-400">{formatBytes(iface.rx_bytes)}</td>
                                  <td className="px-3 py-2 text-right tabular-nums text-slate-400">{formatBytes(iface.tx_bytes)}</td>
                                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{iface.rx_pkts.toLocaleString()}</td>
                                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{iface.tx_pkts.toLocaleString()}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </Panel>
                    </div>

                    <Panel title="Active TCP connections" icon={Wifi}
                      actions={<span className="text-xs text-slate-600">{connections.connections.length} total</span>}>
                      <div className="overflow-x-auto max-h-96 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-slate-900">
                            <tr className="border-b border-slate-800 text-slate-600 text-[11px] uppercase">
                              <th className="px-3 py-2 text-left">Proto</th>
                              <th className="px-3 py-2 text-left">Local</th>
                              <th className="px-3 py-2 text-left">Remote</th>
                              <th className="px-3 py-2 text-left">State</th>
                              <th className="px-3 py-2 text-left">Program</th>
                            </tr>
                          </thead>
                          <tbody>
                            {connections.connections.slice(0, 200).map((c, i) => (
                              <tr key={i} className="border-b border-slate-800/40 hover:bg-slate-800/20">
                                <td className="px-3 py-2 text-slate-500 font-mono">{c.proto}</td>
                                <td className="px-3 py-2 font-mono text-slate-400">{c.local_addr}:{c.local_port}</td>
                                <td className="px-3 py-2 font-mono text-slate-400">{c.remote_addr}:{c.remote_port}</td>
                                <td className="px-3 py-2">
                                  <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-medium',
                                    c.state === 'ESTABLISHED' ? 'text-emerald-400 bg-emerald-500/10' : 'text-slate-500 bg-slate-800')}>
                                    {c.state}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-slate-500">{c.program || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Panel>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Page>
  )
}
