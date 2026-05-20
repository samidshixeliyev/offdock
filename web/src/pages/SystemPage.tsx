import { useEffect, useState } from 'react'
import { SystemStats } from '../api/client'
import clsx from 'clsx'

function Gauge({ label, pct, sub }: { label: string; pct: number; sub: string }) {
  return (
    <div className="card">
      <div className="flex justify-between mb-3">
        <span className="text-sm text-gray-400">{label}</span>
        <span className="text-xl font-bold text-white">{pct.toFixed(1)}%</span>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
        <div className={clsx('h-full rounded-full transition-all duration-500', pct > 85 ? 'bg-red-500' : pct > 60 ? 'bg-yellow-500' : 'bg-blue-500')} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <p className="text-xs text-gray-600 mt-2">{sub}</p>
    </div>
  )
}

function humanGB(bytes: number) { return (bytes / 1e9).toFixed(2) + ' GB' }

export default function SystemPage() {
  const [stats, setStats] = useState<SystemStats | null>(null)

  useEffect(() => {
    const es = new EventSource('/api/v1/system/stats')
    es.onmessage = e => { try { setStats(JSON.parse(e.data as string)) } catch {} }
    es.onerror = () => es.close()
    return () => es.close()
  }, [])

  if (!stats) return <div className="p-6 text-gray-500">Connecting to stats stream…</div>

  const ramPct = stats.ram_total_bytes > 0 ? (stats.ram_used_bytes / stats.ram_total_bytes) * 100 : 0
  const diskPct = stats.disk_total_bytes > 0 ? (stats.disk_used_bytes / stats.disk_total_bytes) * 100 : 0
  const containers = stats.containers ?? []

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold text-white mb-6">System Resources</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Gauge label="CPU" pct={stats.cpu_percent} sub="1s average" />
        <Gauge label="RAM" pct={ramPct} sub={`${humanGB(stats.ram_used_bytes)} used / ${humanGB(stats.ram_total_bytes)}`} />
        <Gauge label="Disk" pct={diskPct} sub={`${humanGB(stats.disk_used_bytes)} used / ${humanGB(stats.disk_total_bytes)}`} />
      </div>

      {containers.length > 0 && (
        <section>
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Container Resources</h2>
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs">
                  <th className="text-left px-4 py-2.5">Container</th>
                  <th className="text-left px-4 py-2.5">CPU</th>
                  <th className="text-left px-4 py-2.5">Memory</th>
                  <th className="text-left px-4 py-2.5">Net I/O</th>
                  <th className="text-left px-4 py-2.5">Block I/O</th>
                  <th className="text-left px-4 py-2.5">PIDs</th>
                </tr>
              </thead>
              <tbody>
                {containers.map(c => (
                  <tr key={c.name} className="border-b border-gray-800/50">
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-300">{c.name}</td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">{c.CPUPerc}</td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">{c.MemUsage} ({c.MemPerc})</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{c.NetIO}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{c.BlockIO}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{c.PIDs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="text-xs text-gray-700 mt-4">Last updated: {new Date(stats.timestamp).toLocaleTimeString()}</p>
    </div>
  )
}
