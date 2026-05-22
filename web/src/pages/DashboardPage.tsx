import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, Project, SystemStats, RecentDeployment, ContainerStats } from '../api/client'
import clsx from 'clsx'

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtBytes(b: number) {
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`
  if (b >= 1e9)  return `${(b / 1e9).toFixed(1)} GB`
  if (b >= 1e6)  return `${(b / 1e6).toFixed(1)} MB`
  return `${(b / 1e3).toFixed(0)} KB`
}
function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
function dur(a: string, b: string | null) {
  if (!b) return '—'
  const s = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
function uptime(secs: number) {
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// ─── Animated sparkline (last 30 values) ─────────────────────────────────────
function Sparkline({ values, color = '#3b82f6' }: { values: number[]; color?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || values.length < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    const max = Math.max(...values, 1)
    const step = w / (values.length - 1)
    ctx.beginPath()
    values.forEach((v, i) => {
      const x = i * step
      const y = h - (v / max) * h
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.stroke()
    // Fill area under line
    ctx.lineTo((values.length - 1) * step, h)
    ctx.lineTo(0, h)
    ctx.closePath()
    ctx.fillStyle = color + '18'
    ctx.fill()
  }, [values, color])
  return <canvas ref={canvasRef} width={120} height={32} className="w-full h-8" />
}

// ─── Stat card ───────────────────────────────────────────────────────────────
function StatCard({
  label, value, sub, pct, sparkValues, sparkColor, alert,
}: {
  label: string
  value: string
  sub: string
  pct?: number
  sparkValues?: number[]
  sparkColor?: string
  alert?: boolean
}) {
  return (
    <div className={clsx('card flex-1 min-w-0', alert && 'border-red-900/50')}>
      <div className="flex items-start justify-between mb-2">
        <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</span>
        {pct !== undefined && (
          <span className={clsx(
            'text-xs font-bold tabular-nums',
            pct > 85 ? 'text-red-400' : pct > 65 ? 'text-yellow-400' : 'text-gray-300'
          )}>{pct}%</span>
        )}
      </div>
      <p className="text-xl font-bold text-white tabular-nums mb-1">{value}</p>
      <p className="text-xs text-gray-600 mb-2">{sub}</p>
      {pct !== undefined && (
        <div className="h-1 bg-gray-800 rounded-full overflow-hidden mb-2">
          <div
            className={clsx('h-full rounded-full transition-all duration-700',
              pct > 85 ? 'bg-red-500' : pct > 65 ? 'bg-yellow-500' : 'bg-blue-500'
            )}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
      )}
      {sparkValues && sparkValues.length > 1 && (
        <Sparkline values={sparkValues} color={sparkColor} />
      )}
    </div>
  )
}

// ─── Status helpers ───────────────────────────────────────────────────────────
const STATUS_DOT: Record<string, string> = {
  running: 'bg-green-400 animate-pulse',
  stopped: 'bg-gray-500',
  error: 'bg-red-400 animate-pulse',
  degraded: 'bg-yellow-400',
}
const STATUS_BADGE: Record<string, string> = {
  running: 'badge-running',
  stopped: 'badge-stopped',
  error: 'badge-error',
  degraded: 'badge-degraded',
}
const DEP_BADGE: Record<string, string> = {
  pending: 'badge-pending',
  running: 'badge-pending',
  success: 'badge-running',
  failed: 'badge-error',
  cancelled: 'badge-stopped',
}

// ─── Project card ─────────────────────────────────────────────────────────────
function ProjectCard({ project, onDeploy }: { project: Project; onDeploy: (id: string) => void }) {
  return (
    <div className="card flex flex-col gap-3 hover:border-gray-700 transition-all group">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={clsx('w-2 h-2 rounded-full shrink-0', STATUS_DOT[project.status] ?? 'bg-gray-500')} />
            <Link to={`/projects/${project.id}`}
              className="font-semibold text-gray-100 hover:text-white text-sm truncate transition-colors">
              {project.name}
            </Link>
          </div>
          {project.description && (
            <p className="text-xs text-gray-600 truncate pl-4">{project.description}</p>
          )}
        </div>
        <span className={STATUS_BADGE[project.status] ?? 'badge-stopped'}>{project.status}</span>
      </div>

      <div className="flex items-center gap-1.5 pt-1 border-t border-gray-800">
        <button onClick={() => onDeploy(project.id)}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 hover:bg-blue-950/40 rounded-lg transition-colors border border-transparent hover:border-blue-900/40">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
            <path d="M3 3.5A1.5 1.5 0 014.5 2h7A1.5 1.5 0 0113 3.5v9a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 12.5v-9zM5 8l4-2.5V10.5L5 8z"/>
          </svg>
          Deploy
        </button>
        <Link to={`/projects/${project.id}`}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-lg transition-colors">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 3H3v10h10V8M8 3l5 5M8 3h5v5"/>
          </svg>
          Open
        </Link>
        <Link to="/containers"
          className="flex items-center justify-center px-2.5 py-1.5 text-gray-600 hover:text-gray-300 hover:bg-gray-800 rounded-lg transition-colors"
          title="View containers">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 2L14 5v6l-6 3L2 11V5l6-3z"/>
          </svg>
        </Link>
      </div>
    </div>
  )
}

// ─── Deploy modal ─────────────────────────────────────────────────────────────
function DeployModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [deploying, setDeploying] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [log, setLog] = useState<string[]>(['Starting deployment…'])
  const [activeDepId, setActiveDepId] = useState('')
  const [done, setDone] = useState(false)
  const [success, setSuccess] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  useEffect(() => {
    let es: EventSource | null = null
    setDeploying(true)

    api.triggerDeploy(projectId).then(({ deployment_id }) => {
      setActiveDepId(deployment_id)
      es = new EventSource(`/api/v1/projects/${projectId}/deployments/${deployment_id}/stream`)
      es.onmessage = e => {
        try {
          const d = JSON.parse(e.data as string) as Record<string, string>
          if (d.log) setLog(prev => [...prev, d.log])
          if (d.error) setLog(prev => [...prev, `✗ ${d.error}`])
          if (d.status) {
            const ok = d.status === 'success'
            setSuccess(ok)
            setLog(prev => [...prev, ok ? '✓ Deployment complete' : `✗ Deployment ${d.status}`])
            setDeploying(false); setDone(true); es?.close()
          }
        } catch {}
      }
      es.onerror = () => { setDeploying(false); setDone(true); es?.close() }
    }).catch(e => {
      setLog(['✗ ' + (e instanceof Error ? e.message : 'unknown error')])
      setDeploying(false); setDone(true)
    })

    return () => es?.close()
  }, [projectId])

  const cancel = async () => {
    if (!activeDepId || cancelling) return
    setCancelling(true)
    try {
      await api.cancelDeploy(projectId, activeDepId)
      setLog(prev => [...prev, '⚠ Cancellation requested…'])
    } catch {}
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl flex flex-col shadow-2xl" style={{ maxHeight: '80vh' }}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-2">
            {deploying ? (
              <svg className="animate-spin w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            ) : done ? (
              <div className={`w-4 h-4 rounded-full flex items-center justify-center text-xs ${success ? 'bg-green-600' : 'bg-red-600'}`}>
                {success ? '✓' : '✗'}
              </div>
            ) : null}
            <span className="text-sm font-semibold text-white">
              {deploying ? 'Deploying…' : done ? (success ? 'Deployed successfully' : 'Deployment failed') : 'Deploy'}
            </span>
          </div>
          <div className="flex gap-2">
            {deploying && (
              <button onClick={cancel} disabled={cancelling}
                className="text-xs text-gray-500 hover:text-red-400 px-3 py-1.5 border border-gray-700 hover:border-red-900/60 rounded-lg transition-colors disabled:opacity-40">
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
            {done && <button onClick={onClose} className="btn-ghost text-xs">Close</button>}
          </div>
        </div>
        <div ref={logRef} className="flex-1 overflow-y-auto min-h-0 terminal p-4 text-green-400 text-xs leading-relaxed">
          {log.map((l, i) => (
            <div key={i} className={
              l.startsWith('✗') || l.includes('FAILED') ? 'text-red-400' :
              l.startsWith('✓') || l.includes('complete') ? 'text-green-300 font-medium' :
              l.match(/\[\d+\/\d+\]/) ? 'text-blue-300 font-medium' :
              l.startsWith('⚠') ? 'text-yellow-400' :
              l.startsWith('  ') ? 'text-gray-500' : ''
            }>{l || ' '}</div>
          ))}
          {deploying && <span className="animate-pulse text-blue-400">▌</span>}
        </div>
      </div>
    </div>
  )
}

// ─── Container health mini-panel ──────────────────────────────────────────────
function ContainerHealthPanel({ containers }: { containers: ContainerStats[] }) {
  if (containers.length === 0) return null
  const top5 = containers.slice(0, 5)
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <p className="section-heading">Top Containers</p>
        <Link to="/containers" className="text-xs text-gray-600 hover:text-gray-300 transition-colors">
          View all →
        </Link>
      </div>
      <div className="space-y-2">
        {top5.map(c => {
          const cpu = parseFloat(c.CPUPerc)
          const mem = parseFloat(c.MemPerc)
          return (
            <div key={c.name} className="flex items-center gap-3">
              <span className="text-xs font-mono text-gray-400 truncate w-32 shrink-0">{c.name}</span>
              <div className="flex-1 flex items-center gap-1.5">
                <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={clsx('h-full rounded-full', cpu > 70 ? 'bg-red-500' : 'bg-blue-500')}
                    style={{ width: `${Math.min(cpu, 100)}%` }}
                  />
                </div>
                <span className="text-xs text-gray-600 w-9 tabular-nums">{c.CPUPerc}</span>
              </div>
              <div className="flex-1 flex items-center gap-1.5">
                <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={clsx('h-full rounded-full', mem > 70 ? 'bg-yellow-500' : 'bg-green-500')}
                    style={{ width: `${Math.min(mem, 100)}%` }}
                  />
                </div>
                <span className="text-xs text-gray-600 w-9 tabular-nums">{c.MemPerc}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Quick actions ────────────────────────────────────────────────────────────
function QuickActions() {
  return (
    <div className="card">
      <p className="section-heading mb-3">Quick Actions</p>
      <div className="grid grid-cols-2 gap-2">
        {[
          { to: '/projects/new', label: 'New Project', icon: '＋', color: 'text-blue-400' },
          { to: '/containers',   label: 'Containers',   icon: '◈', color: 'text-green-400' },
          { to: '/proxy',        label: 'Proxy Hosts',  icon: '⇄', color: 'text-purple-400' },
          { to: '/terminal',     label: 'Terminal',     icon: '$', color: 'text-yellow-400' },
          { to: '/images',       label: 'Images',       icon: '⬡', color: 'text-cyan-400' },
          { to: '/usb',          label: 'Import USB',   icon: '⏏', color: 'text-orange-400' },
        ].map(a => (
          <Link key={a.to} to={a.to}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/50 hover:bg-gray-800 border border-gray-800 hover:border-gray-700 transition-all">
            <span className={clsx('text-sm font-mono shrink-0', a.color)}>{a.icon}</span>
            <span className="text-xs text-gray-400">{a.label}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const HISTORY_LEN = 30

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [recent, setRecent] = useState<RecentDeployment[]>([])
  const [deployingProject, setDeployingProject] = useState<string | null>(null)
  const [expandedDep, setExpandedDep] = useState<string | null>(null)
  const [cpuHistory, setCpuHistory] = useState<number[]>([])
  const [ramHistory, setRamHistory] = useState<number[]>([])

  useEffect(() => {
    api.listProjects().then(d => setProjects(d ?? [])).catch(() => {})
    api.listAllDeployments().then(d => setRecent(d ?? [])).catch(() => {})

    const es = new EventSource('/api/v1/system/stats')
    es.onmessage = e => {
      try {
        const s = JSON.parse(e.data as string) as SystemStats
        setStats(s)
        setCpuHistory(h => [...h.slice(-(HISTORY_LEN - 1)), Math.round(s.cpu_percent)])
        setRamHistory(h => [...h.slice(-(HISTORY_LEN - 1)), Math.round((s.ram_used_bytes / s.ram_total_bytes) * 100)])
      } catch {}
    }
    es.onerror = () => es.close()
    return () => es.close()
  }, [])

  const running  = projects.filter(p => p.status === 'running').length
  const errored  = projects.filter(p => p.status === 'error').length
  const stopped  = projects.filter(p => p.status === 'stopped').length
  const cpuPct   = stats ? Math.round(stats.cpu_percent) : 0
  const ramPct   = stats ? Math.round((stats.ram_used_bytes / stats.ram_total_bytes) * 100) : 0
  const diskPct  = stats ? Math.round((stats.disk_used_bytes / stats.disk_total_bytes) * 100) : 0

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {deployingProject && (
        <DeployModal projectId={deployingProject} onClose={() => {
          setDeployingProject(null)
          api.listProjects().then(d => setProjects(d ?? [])).catch(() => {})
          api.listAllDeployments().then(d => setRecent(d ?? [])).catch(() => {})
        }} />
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-white">Dashboard</h1>
          <p className="text-xs text-gray-600 mt-0.5">
            {projects.length} project{projects.length !== 1 ? 's' : ''}
            {running > 0 && <> · <span className="text-green-400">{running} running</span></>}
            {errored > 0 && <> · <span className="text-red-400">{errored} error{errored !== 1 ? 's' : ''}</span></>}
            {stopped > 0 && <> · <span className="text-gray-500">{stopped} stopped</span></>}
            {stats && <> · <span className="text-gray-600">up {uptime(stats.uptime_secs)}</span></>}
          </p>
        </div>
        <Link to="/projects/new" className="btn-primary">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
          </svg>
          New Project
        </Link>
      </div>

      {/* System stats row */}
      {stats ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard
            label="CPU"
            value={`${cpuPct}%`}
            sub={`Load ${stats.load_avg[0].toFixed(2)} · ${stats.load_avg[1].toFixed(2)} · ${stats.load_avg[2].toFixed(2)}`}
            pct={cpuPct}
            sparkValues={cpuHistory}
            sparkColor={cpuPct > 80 ? '#ef4444' : '#3b82f6'}
            alert={cpuPct > 90}
          />
          <StatCard
            label="Memory"
            value={fmtBytes(stats.ram_used_bytes)}
            sub={`of ${fmtBytes(stats.ram_total_bytes)} total`}
            pct={ramPct}
            sparkValues={ramHistory}
            sparkColor={ramPct > 80 ? '#f59e0b' : '#10b981'}
            alert={ramPct > 90}
          />
          <StatCard
            label="Disk"
            value={fmtBytes(stats.disk_used_bytes)}
            sub={`of ${fmtBytes(stats.disk_total_bytes)} · ${diskPct}% used`}
            pct={diskPct}
            alert={diskPct > 90}
          />
          <StatCard
            label="Containers"
            value={String((stats.containers ?? []).length)}
            sub={`${(stats.containers ?? []).filter(c => !c.CPUPerc.startsWith('0.00')).length} active`}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {['CPU', 'Memory', 'Disk', 'Containers'].map(l => (
            <div key={l} className="card animate-pulse">
              <div className="text-xs text-gray-700 mb-2">{l}</div>
              <div className="h-6 bg-gray-800 rounded w-16 mb-1" />
              <div className="h-3 bg-gray-800 rounded w-24" />
            </div>
          ))}
        </div>
      )}

      {/* Main content grid */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Projects — takes 2 columns */}
        <section className="xl:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <p className="section-heading">Projects</p>
            <span className="text-xs text-gray-600">{projects.length} total</span>
          </div>

          {projects.length === 0 ? (
            <div className="card text-center py-12 border-dashed">
              <div className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center mx-auto mb-3">
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-gray-600">
                  <path d="M2 4a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1V4zM11 4a1 1 0 011-1h5a1 1 0 011 1v2a1 1 0 01-1 1h-5a1 1 0 01-1-1V4zM11 11a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1h-5a1 1 0 01-1-1v-5zM2 11a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5z"/>
                </svg>
              </div>
              <p className="text-gray-500 text-sm mb-1">No projects yet</p>
              <p className="text-gray-700 text-xs mb-4">Create a project to start managing deployments</p>
              <Link to="/projects/new" className="btn-primary">Create your first project</Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {projects.map(p => (
                <ProjectCard key={p.id} project={p} onDeploy={id => setDeployingProject(id)} />
              ))}
            </div>
          )}

          {/* Container health */}
          {stats && (stats.containers ?? []).length > 0 && (
            <ContainerHealthPanel containers={stats.containers ?? []} />
          )}
        </section>

        {/* Right sidebar */}
        <section className="space-y-4">
          <QuickActions />

          {/* Recent deployments */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="section-heading">Recent Deployments</p>
              <span className="text-xs text-gray-600">{recent.length}</span>
            </div>
            {recent.length === 0 ? (
              <div className="card text-center py-8 border-dashed text-gray-600 text-xs">No deployments yet</div>
            ) : (
              <div className="space-y-1">
                {recent.slice(0, 10).map(d => (
                  <div key={d.id}>
                    <div
                      className="card p-3 cursor-pointer hover:border-gray-700 transition-all"
                      onClick={() => setExpandedDep(expandedDep === d.id ? null : d.id)}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className={DEP_BADGE[d.status] ?? 'badge-stopped'}>{d.status}</span>
                        <span className="text-xs text-gray-600 tabular-nums">{timeAgo(d.started_at)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <Link to={`/projects/${d.project_id}`}
                          onClick={e => e.stopPropagation()}
                          className="text-xs text-gray-300 hover:text-white transition-colors font-medium truncate">
                          {d.project_name || d.project_id}
                        </Link>
                        <span className="text-xs text-gray-600 font-mono shrink-0">
                          v{d.new_compose_version} · {dur(d.started_at, d.finished_at)}
                        </span>
                      </div>
                    </div>

                    {expandedDep === d.id && d.log_text && (
                      <div className="terminal p-3 text-green-400 text-xs max-h-32 overflow-y-auto -mt-px rounded-t-none border-t-0">
                        {d.log_text.split('\n').slice(-20).map((l, i) => (
                          <div key={i} className={
                            l.includes('FAILED') || l.startsWith('✗') ? 'text-red-400' :
                            l.match(/\[\d+\/\d+\]/) ? 'text-blue-300' :
                            l.includes('complete') ? 'text-green-300' :
                            l.startsWith('  ') ? 'text-gray-600' : ''
                          }>{l || ' '}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
