import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, Project, SystemStats, RecentDeployment, ContainerStats } from '../api/client'
import clsx from 'clsx'
import {
  LayoutDashboard, Plus, Cpu, MemoryStick, HardDrive, Container as ContainerIcon,
  Play, ExternalLink, Rocket, Search, ChevronLeft, ChevronRight, X, Loader2,
  CheckCircle2, XCircle, Boxes, Globe, TerminalSquare, FolderTree,
} from 'lucide-react'
import { Page, PageHeader, StatCard, Panel, EmptyState, ProjectBadge, DeploymentBadge } from '../components/ui'
import { formatBytes, formatUptime, timeAgo, parsePercent } from '../lib/format'

// ─── Sparkline (kept — lightweight canvas trend) ──────────────────────────────
function Sparkline({ values, color = '#3b82f6' }: { values: number[]; color?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || values.length < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width, h = canvas.height
    ctx.clearRect(0, 0, w, h)
    const max = Math.max(...values, 1)
    const step = w / (values.length - 1)
    ctx.beginPath()
    values.forEach((v, i) => {
      const x = i * step, y = h - (v / max) * (h - 2) - 1
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke()
    ctx.lineTo((values.length - 1) * step, h); ctx.lineTo(0, h); ctx.closePath()
    ctx.fillStyle = color + '1a'; ctx.fill()
  }, [values, color])
  return <canvas ref={canvasRef} width={140} height={28} className="w-full h-7 mt-2" />
}

function dur(a: string, b: string | null) {
  if (!b) return '—'
  const s = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

// ─── Project card ─────────────────────────────────────────────────────────────
function ProjectCard({ project, onDeploy }: { project: Project; onDeploy: (id: string) => void }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-all flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/projects/${project.id}`} className="min-w-0 group">
          <p className="font-semibold text-slate-100 group-hover:text-white text-sm truncate transition-colors">{project.name}</p>
          {project.description && <p className="text-xs text-slate-500 truncate mt-0.5">{project.description}</p>}
        </Link>
        <ProjectBadge status={project.status} />
      </div>
      <div className="flex items-center gap-1.5 pt-2 border-t border-slate-800">
        <button onClick={() => onDeploy(project.id)}
          className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 rounded-lg transition-colors">
          <Play className="w-3.5 h-3.5" /> Deploy
        </button>
        <Link to={`/projects/${project.id}`}
          className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors">
          <ExternalLink className="w-3.5 h-3.5" /> Open
        </Link>
      </div>
    </div>
  )
}

// ─── Deploy modal (streams logs over SSE) ─────────────────────────────────────
function DeployModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [deploying, setDeploying] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [log, setLog] = useState<string[]>(['Starting deployment…'])
  const [activeDepId, setActiveDepId] = useState('')
  const [done, setDone] = useState(false)
  const [success, setSuccess] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [log])

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
    try { await api.cancelDeploy(projectId, activeDepId); setLog(prev => [...prev, '⚠ Cancellation requested…']) } catch {}
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4 animate-fadeIn" onClick={done ? onClose : undefined}>
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl flex flex-col shadow-2xl animate-scaleIn max-h-[80vh]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5">
            {deploying ? <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
              : done ? (success ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-red-400" />)
              : <Rocket className="w-4 h-4 text-blue-400" />}
            <span className="text-sm font-semibold text-slate-100">
              {deploying ? 'Deploying…' : done ? (success ? 'Deployed successfully' : 'Deployment failed') : 'Deploy'}
            </span>
          </div>
          <div className="flex gap-2">
            {deploying && (
              <button onClick={cancel} disabled={cancelling}
                className="text-xs text-slate-400 hover:text-red-400 px-3 py-1.5 border border-slate-700 hover:border-red-500/40 rounded-lg transition-colors disabled:opacity-40">
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
            {done && <button onClick={onClose} className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800"><X className="w-5 h-5" /></button>}
          </div>
        </div>
        <div ref={logRef} className="flex-1 overflow-y-auto min-h-0 font-mono text-xs bg-slate-950 p-4 leading-relaxed">
          {log.map((l, i) => (
            <div key={i} className={
              l.startsWith('✗') || l.includes('FAILED') ? 'text-red-400' :
              l.startsWith('✓') || l.includes('complete') ? 'text-emerald-300 font-medium' :
              l.match(/\[\d+\/\d+\]/) ? 'text-blue-300 font-medium' :
              l.startsWith('⚠') ? 'text-amber-400' :
              l.startsWith('  ') ? 'text-slate-500' : 'text-slate-300'
            }>{l || ' '}</div>
          ))}
          {deploying && <span className="animate-pulse text-blue-400">▌</span>}
        </div>
      </div>
    </div>
  )
}

// ─── Quick actions ────────────────────────────────────────────────────────────
const QUICK = [
  { to: '/projects/new', label: 'New Project', icon: Plus,          tone: 'text-blue-400' },
  { to: '/containers',   label: 'Containers',  icon: ContainerIcon, tone: 'text-emerald-400' },
  { to: '/proxy',        label: 'Proxy Hosts', icon: Globe,         tone: 'text-violet-400' },
  { to: '/terminal',     label: 'Terminal',    icon: TerminalSquare,tone: 'text-amber-400' },
  { to: '/images',       label: 'Images',      icon: Boxes,         tone: 'text-cyan-400' },
  { to: '/files',        label: 'Files',       icon: FolderTree,    tone: 'text-slate-300' },
]

// ─── Container health mini-panel ──────────────────────────────────────────────
function ContainerHealth({ containers }: { containers: ContainerStats[] }) {
  const top = containers.slice(0, 6)
  return (
    <div className="space-y-2.5 p-4">
      {top.map(c => {
        const cpu = parsePercent(c.CPUPerc), mem = parsePercent(c.MemPerc)
        return (
          <div key={c.name} className="flex items-center gap-3">
            <span className="text-xs font-mono text-slate-400 truncate w-36 shrink-0">{c.name}</span>
            <div className="flex-1 flex items-center gap-1.5">
              <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div className={clsx('h-full rounded-full', cpu > 70 ? 'bg-red-500' : 'bg-blue-500')} style={{ width: `${Math.min(cpu, 100)}%` }} />
              </div>
              <span className="text-[11px] text-slate-500 w-12 tabular-nums text-right">{c.CPUPerc}</span>
            </div>
            <div className="flex-1 flex items-center gap-1.5">
              <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div className={clsx('h-full rounded-full', mem > 70 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(mem, 100)}%` }} />
              </div>
              <span className="text-[11px] text-slate-500 w-12 tabular-nums text-right">{c.MemPerc}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const HISTORY_LEN = 30
const PROJECTS_PER_PAGE = 6

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [recent, setRecent] = useState<RecentDeployment[]>([])
  const [deployingProject, setDeployingProject] = useState<string | null>(null)
  const [expandedDep, setExpandedDep] = useState<string | null>(null)
  const [cpuHistory, setCpuHistory] = useState<number[]>([])
  const [ramHistory, setRamHistory] = useState<number[]>([])
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  const reload = () => {
    // syncAllProjects refreshes status from live container state (fixes stale
    // "running" when a container is actually restarting); fall back to a plain
    // list if the sync endpoint errors.
    api.syncAllProjects().then(d => setProjects(d ?? [])).catch(() =>
      api.listProjects().then(d => setProjects(d ?? [])).catch(() => {}))
    api.listAllDeployments().then(d => setRecent(d ?? [])).catch(() => {})
  }

  useEffect(() => {
    reload()
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

  const running = projects.filter(p => p.status === 'running').length
  const errored = projects.filter(p => p.status === 'error' || p.status === 'degraded').length
  const cpuPct = stats ? Math.round(stats.cpu_percent) : 0
  const ramPct = stats ? Math.round((stats.ram_used_bytes / stats.ram_total_bytes) * 100) : 0
  const diskPct = stats ? Math.round((stats.disk_used_bytes / stats.disk_total_bytes) * 100) : 0
  const containerCount = (stats?.containers ?? []).length

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return projects
    return projects.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
  }, [projects, query])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PROJECTS_PER_PAGE))
  const safePage = Math.min(page, totalPages - 1)
  const pageProjects = filtered.slice(safePage * PROJECTS_PER_PAGE, safePage * PROJECTS_PER_PAGE + PROJECTS_PER_PAGE)

  const subtitle = [
    `${projects.length} project${projects.length !== 1 ? 's' : ''}`,
    running > 0 ? `${running} running` : null,
    errored > 0 ? `${errored} need attention` : null,
    stats ? `up ${formatUptime(stats.uptime_secs)}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <Page>
      {deployingProject && (
        <DeployModal projectId={deployingProject} onClose={() => { setDeployingProject(null); reload() }} />
      )}

      <PageHeader
        title="Dashboard" subtitle={subtitle} icon={LayoutDashboard}
        actions={<Link to="/projects/new" className="btn-primary"><Plus className="w-4 h-4" /> New Project</Link>}
      />

      {/* System stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {stats ? (
          <>
            <div className="relative overflow-hidden bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-colors">
              <div className="flex items-start justify-between">
                <div><p className="text-xs font-medium text-slate-500 uppercase tracking-wider">CPU</p>
                  <p className="text-2xl font-semibold text-slate-100 mt-1 tabular-nums">{cpuPct}%</p>
                  <p className="text-xs text-slate-500 mt-0.5">load {stats.load_avg[0].toFixed(2)}</p>
                </div>
                <div className="w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center"><Cpu className="w-4.5 h-4.5 text-blue-400" /></div>
              </div>
              <Sparkline values={cpuHistory} color={cpuPct > 80 ? '#ef4444' : '#3b82f6'} />
            </div>
            <div className="relative overflow-hidden bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-colors">
              <div className="flex items-start justify-between">
                <div><p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Memory</p>
                  <p className="text-2xl font-semibold text-slate-100 mt-1 tabular-nums">{ramPct}%</p>
                  <p className="text-xs text-slate-500 mt-0.5">{formatBytes(stats.ram_used_bytes)} / {formatBytes(stats.ram_total_bytes)}</p>
                </div>
                <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center"><MemoryStick className="w-4.5 h-4.5 text-emerald-400" /></div>
              </div>
              <Sparkline values={ramHistory} color={ramPct > 80 ? '#f59e0b' : '#10b981'} />
            </div>
            <StatCard label="Disk" value={`${diskPct}%`} sublabel={`${formatBytes(stats.disk_used_bytes)} / ${formatBytes(stats.disk_total_bytes)}`}
              icon={HardDrive} tone={diskPct > 85 ? 'red' : 'violet'} progress={diskPct} />
            <StatCard label="Containers" value={containerCount}
              sublabel={`${(stats.containers ?? []).filter(c => !c.CPUPerc.startsWith('0.00')).length} active`} icon={ContainerIcon} tone="amber" />
          </>
        ) : (
          [0, 1, 2, 3].map(i => <div key={i} className="h-28 skeleton rounded-xl" />)
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Projects */}
        <section className="xl:col-span-2 space-y-6">
          <Panel
            title="Projects" icon={LayoutDashboard}
            actions={
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                <input value={query} onChange={e => { setQuery(e.target.value); setPage(0) }} placeholder="Search projects…"
                  className="w-44 pl-8 pr-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500" />
              </div>
            }>
            {filtered.length === 0 ? (
              <EmptyState icon={LayoutDashboard}
                title={query ? 'No matching projects' : 'No projects yet'}
                description={query ? 'Try a different search.' : 'Create a project to start managing deployments.'}
                action={!query && <Link to="/projects/new" className="btn-primary"><Plus className="w-4 h-4" /> Create project</Link>} />
            ) : (
              <div className="p-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {pageProjects.map(p => <ProjectCard key={p.id} project={p} onDeploy={setDeployingProject} />)}
                </div>
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-4 pt-3 border-t border-slate-800">
                    <p className="text-xs text-slate-500 tabular-nums">{safePage * PROJECTS_PER_PAGE + 1}–{Math.min((safePage + 1) * PROJECTS_PER_PAGE, filtered.length)} of {filtered.length}</p>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}
                        className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800 disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
                      <span className="text-xs text-slate-400 tabular-nums px-2">{safePage + 1} / {totalPages}</span>
                      <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}
                        className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800 disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Panel>

          {stats && containerCount > 0 && (
            <Panel title="Container Resources" icon={ContainerIcon}
              actions={<Link to="/containers" className="text-xs text-slate-500 hover:text-slate-300">View all →</Link>}>
              <ContainerHealth containers={stats.containers ?? []} />
            </Panel>
          )}
        </section>

        {/* Right column */}
        <section className="space-y-6">
          <Panel title="Quick Actions">
            <div className="grid grid-cols-2 gap-2 p-4">
              {QUICK.map(a => {
                const Icon = a.icon
                return (
                  <Link key={a.to} to={a.to}
                    className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-slate-800/40 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 transition-all">
                    <Icon className={clsx('w-4 h-4 shrink-0', a.tone)} />
                    <span className="text-xs font-medium text-slate-300">{a.label}</span>
                  </Link>
                )
              })}
            </div>
          </Panel>

          <Panel title="Recent Deployments" icon={Rocket}
            actions={<span className="text-xs text-slate-500 tabular-nums">{recent.length}</span>}>
            {recent.length === 0 ? (
              <EmptyState icon={Rocket} title="No deployments yet" description="Deploy a project to see history here." />
            ) : (
              <div className="divide-y divide-slate-800 max-h-[28rem] overflow-y-auto">
                {recent.slice(0, 15).map(d => (
                  <div key={d.id}>
                    <button onClick={() => setExpandedDep(expandedDep === d.id ? null : d.id)}
                      className="w-full text-left px-4 py-3 hover:bg-slate-800/40 transition-colors">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <DeploymentBadge status={d.status} />
                        <span className="text-xs text-slate-500 tabular-nums">{timeAgo(d.started_at)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-slate-300 font-medium truncate">{d.project_name || d.project_id}</span>
                        <span className="text-[11px] text-slate-500 font-mono shrink-0">v{d.new_compose_version} · {dur(d.started_at, d.finished_at)}</span>
                      </div>
                    </button>
                    {expandedDep === d.id && d.log_text && (
                      <div className="font-mono text-xs bg-slate-950 px-4 py-3 max-h-40 overflow-y-auto border-t border-slate-800">
                        {d.log_text.split('\n').slice(-25).map((l, i) => (
                          <div key={i} className={
                            l.includes('FAILED') || l.startsWith('✗') ? 'text-red-400' :
                            l.match(/\[\d+\/\d+\]/) ? 'text-blue-300' :
                            l.includes('complete') ? 'text-emerald-300' :
                            l.startsWith('  ') ? 'text-slate-500' : 'text-slate-400'
                          }>{l || ' '}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </section>
      </div>
    </Page>
  )
}
