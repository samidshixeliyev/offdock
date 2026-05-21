import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, Project, SystemStats, RecentDeployment } from '../api/client'
import clsx from 'clsx'

function fmtGb(bytes: number) { return (bytes / 1e9).toFixed(1) }
function timeAgo(iso: string) {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}
function durStr(started: string, finished: string | null) {
  if (!finished) return '—'
  const ms = new Date(finished).getTime() - new Date(started).getTime()
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function GaugeBar({ pct }: { pct: number }) {
  return (
    <div className="h-1 bg-gray-800 rounded-full overflow-hidden mt-2">
      <div
        className={clsx('h-full rounded-full transition-all duration-500',
          pct > 85 ? 'bg-red-500' : pct > 65 ? 'bg-yellow-500' : 'bg-blue-500'
        )}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  )
}

const statusDot: Record<string, string> = {
  running: 'dot-running', stopped: 'dot-stopped', error: 'dot-error', degraded: 'dot-degraded',
}
const statusBadge: Record<string, string> = {
  running: 'badge-running', stopped: 'badge-stopped', error: 'badge-error', degraded: 'badge-degraded',
}
const depBadge: Record<string, string> = {
  pending: 'badge-pending', running: 'badge-pending', success: 'badge-running', failed: 'badge-error',
}

function ProjectCard({ project }: { project: Project }) {
  return (
    <Link to={`/projects/${project.id}`}
      className="card hover:border-gray-700 transition-all block group">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={statusDot[project.status] ?? 'dot-stopped'} />
            <h3 className="font-medium text-gray-100 truncate text-sm group-hover:text-white">
              {project.name}
            </h3>
          </div>
          {project.description && (
            <p className="text-xs text-gray-600 truncate pl-4">{project.description}</p>
          )}
          <p className="text-xs text-gray-700 pl-4 mt-1">
            {new Date(project.updated_at).toLocaleDateString()}
          </p>
        </div>
        <span className={statusBadge[project.status] ?? 'badge-stopped'}>{project.status}</span>
      </div>
    </Link>
  )
}

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [recent, setRecent] = useState<RecentDeployment[]>([])

  useEffect(() => {
    api.listProjects().then(d => setProjects(d ?? [])).catch(console.error)
    api.listAllDeployments().then(d => setRecent(d ?? [])).catch(() => {})
    const es = new EventSource('/api/v1/system/stats')
    es.onmessage = e => { try { setStats(JSON.parse(e.data as string)) } catch {} }
    es.onerror = () => es.close()
    return () => es.close()
  }, [])

  const runningCount = (stats?.containers ?? []).length
  const ramPct = stats ? Math.round((stats.ram_used_bytes / stats.ram_total_bytes) * 100) : 0
  const diskPct = stats ? Math.round((stats.disk_used_bytes / stats.disk_total_bytes) * 100) : 0
  const cpuPct = stats ? Math.round(stats.cpu_percent) : 0

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-7">
        <div>
          <h1 className="text-lg font-semibold text-white">Dashboard</h1>
          <p className="text-xs text-gray-600 mt-0.5">
            {projects.length} project{projects.length !== 1 ? 's' : ''}
            {runningCount > 0 && ` · ${runningCount} container${runningCount !== 1 ? 's' : ''} running`}
          </p>
        </div>
        <Link to="/projects/new" className="btn-primary">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
          </svg>
          New Project
        </Link>
      </div>

      {/* System stats */}
      {stats && (
        <section className="mb-8">
          <p className="section-heading mb-3">System Resources</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-gray-500">CPU</span>
                <span className={clsx('text-sm font-semibold tabular-nums',
                  cpuPct > 85 ? 'text-red-400' : 'text-gray-200')}>
                  {cpuPct}%
                </span>
              </div>
              <GaugeBar pct={cpuPct} />
              <p className="text-xs text-gray-700 mt-1.5">
                Load {stats.load_avg[0].toFixed(2)} / {stats.load_avg[1].toFixed(2)} / {stats.load_avg[2].toFixed(2)}
              </p>
            </div>
            <div className="card">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-gray-500">Memory</span>
                <span className={clsx('text-sm font-semibold tabular-nums',
                  ramPct > 85 ? 'text-red-400' : 'text-gray-200')}>
                  {ramPct}%
                </span>
              </div>
              <GaugeBar pct={ramPct} />
              <p className="text-xs text-gray-700 mt-1.5">
                {fmtGb(stats.ram_used_bytes)} / {fmtGb(stats.ram_total_bytes)} GB
              </p>
            </div>
            <div className="card">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-gray-500">Disk</span>
                <span className={clsx('text-sm font-semibold tabular-nums',
                  diskPct > 85 ? 'text-red-400' : 'text-gray-200')}>
                  {diskPct}%
                </span>
              </div>
              <GaugeBar pct={diskPct} />
              <p className="text-xs text-gray-700 mt-1.5">
                {fmtGb(stats.disk_used_bytes)} / {fmtGb(stats.disk_total_bytes)} GB
              </p>
            </div>
            <div className="card">
              <span className="text-xs text-gray-500">Containers</span>
              <p className="text-2xl font-bold text-white mt-1 tabular-nums">{runningCount}</p>
              <div className="flex items-center gap-1.5 mt-1">
                {runningCount > 0 && <span className="dot-running" />}
                <p className="text-xs text-gray-600">{runningCount === 0 ? 'none running' : 'running'}</p>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Projects */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <p className="section-heading">Projects</p>
          <span className="text-xs text-gray-600">{projects.length} total</span>
        </div>
        {projects.length === 0 ? (
          <div className="card text-center py-12 border-dashed">
            <p className="text-gray-500 text-sm mb-1">No projects yet</p>
            <p className="text-gray-700 text-xs mb-4">Create a project to start managing deployments</p>
            <Link to="/projects/new" className="btn-primary">Create your first project</Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {projects.map(p => <ProjectCard key={p.id} project={p} />)}
          </div>
        )}
      </section>

      {/* Recent Deployments */}
      {recent.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <p className="section-heading">Recent Deployments</p>
            <span className="text-xs text-gray-600">Last {recent.length}</span>
          </div>
          <div className="card p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500">
                  <th className="text-left px-4 py-3 text-xs font-medium">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-medium">Project</th>
                  <th className="text-left px-4 py-3 text-xs font-medium">Compose</th>
                  <th className="text-left px-4 py-3 text-xs font-medium">Duration</th>
                  <th className="text-left px-4 py-3 text-xs font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map(d => (
                  <tr key={d.id} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                    <td className="px-4 py-2.5">
                      <span className={depBadge[d.status] ?? 'badge-stopped'}>{d.status}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <Link
                        to={`/projects/${d.project_id}`}
                        className="text-xs text-gray-300 hover:text-white transition-colors font-medium"
                      >
                        {d.project_name || d.project_id}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 font-mono">
                      v{d.new_compose_version}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 tabular-nums">
                      {durStr(d.started_at, d.finished_at)}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600">
                      {timeAgo(d.started_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
