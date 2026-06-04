import { useEffect, useMemo, useRef, useState } from 'react'
import { api, TrafficReport, TrafficBucket, TrafficCount } from '../api/client'
import { Page, PageHeader, Panel, StatCard, EmptyState } from '../components/ui'
import { formatBytes, timeAgo } from '../lib/format'
import clsx from 'clsx'
import {
  Activity, RefreshCw, Globe, AlertTriangle, Network, Gauge, ArrowDownToLine,
  ChevronDown, Users, Search, X,
} from 'lucide-react'

const WINDOWS = [
  { label: '1h', hours: 1 }, { label: '6h', hours: 6 },
  { label: '24h', hours: 24 }, { label: '7d', hours: 168 },
]

// ─── Area chart (requests over time + error overlay) ───────────────────────────
function AreaChart({ series }: { series: TrafficBucket[] }) {
  const W = 800, H = 180, P = 4
  if (series.length < 2) return <div className="h-44 flex items-center justify-center text-sm text-slate-600">Not enough data to chart</div>
  const max = Math.max(...series.map(b => b.count), 1)
  const stepX = (W - P * 2) / (series.length - 1)
  const x = (i: number) => P + i * stepX
  const y = (v: number) => H - P - (v / max) * (H - P * 2)
  const line = (key: 'count' | 'err') => series.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(b[key]).toFixed(1)}`).join(' ')
  const area = `${line('count')} L${x(series.length - 1).toFixed(1)},${H - P} L${x(0).toFixed(1)},${H - P} Z`
  const fmtT = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="p-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 200 }} preserveAspectRatio="none">
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map(f => <line key={f} x1={P} y1={H * f} x2={W - P} y2={H * f} stroke="#1e293b" strokeWidth="1" />)}
        <path d={area} fill="url(#areaGrad)" />
        <path d={line('count')} fill="none" stroke="#3b82f6" strokeWidth="2" />
        <path d={line('err')} fill="none" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.8" />
      </svg>
      <div className="flex items-center justify-between mt-2 text-[10px] text-slate-600">
        <span>{fmtT(series[0].t)}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-blue-500" /> requests</span>
          <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-red-500" /> errors</span>
          <span className="text-slate-500">peak {max}</span>
        </span>
        <span>{fmtT(series[series.length - 1].t)}</span>
      </div>
    </div>
  )
}

// ─── Status donut ──────────────────────────────────────────────────────────────
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
          const el = <circle key={p.label} cx="65" cy="65" r={R} fill="none" stroke={p.color} strokeWidth="14"
            strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />
          offset += len
          return el
        })}
      </svg>
      <div className="space-y-1.5 flex-1">
        {parts.map(p => (
          <div key={p.label} className="flex items-center gap-2 text-sm">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: p.color }} />
            <span className="text-slate-300 w-9">{p.label}</span>
            <span className="text-slate-500 tabular-nums flex-1 text-right">{p.value.toLocaleString()}</span>
            <span className="text-slate-600 tabular-nums w-12 text-right">{((p.value / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Horizontal bar list ───────────────────────────────────────────────────────
function BarList({ items, color = 'bg-blue-500' }: { items: TrafficCount[]; color?: string }) {
  const max = Math.max(...items.map(i => i.count), 1)
  if (items.length === 0) return <p className="text-sm text-slate-600 text-center py-6">No data</p>
  return (
    <div className="p-3 space-y-1.5">
      {items.map(it => (
        <div key={it.key} className="relative flex items-center gap-2 px-2 py-1.5 rounded-lg overflow-hidden group">
          <div className={clsx('absolute inset-y-0 left-0 rounded-lg opacity-15 group-hover:opacity-25 transition-opacity', color)} style={{ width: `${(it.count / max) * 100}%` }} />
          <span className="relative font-mono text-xs text-slate-300 truncate flex-1" title={it.key}>{it.key}</span>
          <span className="relative tabular-nums text-xs text-slate-400 shrink-0">{it.count.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

function statusColor(s: number) {
  if (s >= 500) return 'text-red-400'
  if (s >= 400) return 'text-amber-400'
  if (s >= 300) return 'text-blue-400'
  return 'text-emerald-400'
}

export default function TrafficPage() {
  const [hours, setHours] = useState(24)
  const [host, setHost] = useState('')
  const [report, setReport] = useState<TrafficReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [hostOpen, setHostOpen] = useState(false)
  // Recent-requests filters (client-side, applied to the live feed).
  const [fSearch, setFSearch] = useState('')
  const [fStatus, setFStatus] = useState<'all' | '2xx' | '3xx' | '4xx' | '5xx'>('all')
  const [fMethod, setFMethod] = useState('all')
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = async () => {
    try { setReport(await api.traffic(hours, host || undefined)) } catch {} finally { setLoading(false) }
  }
  useEffect(() => {
    setLoading(true); load()
    timer.current = setInterval(load, 15000)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [hours, host]) // eslint-disable-line

  const s = report?.summary
  const errRate = s && s.total > 0 ? ((s.status_4xx + s.status_5xx) / s.total) * 100 : 0
  const hasData = (s?.total ?? 0) > 0
  const availableHosts = useMemo(() => report?.hosts ?? [], [report])

  // Methods present in the current feed (for the method filter dropdown).
  const feedMethods = useMemo(() => {
    const set = new Set<string>()
    for (const e of report?.recent ?? []) set.add(e.method)
    return Array.from(set).sort()
  }, [report])

  // Apply client-side filters to the recent-requests feed.
  const filteredRecent = useMemo(() => {
    const q = fSearch.trim().toLowerCase()
    return (report?.recent ?? []).filter(e => {
      if (fMethod !== 'all' && e.method !== fMethod) return false
      if (fStatus !== 'all' && Math.floor(e.status / 100) !== Number(fStatus[0])) return false
      if (q && !e.path.toLowerCase().includes(q) && !e.ip.toLowerCase().includes(q) && !e.host.toLowerCase().includes(q)) return false
      return true
    })
  }, [report, fSearch, fStatus, fMethod])
  const filtersActive = fSearch !== '' || fStatus !== 'all' || fMethod !== 'all'

  return (
    <Page>
      <PageHeader title="Traffic" subtitle="nginx access-log analytics" icon={Activity}
        actions={<>
          {/* host filter */}
          <div className="relative">
            <button onClick={() => setHostOpen(o => !o)} className="btn-secondary">
              <Globe className="w-4 h-4" /> {host || 'All hosts'} <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {hostOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setHostOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 w-56 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl py-1 max-h-72 overflow-y-auto animate-scaleIn">
                  <button onClick={() => { setHost(''); setHostOpen(false) }} className={clsx('w-full text-left px-3 py-2 text-sm hover:bg-slate-800/60', !host && 'text-blue-400')}>All hosts</button>
                  {availableHosts.map(hh => (
                    <button key={hh} onClick={() => { setHost(hh); setHostOpen(false) }} className={clsx('w-full text-left px-3 py-2 text-sm font-mono truncate hover:bg-slate-800/60', host === hh && 'text-blue-400')}>{hh}</button>
                  ))}
                </div>
              </>
            )}
          </div>
          {/* window */}
          <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
            {WINDOWS.map(w => (
              <button key={w.hours} onClick={() => setHours(w.hours)}
                className={clsx('px-2.5 py-1 rounded-md text-xs font-medium transition-all', hours === w.hours ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200')}>
                {w.label}
              </button>
            ))}
          </div>
          <button onClick={() => { setLoading(true); load() }} className="btn-secondary"><RefreshCw className="w-4 h-4" /></button>
        </>} />

      {loading && !report ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">{[0,1,2,3,4].map(i => <div key={i} className="h-24 skeleton rounded-xl" />)}</div>
          <div className="h-56 skeleton rounded-xl" />
        </div>
      ) : !hasData ? (
        <Panel>
          <EmptyState icon={Activity} title="No traffic in this window"
            description="Once requests hit your proxy hosts, metrics appear here. Enable 'Access log' on a proxy host to capture per-host traffic." />
        </Panel>
      ) : s && report ? (
        <div className="space-y-4">
          {/* Summary */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Requests" value={s.total.toLocaleString()} icon={Activity} tone="blue" sublabel={`last ${s.window_hours}h`} />
            <StatCard label="Req / sec" value={s.rps.toFixed(s.rps < 1 ? 2 : 1)} icon={Gauge} tone="violet" />
            <StatCard label="Error rate" value={`${errRate.toFixed(1)}%`} icon={AlertTriangle} tone={errRate > 5 ? 'red' : 'emerald'} sublabel={`${(s.status_4xx + s.status_5xx).toLocaleString()} errors`} />
            <StatCard label="Bandwidth" value={formatBytes(s.bytes)} icon={ArrowDownToLine} tone="amber" />
            <StatCard label="Unique IPs" value={s.unique_ips.toLocaleString()} icon={Users} tone="slate" />
          </div>

          {/* Time series + status */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Panel title="Requests over time" icon={Activity} className="lg:col-span-2"><AreaChart series={report.series} /></Panel>
            <Panel title="Status codes" icon={Gauge}><StatusDonut s={s} /></Panel>
          </div>

          {/* Breakdowns */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Panel title="Top paths" icon={Globe}><BarList items={report.top_paths} color="bg-blue-500" /></Panel>
            <Panel title="Top clients" icon={Network}><BarList items={report.top_ips} color="bg-violet-500" /></Panel>
            <Panel title="By host" icon={Globe}><BarList items={report.by_host} color="bg-emerald-500" /></Panel>
          </div>

          {/* Recent requests */}
          <Panel title="Recent requests" icon={Activity}
            actions={<span className="text-xs text-slate-500">{filtersActive ? `${filteredRecent.length} of ${report.recent.length}` : 'live · refreshes 15s'}</span>}>
            {/* Filter bar */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800 flex-wrap">
              <div className="relative flex-1 min-w-[180px] max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input value={fSearch} onChange={e => setFSearch(e.target.value)} placeholder="Filter path, IP or host…"
                  className="w-full pl-9 pr-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500" />
              </div>
              {/* status class */}
              <div className="flex items-center gap-1 p-1 bg-slate-800 rounded-lg">
                {(['all', '2xx', '3xx', '4xx', '5xx'] as const).map(sc => (
                  <button key={sc} onClick={() => setFStatus(sc)}
                    className={clsx('px-2.5 py-1 rounded-md text-xs font-medium transition-all', fStatus === sc ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200')}>
                    {sc === 'all' ? 'All' : sc}
                  </button>
                ))}
              </div>
              {/* method */}
              <select value={fMethod} onChange={e => setFMethod(e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded-lg text-xs py-1.5 px-2 text-slate-200 focus:outline-none focus:border-blue-500">
                <option value="all">All methods</option>
                {feedMethods.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              {filtersActive && (
                <button onClick={() => { setFSearch(''); setFStatus('all'); setFMethod('all') }}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800">
                  <X className="w-3.5 h-3.5" /> Clear
                </button>
              )}
            </div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full min-w-[720px]">
                <thead className="sticky top-0 bg-slate-900">
                  <tr className="border-b border-slate-800">
                    <th className="th text-left">Time</th><th className="th text-left">Method</th>
                    <th className="th text-left">Path</th><th className="th text-left">Status</th>
                    <th className="th text-left">Host</th><th className="th text-left">Client</th>
                    <th className="th text-right">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRecent.map((e, i) => (
                    <tr key={i} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30">
                      <td className="px-4 py-2 text-xs text-slate-500 whitespace-nowrap">{timeAgo(e.time)}</td>
                      <td className="px-4 py-2"><span className="text-xs font-mono font-medium text-slate-300">{e.method}</span></td>
                      <td className="px-4 py-2 text-xs font-mono text-slate-300 max-w-xs truncate" title={e.path}>{e.path}</td>
                      <td className="px-4 py-2"><span className={clsx('text-xs font-mono font-semibold', statusColor(e.status))}>{e.status}</span></td>
                      <td className="px-4 py-2 text-xs font-mono text-slate-500 truncate max-w-[140px]">{e.host}</td>
                      <td className="px-4 py-2 text-xs font-mono text-slate-500">{e.ip}</td>
                      <td className="px-4 py-2 text-xs text-slate-500 text-right tabular-nums">{formatBytes(e.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredRecent.length === 0 && <p className="text-center text-sm text-slate-500 py-6">No requests match the filters.</p>}
            </div>
          </Panel>
        </div>
      ) : null}
    </Page>
  )
}
