import { useEffect, useRef, useState } from 'react'
import { api, SystemStats, DiskUsageRow } from '../api/client'
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
        <span className="text-sm text-slate-400">{label}</span>
        <span className={clsx('text-2xl font-bold tabular-nums', pct > 85 ? 'text-red-400' : 'text-white')}>
          {pct.toFixed(1)}<span className="text-sm text-slate-500 font-normal ml-0.5">%</span>
        </span>
      </div>
      <div className="h-2 bg-slate-800 rounded-full overflow-hidden mb-2">
        <div className={clsx('h-full rounded-full transition-all duration-700', color)}
          style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <p className="text-xs text-slate-500">{primary}</p>
      {secondary && <p className="text-xs text-slate-700 mt-0.5">{secondary}</p>}
    </div>
  )
}

function MetricRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-slate-800/50 last:border-0">
      <span className="text-xs text-slate-500">{label}</span>
      <div className="text-right">
        <span className="text-xs font-medium text-slate-200 tabular-nums">{value}</span>
        {sub && <span className="text-xs text-slate-600 ml-2">{sub}</span>}
      </div>
    </div>
  )
}

function CpuBar({ pct, label }: { pct: number; label: string }) {
  const val = parseFloat(pct.toString()) || 0
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-600 w-28 truncate shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all', val > 80 ? 'bg-red-500' : val > 50 ? 'bg-yellow-500' : 'bg-blue-500')}
          style={{ width: `${Math.min(val, 100)}%` }}
        />
      </div>
      <span className="text-xs text-slate-400 tabular-nums w-12 text-right">{val.toFixed(1)}%</span>
    </div>
  )
}

export default function SystemPage() {
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [history, setHistory] = useState<number[]>([]) // CPU history for sparkline
  const [dockerDf, setDockerDf] = useState<DiskUsageRow[]>([])

  // Nginx setup state
  const [nginxStatus, setNginxStatus] = useState<{ available: boolean; status: string } | null>(null)
  const [nginxDomain, setNginxDomain] = useState('')
  const [nginxPort, setNginxPort] = useState(7070)
  const [nginxConfigPreview, setNginxConfigPreview] = useState('')
  const [nginxApplyMessage, setNginxApplyMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [nginxLoading, setNginxLoading] = useState(false)

  useEffect(() => {
    api.getSystemDf().then(d => setDockerDf(d.rows ?? [])).catch(() => {})
  }, [])

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

  useEffect(() => {
    api.getNginxSystemStatus().then(setNginxStatus).catch(() => setNginxStatus({ available: false, status: '' }))
  }, [])

  async function previewNginxConfig() {
    if (!nginxDomain.trim()) {
      setNginxApplyMessage({ kind: 'err', text: 'Domain is required' })
      return
    }
    try {
      setNginxLoading(true)
      const res = await api.getSelfNginxConfig(nginxDomain.trim(), nginxPort)
      setNginxConfigPreview(res.config)
      setNginxApplyMessage(null)
    } catch (e) {
      setNginxApplyMessage({ kind: 'err', text: (e as Error).message })
    } finally {
      setNginxLoading(false)
    }
  }

  async function applyNginxConfig() {
    if (!nginxDomain.trim()) {
      setNginxApplyMessage({ kind: 'err', text: 'Domain is required' })
      return
    }
    try {
      setNginxLoading(true)
      const res = await api.applySelfNginxConfig(nginxDomain.trim(), nginxPort)
      setNginxApplyMessage({ kind: 'ok', text: `Applied: ${res.config_path}` })
      // Refresh status
      api.getNginxSystemStatus().then(setNginxStatus).catch(() => {})
    } catch (e) {
      setNginxApplyMessage({ kind: 'err', text: (e as Error).message })
    } finally {
      setNginxLoading(false)
    }
  }

  if (!stats) {
    return (
      <div className="p-6 flex items-center gap-3 text-slate-600">
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
          <p className="text-xs text-slate-600 mt-0.5">
            Live · updated every 3s · uptime {fmtUptime(uptime)}
          </p>
        </div>
        <p className="text-xs text-slate-700">{new Date(stats.timestamp).toLocaleTimeString()}</p>
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
              <div className="absolute bottom-0 left-0 right-0 flex justify-between text-xs text-slate-700">
                <span>30s ago</span>
                <span>now</span>
              </div>
            </div>
          ) : (
            <div className="h-20 flex items-center justify-center text-xs text-slate-700">
              Collecting data…
            </div>
          )}
          <div className="flex justify-between mt-2 text-xs text-slate-600">
            <span>Min {history.length ? Math.min(...history).toFixed(1) : 0}%</span>
            <span>Avg {history.length ? (history.reduce((a, b) => a + b, 0) / history.length).toFixed(1) : 0}%</span>
            <span>Max {history.length ? Math.max(...history).toFixed(1) : 0}%</span>
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
                <span className="text-xs text-slate-500 w-14 shrink-0">{label}</span>
                <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={clsx('h-full rounded-full', color)}
                    style={{ width: `${Math.min((bytes / stats.ram_total_bytes) * 100, 100)}%` }}
                  />
                </div>
                <span className="text-xs text-slate-400 tabular-nums w-16 text-right">{fmtGb(bytes)}</span>
              </div>
            ))}
            <div className="pt-1 border-t border-slate-800 flex justify-between text-xs text-slate-600">
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

      {/* Docker disk usage breakdown */}
      {dockerDf.length > 0 && (
        <section>
          <p className="section-heading mb-3">Docker Disk Usage</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {dockerDf.map(row => (
              <div key={row.type} className="card">
                <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">{row.type}</div>
                <div className="text-lg font-semibold text-white">{row.size}</div>
                <div className="text-xs text-slate-500 mt-1">{row.total} objects · {row.active} active</div>
                {row.reclaimable && (
                  <div className="text-[11px] text-amber-400/80 mt-0.5">{row.reclaimable} reclaimable</div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Containers */}
      {containers.length > 0 && (
        <section>
          <p className="section-heading mb-3">
            Container Resources
            <span className="ml-2 text-slate-600 normal-case font-normal">
              ({containers.length} running)
            </span>
          </p>
          <div className="card p-0 overflow-hidden">
            {/* CPU bars */}
            <div className="px-5 py-4 border-b border-slate-800 space-y-2">
              <p className="text-xs text-slate-600 mb-3">CPU utilization</p>
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
                  <tr className="border-b border-slate-800 text-slate-500">
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
                      <tr key={c.name} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                        <td className="px-4 py-3 font-mono text-xs text-slate-300">{c.name}</td>
                        <td className="px-4 py-3 text-xs">
                          <span className={clsx('tabular-nums',
                            cpuVal > 80 ? 'text-red-400' : cpuVal > 50 ? 'text-yellow-400' : 'text-slate-400'
                          )}>
                            {c.CPUPerc}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-400 text-xs tabular-nums">{c.MemUsage}</td>
                        <td className="px-4 py-3 text-slate-500 text-xs tabular-nums">{c.MemPerc}</td>
                        <td className="px-4 py-3 text-slate-600 text-xs">{c.NetIO}</td>
                        <td className="px-4 py-3 text-slate-600 text-xs">{c.BlockIO}</td>
                        <td className="px-4 py-3 text-slate-600 text-xs text-center">{c.PIDs}</td>
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
        <div className="card text-center py-8 text-slate-600 text-sm border-dashed">
          No running containers
        </div>
      )}

      {/* Nginx Setup section */}
      <section className="mt-6">
        <p className="section-heading mb-3">Nginx Setup</p>
        <div className="card space-y-4">
          {/* Status row */}
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200 mb-1">System Nginx</p>
              <p className="text-xs text-slate-500">
                Native nginx on the host. Required for proxying domains (e.g. deploy.ao.az) to OffDock.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {nginxStatus === null ? (
                <span className="text-xs text-slate-600">Checking...</span>
              ) : nginxStatus.available ? (
                <span className={clsx(
                  'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium',
                  nginxStatus.status === 'active'
                    ? 'bg-green-900/40 text-green-400 border border-green-900'
                    : 'bg-yellow-900/40 text-yellow-400 border border-yellow-900',
                )}>
                  <span className={clsx(
                    'w-1.5 h-1.5 rounded-full',
                    nginxStatus.status === 'active' ? 'bg-green-500' : 'bg-yellow-500',
                  )} />
                  {nginxStatus.status || 'installed'}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-red-900/40 text-red-400 border border-red-900">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                  not installed
                </span>
              )}
            </div>
          </div>

          {nginxStatus?.available && (
            <>
              {/* Inputs */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <label className="block text-xs text-slate-500 mb-1">Domain</label>
                  <input
                    type="text"
                    value={nginxDomain}
                    onChange={e => setNginxDomain(e.target.value)}
                    placeholder="deploy.ao.az"
                    className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-slate-700"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Port</label>
                  <input
                    type="number"
                    value={nginxPort}
                    onChange={e => setNginxPort(parseInt(e.target.value, 10) || 7070)}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-slate-700"
                  />
                </div>
              </div>

              {/* Buttons */}
              <div className="flex items-center gap-2">
                <button
                  onClick={previewNginxConfig}
                  disabled={nginxLoading}
                  className="btn-ghost text-xs disabled:opacity-50"
                >
                  Generate Config
                </button>
                <button
                  onClick={applyNginxConfig}
                  disabled={nginxLoading}
                  className="btn-primary text-xs disabled:opacity-50"
                >
                  Apply Config
                </button>
              </div>

              {/* Status message */}
              {nginxApplyMessage && (
                <div className={clsx(
                  'text-xs px-3 py-2 rounded border',
                  nginxApplyMessage.kind === 'ok'
                    ? 'bg-green-900/20 border-green-900 text-green-400'
                    : 'bg-red-900/20 border-red-900 text-red-400',
                )}>
                  {nginxApplyMessage.text}
                </div>
              )}

              {/* Config preview */}
              {nginxConfigPreview && (
                <div>
                  <p className="text-xs text-slate-500 mb-1">Generated config</p>
                  <pre className="bg-slate-950 border border-slate-800 rounded p-3 text-xs text-slate-400 overflow-x-auto whitespace-pre">
                    {nginxConfigPreview}
                  </pre>
                </div>
              )}

              {/* DNS instructions */}
              <div className="border-t border-slate-800 pt-3">
                <p className="text-xs text-slate-500 mb-2">DNS Setup</p>
                <p className="text-xs text-slate-600 mb-1.5">
                  Create the following A record(s) in your DNS provider:
                </p>
                <pre className="bg-slate-950 border border-slate-800 rounded p-2.5 text-xs text-slate-500 font-mono">
{`${nginxDomain || 'deploy.ao.az'}   A   <this-server-ip>
*.${(nginxDomain || 'deploy.ao.az').split('.').slice(-2).join('.')}        A   <this-server-ip>   (optional wildcard)`}
                </pre>
              </div>
            </>
          )}

          {nginxStatus && !nginxStatus.available && (
            <div className="text-xs text-slate-500 border-t border-slate-800 pt-3">
              Install nginx on the host first:
              <pre className="bg-slate-950 border border-slate-800 rounded p-2.5 mt-2 text-xs text-slate-500 font-mono">
sudo apt-get install nginx
              </pre>
              For air-gapped servers, build a bundle with <code className="text-slate-400">bash install.sh --bundle</code> on an
              internet-connected machine, then <code className="text-slate-400">sudo bash install.sh --full</code> on the target.
            </div>
          )}
        </div>
      </section>

      {/* Backup section */}
      <section className="mt-6">
        <p className="section-heading mb-3">Backup</p>
        <div className="card">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200 mb-1">Configuration Backup</p>
              <p className="text-xs text-slate-500">
                Downloads a ZIP archive of all OffDock configuration data (.db files).
              </p>
            </div>
            <button
              onClick={() => api.downloadBackup()}
              className="btn-ghost text-xs flex items-center gap-1.5"
              title="Download backup"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Download Backup
            </button>
          </div>
        </div>
      </section>

      {/* Maintenance: reconcile + memory optimize */}
      <MaintenanceSection />

      {/* Host package safety */}
      <PackagesSection />

      {/* Full backup / restore / schedule */}
      <BackupsSection />

      {/* Terminal command policy */}
      <TerminalPolicySection />

      {/* Self-update section */}
      <SystemUpdateSection />
      <ScheduledUpdateSection />
    </div>
  )
}

// ─── Maintenance (reconcile + optimize) ───────────────────────────────────────

function MaintenanceSection() {
  const [busy, setBusy] = useState<'' | 'reconcile' | 'optimize'>('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [dockerPrune, setDockerPrune] = useState(false)

  async function runReconcile() {
    setBusy('reconcile'); setMsg(null)
    try {
      const r = await api.reconcile()
      setMsg({ kind: 'ok', text: `Reconcile done — docker ${r.docker_ready ? 'up' : 'DOWN'}, ${r.projects_up.length} project(s) up, ${r.nginx_applied.length} nginx vhost(s) applied. Errors: ${r.project_errors.length + r.nginx_errors.length}` })
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }) } finally { setBusy('') }
  }

  async function runOptimize() {
    setBusy('optimize'); setMsg(null)
    try {
      const r = await api.optimize({ compact: true, drop_caches: true, docker_prune: dockerPrune })
      setMsg({ kind: 'ok', text: `Optimized — RAM freed ${fmtBytes(Math.max(0, r.ram_freed_bytes))}, disk reclaimed ${fmtBytes(r.disk_reclaimed_bytes)}${r.errors?.length ? ` (${r.errors.length} warnings)` : ''}` })
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }) } finally { setBusy('') }
  }

  return (
    <section className="mt-6">
      <p className="section-heading mb-3">Maintenance</p>
      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-slate-200 mb-1">Self-heal (reconcile)</p>
            <p className="text-xs text-slate-500">Ensure Docker is up, bring every running project back, and re-apply all nginx vhosts from the database. Run this after a host reboot, Docker reinstall, or nginx purge.</p>
          </div>
          <button onClick={runReconcile} disabled={busy !== ''} className="btn-ghost text-xs disabled:opacity-50">
            {busy === 'reconcile' ? 'Reconciling…' : 'Run Reconcile'}
          </button>
        </div>
        <div className="border-t border-slate-800 pt-3 flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-slate-200 mb-1">Memory &amp; disk optimize</p>
            <p className="text-xs text-slate-500">Compact the append-log database (drops tombstones &amp; old versions), drop kernel page cache, and optionally prune unused Docker images/build cache (never volumes).</p>
            <label className="inline-flex items-center gap-2 mt-2 text-xs text-slate-400">
              <input type="checkbox" checked={dockerPrune} onChange={e => setDockerPrune(e.target.checked)} />
              Also run <code className="font-mono">docker system prune</code>
            </label>
          </div>
          <button onClick={runOptimize} disabled={busy !== ''} className="btn-primary text-xs disabled:opacity-50">
            {busy === 'optimize' ? 'Optimizing…' : 'Optimize Now'}
          </button>
        </div>
        {msg && (
          <div className={clsx('text-xs px-3 py-2 rounded border', msg.kind === 'ok' ? 'bg-green-900/20 border-green-900 text-green-400' : 'bg-red-900/20 border-red-900 text-red-400')}>
            {msg.text}
          </div>
        )}
      </div>
    </section>
  )
}

// ─── Host packages ────────────────────────────────────────────────────────────

function PackagesSection() {
  const [held, setHeld] = useState<string[]>([])
  const [paths, setPaths] = useState('')
  const [out, setOut] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState<string[] | null>(null)

  useEffect(() => { api.packageStatus().then(s => setHeld(s.held ?? [])).catch(() => {}) }, [])

  async function install(force = false) {
    const list = paths.split('\n').map(s => s.trim()).filter(Boolean)
    if (list.length === 0) { setOut('Enter one .deb path per line.'); return }
    setBusy(true); setBlocked(null); setOut('')
    try {
      const r = await api.installPackages(list, force)
      if (r.error && r.protected) { setBlocked(r.protected); setOut(r.error) }
      else setOut(r.output ?? 'done')
    } catch (e) { setOut((e as Error).message) } finally { setBusy(false) }
  }

  async function fixBroken(force = false) {
    setBusy(true); setBlocked(null); setOut('')
    try {
      const r = await api.fixBroken(force)
      if (r.error && r.protected) { setBlocked(r.protected); setOut(r.error) }
      else setOut(r.output ?? 'done')
    } catch (e) { setOut((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <section className="mt-6">
      <p className="section-heading mb-3">Host Packages</p>
      <div className="card space-y-4">
        <div>
          <p className="text-sm font-medium text-slate-200 mb-1">Protected packages</p>
          <p className="text-xs text-slate-500 mb-2">These are held so <code className="font-mono">apt --fix-broken install</code> can never remove Docker or nginx and take containers down.</p>
          <div className="flex flex-wrap gap-1.5">
            {held.length === 0 ? <span className="text-xs text-slate-600">none held yet</span> :
              held.map(p => <span key={p} className="px-2 py-0.5 rounded text-xs bg-slate-800 text-slate-300 font-mono">{p}</span>)}
          </div>
          <button onClick={() => api.ensurePackageHolds().then(r => setHeld(r.held ?? []))} className="btn-ghost text-xs mt-2">Re-assert holds</button>
        </div>
        <div className="border-t border-slate-800 pt-3">
          <p className="text-sm font-medium text-slate-200 mb-1">Install .deb files safely</p>
          <p className="text-xs text-slate-500 mb-2">Simulated first; aborts if a protected package would be removed. One absolute path per line (or filename in <code className="font-mono">/var/offdock/uploads</code>).</p>
          <textarea value={paths} onChange={e => setPaths(e.target.value)} rows={3}
            placeholder="/var/offdock/uploads/myapp.deb"
            className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-slate-700" />
          <div className="flex items-center gap-2 mt-2">
            <button onClick={() => install(false)} disabled={busy} className="btn-primary text-xs disabled:opacity-50">{busy ? 'Working…' : 'Install'}</button>
            <button onClick={() => fixBroken(false)} disabled={busy} className="btn-ghost text-xs disabled:opacity-50">Fix Broken</button>
          </div>
        </div>
        {blocked && (
          <div className="text-xs px-3 py-2 rounded border bg-red-900/20 border-red-900 text-red-400">
            Refused — would remove protected packages: <span className="font-mono">{blocked.join(', ')}</span>.
            <button onClick={() => install(true)} className="ml-2 underline">Force anyway</button>
          </div>
        )}
        {out && <pre className="bg-slate-950 border border-slate-800 rounded p-3 text-xs text-slate-400 overflow-x-auto max-h-48 whitespace-pre-wrap">{out}</pre>}
      </div>
    </section>
  )
}

// ─── Backups ──────────────────────────────────────────────────────────────────

function BackupsSection() {
  const [list, setList] = useState<import('../api/client').BackupRecord[]>([])
  const [sched, setSched] = useState<import('../api/client').BackupSchedule | null>(null)
  const [creating, setCreating] = useState(false)
  const [opts, setOpts] = useState({ scope: 'full', include_volumes: true, include_config: false, encrypt: true })
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const reload = () => api.listBackups().then(b => setList(b ?? [])).catch(() => {})
  useEffect(() => { reload(); api.getBackupSchedule().then(setSched).catch(() => {}) }, [])

  async function create() {
    setCreating(true); setMsg(null)
    try {
      const r = await api.createBackup(opts)
      const note = r.status === 'partial' && r.note ? ` — note: ${r.note}` : ''
      setMsg({ kind: r.status === 'partial' ? 'err' : 'ok', text: `Backup ${r.status} — ${fmtBytes(r.size_bytes)}, ${r.volumes.length} volume(s)${note}` })
      reload()
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }) } finally { setCreating(false) }
  }

  async function restore(id: string) {
    const plan = await api.inspectBackup(id)
    const summary = `Restore will overwrite:\n- ${plan.projects.length} project dir(s)\n- ${plan.volumes.length} volume(s): ${plan.volumes.join(', ') || 'none'}\n- config: ${plan.has_config}\n- database: ${plan.has_db}\n\nProceed? (volumes + projects + config; DB needs a restart)`
    if (!window.confirm(summary)) return
    try {
      const r = await api.restoreBackup(id, { volumes: true, projects: true, config: plan.has_config, nginx: true, certs: true })
      setMsg({ kind: 'ok', text: `Restored: ${r.result.restored_volumes.length} volume(s), ${r.result.restored_projects.length} project(s).${r.warning ? ' ' + r.warning : ''}` })
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }) }
  }

  async function saveSchedule() {
    if (!sched) return
    try { const s = await api.saveBackupSchedule(sched); setSched(s); setMsg({ kind: 'ok', text: 'Schedule saved' }) }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }) }
  }

  return (
    <section className="mt-6">
      <p className="section-heading mb-3">Backups</p>
      <div className="card space-y-4">
        {/* Create */}
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Scope</label>
            <select value={opts.scope} onChange={e => setOpts({ ...opts, scope: e.target.value })}
              className="bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-sm text-slate-200">
              <option value="full">Full (db + projects + certs + nginx)</option>
              <option value="db">Database + projects</option>
              <option value="config">Config only</option>
            </select>
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={opts.include_volumes} onChange={e => setOpts({ ...opts, include_volumes: e.target.checked })} />Volume data</label>
          <label className="inline-flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={opts.include_config} onChange={e => setOpts({ ...opts, include_config: e.target.checked })} />config.yaml</label>
          <label className="inline-flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={opts.encrypt} onChange={e => setOpts({ ...opts, encrypt: e.target.checked })} />Encrypt config</label>
          <button onClick={create} disabled={creating} className="btn-primary text-xs disabled:opacity-50">{creating ? 'Creating…' : 'Create Backup'}</button>
        </div>
        <p className="text-[11px] text-slate-600">
          Volume data is archived directly from the host (<code className="font-mono">/var/lib/docker/volumes</code>) — no helper image needed.
          If a volume can’t be read the backup still completes as <span className="text-amber-500">partial</span> and lists what was skipped.
        </p>

        {msg && <div className={clsx('text-xs px-3 py-2 rounded border', msg.kind === 'ok' ? 'bg-green-900/20 border-green-900 text-green-400' : 'bg-red-900/20 border-red-900 text-red-400')}>{msg.text}</div>}

        {/* List */}
        {list.length > 0 && (
          <div className="border-t border-slate-800 pt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-slate-500 text-left">
                <th className="py-1.5 pr-3">Created</th><th className="pr-3">Scope</th><th className="pr-3">Size</th><th className="pr-3">Volumes</th><th className="pr-3">Status</th><th></th>
              </tr></thead>
              <tbody>
                {list.map(b => (
                  <tr key={b.id} className="border-t border-slate-800/50">
                    <td className="py-1.5 pr-3 text-slate-400">{new Date(b.created_at).toLocaleString()}</td>
                    <td className="pr-3 text-slate-400">{b.scope}{b.sensitive && <span title="contains config.yaml" className="ml-1 text-amber-500">●</span>}</td>
                    <td className="pr-3 text-slate-400 tabular-nums">{fmtBytes(b.size_bytes)}</td>
                    <td className="pr-3 text-slate-500">{b.volumes?.length ?? 0}</td>
                    <td className="pr-3"><span className={clsx(b.status === 'ok' ? 'text-emerald-400' : 'text-amber-400')}>{b.status}</span></td>
                    <td className="text-right whitespace-nowrap">
                      <a href={api.downloadBackupURL(b.id)} className="btn-ghost text-xs">Download</a>
                      <button onClick={() => restore(b.id)} className="btn-ghost text-xs ml-1">Restore</button>
                      <button onClick={() => api.deleteBackup(b.id).then(reload)} className="btn-ghost text-xs ml-1 text-red-400">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Schedule */}
        {sched && (
          <div className="border-t border-slate-800 pt-3">
            <p className="text-sm font-medium text-slate-200 mb-2">Daily schedule</p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="inline-flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={sched.enabled} onChange={e => setSched({ ...sched, enabled: e.target.checked })} />Enabled</label>
              <div><label className="block text-xs text-slate-500 mb-1">Time (24h)</label>
                <input type="time" value={sched.time_of_day} onChange={e => setSched({ ...sched, time_of_day: e.target.value })}
                  className="bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-sm text-slate-200" /></div>
              <div><label className="block text-xs text-slate-500 mb-1">Keep last</label>
                <input type="number" value={sched.retention} onChange={e => setSched({ ...sched, retention: parseInt(e.target.value, 10) || 0 })}
                  className="w-20 bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-sm text-slate-200" /></div>
              <label className="inline-flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={sched.include_volumes} onChange={e => setSched({ ...sched, include_volumes: e.target.checked })} />Volumes</label>
              <label className="inline-flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={sched.include_config} onChange={e => setSched({ ...sched, include_config: e.target.checked })} />config.yaml</label>
              <label className="inline-flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={sched.encrypt} onChange={e => setSched({ ...sched, encrypt: e.target.checked })} />Encrypt</label>
              <div className="flex-1 min-w-[180px]"><label className="block text-xs text-slate-500 mb-1">Off-box copy dir (optional)</label>
                <input type="text" value={sched.dest_path} onChange={e => setSched({ ...sched, dest_path: e.target.value })} placeholder="/mnt/usb/backups"
                  className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-sm text-slate-200" /></div>
              <button onClick={saveSchedule} className="btn-ghost text-xs">Save Schedule</button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

// ─── Terminal command policy ──────────────────────────────────────────────────

function TerminalPolicySection() {
  const [policy, setPolicy] = useState<import('../api/client').TerminalPolicy | null>(null)
  const [defaults, setDefaults] = useState<string[]>([])
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    api.getTerminalPolicy().then(setPolicy).catch(() => {})
    api.getTerminalPolicyDefaults().then(d => setDefaults(d.default_deny ?? [])).catch(() => {})
  }, [])

  function lines(s: string): string[] { return s.split('\n').map(x => x.trim()).filter(Boolean) }

  async function save() {
    if (!policy) return
    try { const p = await api.saveTerminalPolicy(policy); setPolicy(p); setMsg({ kind: 'ok', text: 'Policy saved' }) }
    catch (e) { setMsg({ kind: 'err', text: (e as Error).message }) }
  }

  if (!policy) return null
  return (
    <section className="mt-6">
      <p className="section-heading mb-3">Terminal Command Policy</p>
      <div className="card space-y-4">
        <p className="text-xs text-slate-500">Applied to the non-interactive terminal exec endpoint. Built-in dangerous-command rules (package removal, <code className="font-mono">rm -rf /</code>, fork bombs, disk writes) are always enforced; the lists below are additive.</p>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Mode</label>
          <select value={policy.mode} onChange={e => setPolicy({ ...policy, mode: e.target.value })}
            className="bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-sm text-slate-200">
            <option value="denylist">Denylist (block matches)</option>
            <option value="allowlist">Allowlist (only allow matches)</option>
          </select>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Extra deny (regex, one per line)</label>
            <textarea rows={4} value={(policy.deny ?? []).join('\n')} onChange={e => setPolicy({ ...policy, deny: lines(e.target.value) })}
              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-xs font-mono text-slate-200" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Allowlist (regex, one per line)</label>
            <textarea rows={4} value={(policy.allow ?? []).join('\n')} onChange={e => setPolicy({ ...policy, allow: lines(e.target.value) })}
              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-xs font-mono text-slate-200" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Restricted paths (one per line)</label>
            <textarea rows={4} value={(policy.restricted_paths ?? []).join('\n')} onChange={e => setPolicy({ ...policy, restricted_paths: lines(e.target.value) })}
              placeholder="/etc/ssh&#10;/root/.aws"
              className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-xs font-mono text-slate-200" />
          </div>
        </div>
        <button onClick={save} className="btn-primary text-xs">Save Policy</button>
        {msg && <div className={clsx('text-xs px-3 py-2 rounded border', msg.kind === 'ok' ? 'bg-green-900/20 border-green-900 text-green-400' : 'bg-red-900/20 border-red-900 text-red-400')}>{msg.text}</div>}
        {defaults.length > 0 && (
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer">Built-in denylist ({defaults.length})</summary>
            <pre className="bg-slate-950 border border-slate-800 rounded p-2 mt-2 text-slate-600 overflow-x-auto">{defaults.join('\n')}</pre>
          </details>
        )}
      </div>
    </section>
  )
}

// ─── Self-update ──────────────────────────────────────────────────────────────

function SystemUpdateSection() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [log, setLog] = useState<{ status: string; message: string }[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  const runUpdate = (file: File) => {
    if (!file.name.endsWith('.tar.gz') && !file.name.endsWith('.tgz')) {
      setLog([{ status: 'error', message: 'File must be a .tar.gz archive' }])
      return
    }
    setUploading(true)
    setLog([{ status: 'info', message: `Uploading ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…` }])

    const xhr = new XMLHttpRequest()
    xhr.open('POST', api.systemUpdateUrl())

    xhr.onload = () => {
      setUploading(false)
      if (xhr.status >= 400) {
        setLog(prev => [...prev, { status: 'error', message: `Server error: ${xhr.status}` }])
      }
    }
    xhr.onerror = () => {
      setUploading(false)
      setLog(prev => [...prev, { status: 'info', message: 'Connection closed (service restarting…)' }])
    }

    // Parse SSE lines as they stream in.
    let lastIdx = 0
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 3 && xhr.responseText.length > lastIdx) {
        const chunk = xhr.responseText.slice(lastIdx)
        lastIdx = xhr.responseText.length
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            const ev = JSON.parse(line.slice(5)) as { status: string; message: string }
            setLog(prev => [...prev, ev])
            if (ev.status === 'success') {
              setUploading(false)
              setTimeout(() => window.location.reload(), 5000)
            }
          } catch {}
        }
      }
    }

    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  }

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [log])

  const statusColor = (s: string) => ({
    info:    'text-slate-400',
    success: 'text-emerald-400',
    error:   'text-red-400',
  } as Record<string, string>)[s] ?? 'text-slate-400'

  const statusIcon = (s: string) => ({
    info:    '›',
    success: '✓',
    error:   '✕',
  } as Record<string, string>)[s] ?? '›'

  return (
    <section className="mt-6">
      <p className="section-heading mb-3">System Update</p>
      <div className="card space-y-4">
        <div>
          <p className="text-sm font-medium text-slate-200 mb-1">Update OffDock</p>
          <p className="text-xs text-slate-500 mb-3">
            Upload an OffDock <code className="font-mono text-slate-400">.tar.gz</code> bundle.
            Only the binary is replaced — all data, config, and settings are preserved.
            The service restarts automatically.
          </p>
          {/* Expected structure */}
          <div className="rounded-lg bg-slate-950 border border-slate-800 p-3 mb-1">
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Required bundle structure</p>
            <pre className="text-[11px] text-slate-400 font-mono leading-relaxed">{`offdock-bundle/          ← any folder name
  offdock               ← binary (required — ELF x86-64)
  VERSION               ← version string, e.g. 2026-06-04
  install.sh            ← the ONE script for everything
  offdock.service       ← systemd unit
  debs/                 ← offline packages, by category
    docker/*.deb        ← docker-ce, cli, containerd, compose
    nginx/*.deb         ← nginx core/common/full
    network/*.deb       ← tcpdump, dnsutils, iproute2, iptables…
  images/*.tar          ← preloaded docker images (e.g. alpine)`}</pre>
            <p className="text-[10px] text-slate-600 mt-2">
              The UI update only uses the <code className="font-mono">offdock</code> binary.
              For a full offline install with packages, use <code className="font-mono">install.sh</code> on the host (see below).
            </p>
          </div>

          {/* install.sh flags — one script for everything */}
          <div className="rounded-lg bg-slate-950 border border-slate-800 p-3 mb-1">
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">install.sh — one script, all operations</p>
            <pre className="text-[11px] text-slate-400 font-mono leading-relaxed">{`bash install.sh --bundle             # build the offline tar.gz (no root)
sudo bash install.sh --full --domain D  # full offline install (docker+nginx+tools)
sudo bash install.sh                  # interactive install
sudo bash install.sh --update         # replace binary + restart
sudo bash install.sh --restore A.tar.gz  # restore a backup (db+volumes+config)
sudo bash install.sh --uninstall      # remove (keeps /var/offdock data)`}</pre>
            <p className="text-[10px] text-slate-600 mt-2">
              <code className="font-mono">--full</code> installs Docker, nginx and network tools from the bundled
              <code className="font-mono"> debs/</code>, loads <code className="font-mono">images/</code>, holds core packages so
              <code className="font-mono"> apt --fix-broken</code> can never remove them, verifies everything works, and starts OffDock.
              See the <a href="/docs" className="text-blue-400">Docs</a> page for the full deploy guide (downloadable as PDF).
            </p>
          </div>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault(); setDragOver(false)
            const f = e.dataTransfer.files[0]
            if (f) runUpdate(f)
          }}
          onClick={() => !uploading && fileRef.current?.click()}
          className={clsx(
            'relative flex flex-col items-center justify-center gap-2 p-8 rounded-xl border-2 border-dashed cursor-pointer transition-all',
            dragOver ? 'border-blue-500 bg-blue-500/5' : 'border-slate-700 hover:border-slate-600 hover:bg-slate-800/30',
            uploading && 'pointer-events-none opacity-60',
          )}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".tar.gz,.tgz"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) { runUpdate(f); e.target.value = '' } }}
          />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-8 h-8 text-slate-600">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.338-2.323 3.75 3.75 0 013.543 4.098A3.75 3.75 0 0118.75 19.5H6.75z" />
          </svg>
          {uploading ? (
            <p className="text-sm text-blue-400 font-medium">Updating…</p>
          ) : (
            <>
              <p className="text-sm text-slate-300 font-medium">Drop <code className="font-mono">offdock-offline-*.tar.gz</code> here</p>
              <p className="text-xs text-slate-600">or click to browse — safe atomic update, no data loss</p>
            </>
          )}
        </div>

        {/* Update log */}
        {log.length > 0 && (
          <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 max-h-48 overflow-y-auto">
            {log.map((l, i) => (
              <div key={i} className={clsx('font-mono text-xs flex gap-2', statusColor(l.status))}>
                <span className="shrink-0">{statusIcon(l.status)}</span>
                <span>{l.message}</span>
              </div>
            ))}
            {uploading && <div className="font-mono text-xs text-blue-400 animate-pulse">▌</div>}
            <div ref={logEndRef} />
          </div>
        )}

        <p className="text-xs text-slate-700">
          The update replaces the binary, refreshes the bundled OpenTelemetry tracers
          (<code className="font-mono">/var/offdock/otel</code>) if the archive includes them, then restarts the service.
          All data, configuration, and settings are preserved. Running
          <code className="font-mono"> sudo bash install.sh --update</code> on the server does the same thing,
          and also installs any missing bundled <code className="font-mono">.deb</code> packages (docker, nginx, tcpdump).
        </p>
      </div>
    </section>
  )
}

// ─── Scheduled self-update ────────────────────────────────────────────────────

type ScheduledUpdateStatus = Awaited<ReturnType<typeof api.getScheduledUpdate>>

// toLocalInputValue formats a Date as the naive "YYYY-MM-DDTHH:mm" string that
// <input type="datetime-local"> expects, in the browser's local time zone
// (the input has no time zone of its own — new Date(value) below interprets
// it as local time too, so the round trip stays consistent).
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function ScheduledUpdateSection() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [log, setLog] = useState<{ status: string; message: string }[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [runAt, setRunAt] = useState('')
  const [pending, setPending] = useState<ScheduledUpdateStatus | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  const refresh = () => {
    api.getScheduledUpdate().then(setPending).catch(() => {}).finally(() => setLoadingStatus(false))
  }

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 30000)
    return () => clearInterval(id)
  }, [])

  const runScheduledUpdate = (file: File) => {
    if (!file.name.endsWith('.tar.gz') && !file.name.endsWith('.tgz')) {
      setLog([{ status: 'error', message: 'File must be a .tar.gz archive' }])
      return
    }
    if (!runAt) {
      setLog([{ status: 'error', message: 'Pick a date and time to install the update first' }])
      return
    }

    setUploading(true)
    setLog([{ status: 'info', message: `Uploading ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…` }])

    const xhr = new XMLHttpRequest()
    xhr.open('POST', api.scheduleUpdateUrl())

    xhr.onload = () => {
      setUploading(false)
      if (xhr.status >= 400) {
        setLog(prev => [...prev, { status: 'error', message: `Server error: ${xhr.status}` }])
      }
    }
    xhr.onerror = () => {
      setUploading(false)
      setLog(prev => [...prev, { status: 'error', message: 'Upload failed — connection error' }])
    }

    let lastIdx = 0
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 3 && xhr.responseText.length > lastIdx) {
        const chunk = xhr.responseText.slice(lastIdx)
        lastIdx = xhr.responseText.length
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            const ev = JSON.parse(line.slice(5)) as { status: string; message: string }
            setLog(prev => [...prev, ev])
            if (ev.status === 'success') {
              setUploading(false)
              setRunAt('')
              refresh()
            }
          } catch {}
        }
      }
    }

    const form = new FormData()
    form.append('file', file)
    // Convert the naive local datetime-local value to an absolute instant —
    // new Date() on a "YYYY-MM-DDTHH:mm" string parses it as local time,
    // and toISOString() gives the unambiguous UTC instant the server expects.
    form.append('run_at', new Date(runAt).toISOString())
    xhr.send(form)
  }

  const cancelScheduled = () => {
    setCancelling(true)
    api.cancelScheduledUpdate()
      .then(() => { setConfirmCancel(false); setLog([]); refresh() })
      .finally(() => setCancelling(false))
  }

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [log])

  const statusColor = (s: string) => ({
    info:    'text-slate-400',
    success: 'text-emerald-400',
    error:   'text-red-400',
  } as Record<string, string>)[s] ?? 'text-slate-400'

  const statusIcon = (s: string) => ({
    info:    '›',
    success: '✓',
    error:   '✕',
  } as Record<string, string>)[s] ?? '›'

  // Mirrors the server's "must be at least 2 minutes from now" requirement —
  // shown as the picker's floor so the browser enforces it up front too.
  const minDateTime = toLocalInputValue(new Date(Date.now() + 2 * 60 * 1000))

  return (
    <section className="mt-6">
      <p className="section-heading mb-3">Scheduled Update</p>
      <div className="card space-y-4">
        <p className="text-xs text-slate-500">
          Upload a bundle now and OffDock will install it — replacing only the binary, then restarting —
          automatically at a time you choose. The job is handed off to the host's OS scheduler, so it still
          runs even if OffDock itself restarts or crashes before then.
        </p>

        {!loadingStatus && pending?.scheduled ? (
          <div className="rounded-xl border border-blue-900/50 bg-blue-500/5 p-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-200">
                  Update scheduled for {pending.run_at ? new Date(pending.run_at).toLocaleString() : '—'}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {pending.filename}
                  {pending.version ? ` · version ${pending.version}` : ''}
                  {pending.uploaded_by ? ` · uploaded by ${pending.uploaded_by}` : ''}
                </p>
                <p className="text-xs mt-1.5 flex items-center gap-1.5">
                  <span className={clsx('w-1.5 h-1.5 rounded-full', pending.active ? 'bg-emerald-400' : 'bg-amber-400')} />
                  <span className={pending.active ? 'text-emerald-400' : 'text-amber-400'}>
                    {pending.active ? 'Armed — will install and restart automatically' : 'Not armed — it may have already run, or scheduling failed'}
                  </span>
                </p>
              </div>
              {!confirmCancel ? (
                <button onClick={() => setConfirmCancel(true)} className="btn-ghost text-xs shrink-0">
                  Cancel scheduled update
                </button>
              ) : (
                <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                  <span className="text-xs text-slate-500">Discard the staged update?</span>
                  <button onClick={cancelScheduled} disabled={cancelling} className="btn-danger text-xs disabled:opacity-50">
                    {cancelling ? 'Cancelling…' : 'Yes, cancel it'}
                  </button>
                  <button onClick={() => setConfirmCancel(false)} className="btn-ghost text-xs">Keep it</button>
                </div>
              )}
            </div>
          </div>
        ) : !loadingStatus && (
          <>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Install at</label>
              <input
                type="datetime-local"
                value={runAt}
                min={minDateTime}
                onChange={e => setRunAt(e.target.value)}
                className="bg-slate-900 border border-slate-800 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-slate-700"
              />
              <p className="text-xs text-slate-700 mt-1">Must be at least a couple of minutes from now.</p>
            </div>

            {/* Drop zone */}
            <div
              onDragOver={e => { if (runAt) { e.preventDefault(); setDragOver(true) } }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => {
                e.preventDefault(); setDragOver(false)
                if (!runAt) return
                const f = e.dataTransfer.files[0]
                if (f) runScheduledUpdate(f)
              }}
              onClick={() => !uploading && runAt && fileRef.current?.click()}
              className={clsx(
                'relative flex flex-col items-center justify-center gap-2 p-8 rounded-xl border-2 border-dashed transition-all',
                !runAt && 'cursor-not-allowed opacity-50 border-slate-800',
                runAt && !dragOver && 'cursor-pointer border-slate-700 hover:border-slate-600 hover:bg-slate-800/30',
                runAt && dragOver && 'cursor-pointer border-blue-500 bg-blue-500/5',
                uploading && 'pointer-events-none opacity-60',
              )}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".tar.gz,.tgz"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) { runScheduledUpdate(f); e.target.value = '' } }}
              />
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-8 h-8 text-slate-600">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v8m4-4H8m9 8H7a2 2 0 01-2-2V6a2 2 0 012-2h6l4 4v10a2 2 0 01-2 2z" />
              </svg>
              {uploading ? (
                <p className="text-sm text-blue-400 font-medium">Uploading & staging…</p>
              ) : runAt ? (
                <>
                  <p className="text-sm text-slate-300 font-medium">Drop <code className="font-mono">offdock-offline-*.tar.gz</code> here to schedule</p>
                  <p className="text-xs text-slate-600">or click to browse</p>
                </>
              ) : (
                <p className="text-sm text-slate-500 font-medium">Pick an install time above first</p>
              )}
            </div>
          </>
        )}

        {/* Schedule log */}
        {log.length > 0 && (
          <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 max-h-48 overflow-y-auto">
            {log.map((l, i) => (
              <div key={i} className={clsx('font-mono text-xs flex gap-2', statusColor(l.status))}>
                <span className="shrink-0">{statusIcon(l.status)}</span>
                <span>{l.message}</span>
              </div>
            ))}
            {uploading && <div className="font-mono text-xs text-blue-400 animate-pulse">▌</div>}
            <div ref={logEndRef} />
          </div>
        )}

        {/* Most recent completed scheduled update, if any */}
        {pending?.last_result && (
          <details className="text-xs">
            <summary className={clsx('cursor-pointer select-none font-medium', pending.last_result === 'ok' ? 'text-emerald-400' : 'text-red-400')}>
              {pending.last_result === 'ok' ? '✓ Last scheduled update completed successfully' : '✕ Last scheduled update failed'} — view log
            </summary>
            <pre className="mt-2 bg-slate-950 border border-slate-800 rounded p-3 text-[11px] text-slate-500 font-mono whitespace-pre-wrap overflow-x-auto">{pending.last_log}</pre>
          </details>
        )}

        <p className="text-xs text-slate-700">
          Same safe binary-only swap as the immediate update above — only deferred. Scheduling a new update
          replaces any update already pending.
        </p>
      </div>
    </section>
  )
}
