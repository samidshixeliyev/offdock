import { useEffect, useState } from 'react'
import { SystemStats } from '../api/client'
import clsx from 'clsx'

function fmtBytes(bytes: number, decimals = 1) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i]
}

function fmtGb(bytes: number) { return (bytes / 1e9).toFixed(2) + ' GB' }

function fmtUptime(secs: number) {
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${Math.floor(secs % 60)}s`
}

function GaugeFull({
  label, pct, primary, secondary, accent,
}: {
  label: string
  pct: number
  primary: string
  secondary?: string
  accent?: string
}) {
  const color = pct > 85 ? 'bg-red-500' : pct > 65 ? 'bg-yellow-500' : (accent ?? 'bg-blue-500')
  return (
    <div className="card">
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-sm text-gray-400">{label}</span>
        <span className={clsx('text-2xl font-bold tabular-nums', pct > 85 ? 'text-red-400' : 'text-white')}>
          {pct.toFixed(1)}<span className="text-sm text-gray-500 font-normal ml-0.5">%</span>
        </span>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden mb-2">
        <div className={clsx('h-full rounded-full transition-all duration-700', color)}
          style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <p className="text-xs text-gray-500">{primary}</p>
      {secondary && <p className="text-xs text-gray-700 mt-0.5">{secondary}</p>}
    </div>
  )
}

function MetricRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-gray-800/50 last:border-0">
      <span className="text-xs text-gray-500">{label}</span>
      <div className="text-right">
        <span className="text-xs font-medium text-gray-200 tabular-nums">{value}</span>
        {sub && <span className="text-xs text-gray-600 ml-2">{sub}</span>}
      </div>
    </div>
  )
}

function CpuBar({ pct, label }: { pct: number; label: string }) {
  const val = parseFloat(pct.toString()) || 0
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-600 w-28 truncate shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all', val > 80 ? 'bg-red-500' : val > 50 ? 'bg-yellow-500' : 'bg-blue-500')}
          style={{ width: `${Math.min(val, 100)}%` }}
        />
      </div>
      <span className="text-xs text-gray-400 tabular-nums w-12 text-right">{val.toFixed(1)}%</span>
    </div>
  )
}

export default function SystemPage() {
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [history, setHistory] = useState<number[]>([]) // CPU history for sparkline

  useEffect(() => {
    const es = new EventSource('/api/v1/system/stats')
    es.onmessage = e => {
      try {
        const s = JSON.parse(e.data as string) as SystemStats
        setStats(s)
        setHistory(prev => [...prev.slice(-29), s.cpu_percent])
      } catch {}
    }
    es.onerror = () => es.close()
    return () => es.close()
  }, [])

  if (!stats) {
    return (
      <div className="p-6 flex items-center gap-3 text-gray-600">
        <span className="animate-spin">⟳</span>
        Connecting to stats stream…
      </div>
    )
  }

  const ramPct = stats.ram_total_bytes > 0 ? (stats.ram_used_bytes / stats.ram_total_bytes) * 100 : 0
  const diskPct = stats.disk_total_bytes > 0 ? (stats.disk_used_bytes / stats.disk_total_bytes) * 100 : 0
  const containers = stats.containers ?? []
  const load: [number, number, number] = stats.load_avg ?? [0, 0, 0]
  const uptime = stats.uptime_secs ?? 0
  const ramFree = stats.ram_free_bytes ?? 0
  const ramCached = stats.ram_cached_bytes ?? 0

  // Sparkline SVG
  const sparkMax = Math.max(...history, 1)
  const sparkPoints = history.map((v, i) => {
    const x = (i / (history.length - 1 || 1)) * 100
    const y = 100 - (v / sparkMax) * 100
    return `${x},${y}`
  }).join(' ')

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-6xl">
      <div className="flex items-baseline justify-between mb-7">
        <div>
          <h1 className="text-lg font-semibold text-white">System Metrics</h1>
          <p className="text-xs text-gray-600 mt-0.5">
            Live · updated every 3s · uptime {fmtUptime(uptime)}
          </p>
        </div>
        <p className="text-xs text-gray-700">{new Date(stats.timestamp).toLocaleTimeString()}</p>
      </div>

      {/* Main gauges */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <GaugeFull
          label="CPU"
          pct={stats.cpu_percent}
          primary={`Load: ${load[0].toFixed(2)} / ${load[1].toFixed(2)} / ${load[2].toFixed(2)}`}
          secondary="1 min / 5 min / 15 min"
        />
        <GaugeFull
          label="Memory"
          pct={ramPct}
          primary={`${fmtGb(stats.ram_used_bytes)} used · ${fmtGb(ramFree)} free`}
          secondary={`${fmtGb(ramCached)} cached · ${fmtGb(stats.ram_total_bytes)} total`}
          accent="bg-purple-500"
        />
        <GaugeFull
          label="Disk"
          pct={diskPct}
          primary={`${fmtGb(stats.disk_used_bytes)} used of ${fmtGb(stats.disk_total_bytes)}`}
          secondary={`${fmtGb(stats.disk_total_bytes - stats.disk_used_bytes)} free`}
          accent="bg-cyan-500"
        />
      </div>

      {/* CPU sparkline + memory breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {/* CPU history */}
        <div className="card">
          <p className="section-heading mb-3">CPU History (30 samples)</p>
          {history.length > 1 ? (
            <div className="relative h-20">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full">
                <polyline
                  points={sparkPoints}
                  fill="none"
                  stroke={stats.cpu_percent > 85 ? '#ef4444' : '#3b82f6'}
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <div className="absolute bottom-0 left-0 right-0 flex justify-between text-xs text-gray-700">
                <span>30s ago</span>
                <span>now</span>
              </div>
            </div>
          ) : (
            <div className="h-20 flex items-center justify-center text-xs text-gray-700">
              Collecting data…
            </div>
          )}
          <div className="flex justify-between mt-2 text-xs text-gray-600">
            <span>Min {Math.min(...history).toFixed(1)}%</span>
            <span>Avg {history.length ? (history.reduce((a, b) => a + b, 0) / history.length).toFixed(1) : 0}%</span>
            <span>Max {Math.max(...history).toFixed(1)}%</span>
          </div>
        </div>

        {/* Memory breakdown */}
        <div className="card">
          <p className="section-heading mb-3">Memory Breakdown</p>
          <div className="space-y-2">
            {[
              { label: 'Used', bytes: stats.ram_used_bytes, color: 'bg-purple-500' },
              { label: 'Cached', bytes: stats.ram_cached_bytes ?? 0, color: 'bg-blue-500' },
              { label: 'Free', bytes: stats.ram_free_bytes ?? 0, color: 'bg-green-600' },
            ].map(({ label, bytes, color }) => (
              <div key={label} className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-14 shrink-0">{label}</span>
                <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={clsx('h-full rounded-full', color)}
                    style={{ width: `${Math.min((bytes / stats.ram_total_bytes) * 100, 100)}%` }}
                  />
                </div>
                <span className="text-xs text-gray-400 tabular-nums w-16 text-right">{fmtGb(bytes)}</span>
              </div>
            ))}
            <div className="pt-1 border-t border-gray-800 flex justify-between text-xs text-gray-600">
              <span>Total</span>
              <span>{fmtGb(stats.ram_total_bytes)} GB</span>
            </div>
          </div>
        </div>
      </div>

      {/* Host info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="card">
          <p className="section-heading mb-2">Host Info</p>
          <MetricRow label="Uptime" value={fmtUptime(stats.uptime_secs ?? 0)} />
          <MetricRow label="Load (1m / 5m / 15m)"
            value={`${load[0].toFixed(2)} / ${load[1].toFixed(2)} / ${load[2].toFixed(2)}`} />
          <MetricRow label="Disk Used"
            value={fmtGb(stats.disk_used_bytes)}
            sub={`of ${fmtGb(stats.disk_total_bytes)}`} />
          <MetricRow label="Disk Free"
            value={fmtGb(stats.disk_total_bytes - stats.disk_used_bytes)} />
        </div>
        <div className="card">
          <p className="section-heading mb-2">Memory Detail</p>
          <MetricRow label="Total" value={fmtBytes(stats.ram_total_bytes)} />
          <MetricRow label="Used" value={fmtBytes(stats.ram_used_bytes)}
            sub={`${ramPct.toFixed(1)}%`} />
          <MetricRow label="Free" value={fmtBytes(stats.ram_free_bytes ?? 0)} />
          <MetricRow label="Cached / Buffers" value={fmtBytes(stats.ram_cached_bytes ?? 0)} />
        </div>
      </div>

      {/* Containers */}
      {containers.length > 0 && (
        <section>
          <p className="section-heading mb-3">
            Container Resources
            <span className="ml-2 text-gray-600 normal-case font-normal">
              ({containers.length} running)
            </span>
          </p>
          <div className="card p-0 overflow-hidden">
            {/* CPU bars */}
            <div className="px-5 py-4 border-b border-gray-800 space-y-2">
              <p className="text-xs text-gray-600 mb-3">CPU utilization</p>
              {containers.map(c => (
                <CpuBar
                  key={c.name}
                  label={c.name}
                  pct={parseFloat(c.CPUPerc?.replace('%', '') || '0')}
                />
              ))}
            </div>

            {/* Full table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-500">
                    <th className="text-left px-4 py-3 text-xs font-medium">Container</th>
                    <th className="text-left px-4 py-3 text-xs font-medium">CPU</th>
                    <th className="text-left px-4 py-3 text-xs font-medium">Memory</th>
                    <th className="text-left px-4 py-3 text-xs font-medium">Mem %</th>
                    <th className="text-left px-4 py-3 text-xs font-medium">Net I/O</th>
                    <th className="text-left px-4 py-3 text-xs font-medium">Block I/O</th>
                    <th className="text-left px-4 py-3 text-xs font-medium">PIDs</th>
                  </tr>
                </thead>
                <tbody>
                  {containers.map(c => {
                    const cpuVal = parseFloat(c.CPUPerc?.replace('%', '') || '0')
                    return (
                      <tr key={c.name} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                        <td className="px-4 py-3 font-mono text-xs text-gray-300">{c.name}</td>
                        <td className="px-4 py-3 text-xs">
                          <span className={clsx('tabular-nums',
                            cpuVal > 80 ? 'text-red-400' : cpuVal > 50 ? 'text-yellow-400' : 'text-gray-400'
                          )}>
                            {c.CPUPerc}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-400 text-xs tabular-nums">{c.MemUsage}</td>
                        <td className="px-4 py-3 text-gray-500 text-xs tabular-nums">{c.MemPerc}</td>
                        <td className="px-4 py-3 text-gray-600 text-xs">{c.NetIO}</td>
                        <td className="px-4 py-3 text-gray-600 text-xs">{c.BlockIO}</td>
                        <td className="px-4 py-3 text-gray-600 text-xs text-center">{c.PIDs}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {containers.length === 0 && (
        <div className="card text-center py-8 text-gray-600 text-sm border-dashed">
          No running containers
        </div>
      )}
    </div>
  )
}
