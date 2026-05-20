import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, Project, SystemStats } from '../api/client'
import clsx from 'clsx'

function StatGauge({ label, value, total, unit }: { label: string; value: number; total: number; unit: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="card">
      <div className="flex justify-between items-baseline mb-2">
        <span className="text-sm text-gray-400">{label}</span>
        <span className="text-xs text-gray-500">{pct}%</span>
      </div>
      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all', pct > 85 ? 'bg-red-500' : pct > 60 ? 'bg-yellow-500' : 'bg-blue-500')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-gray-500 mt-1.5">
        {(value / 1e9).toFixed(1)} / {(total / 1e9).toFixed(1)} {unit}
      </p>
    </div>
  )
}

function ProjectCard({ project }: { project: Project }) {
  const badgeClass = {
    running: 'badge-running',
    stopped: 'badge-stopped',
    error: 'badge-error',
    degraded: 'badge-degraded',
  }[project.status] ?? 'badge-stopped'

  return (
    <Link to={`/projects/${project.id}`} className="card hover:border-gray-700 transition-colors block">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-white truncate">{project.name}</h3>
          {project.description && <p className="text-xs text-gray-500 mt-0.5 truncate">{project.description}</p>}
        </div>
        <span className={badgeClass}>{project.status}</span>
      </div>
    </Link>
  )
}

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [stats, setStats] = useState<SystemStats | null>(null)

  useEffect(() => {
    api.listProjects().then(setProjects).catch(console.error)

    const es = new EventSource('/api/v1/system/stats')
    es.onmessage = e => {
      try { setStats(JSON.parse(e.data)) } catch {}
    }
    return () => es.close()
  }, [])

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white">Dashboard</h1>
        <Link to="/projects/new" className="btn-primary">+ New Project</Link>
      </div>

      {/* System stats */}
      {stats && (
        <section className="mb-8">
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">System Resources</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card">
              <div className="flex justify-between items-baseline mb-2">
                <span className="text-sm text-gray-400">CPU</span>
                <span className="text-xs text-gray-500">{stats.cpu_percent.toFixed(1)}%</span>
              </div>
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={clsx('h-full rounded-full', stats.cpu_percent > 85 ? 'bg-red-500' : 'bg-blue-500')}
                  style={{ width: `${stats.cpu_percent}%` }}
                />
              </div>
            </div>
            <StatGauge label="RAM" value={stats.ram_used_bytes} total={stats.ram_total_bytes} unit="GB" />
            <StatGauge label="Disk" value={stats.disk_used_bytes} total={stats.disk_total_bytes} unit="GB" />
            <div className="card">
              <span className="text-sm text-gray-400">Containers</span>
              <p className="text-2xl font-bold text-white mt-1">{stats.containers?.length ?? 0}</p>
              <p className="text-xs text-gray-500">running</p>
            </div>
          </div>
        </section>
      )}

      {/* Projects */}
      <section>
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Projects</h2>
        {projects.length === 0 ? (
          <div className="card text-center py-10">
            <p className="text-gray-500 mb-3">No projects yet</p>
            <Link to="/projects/new" className="btn-primary">Create your first project</Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {projects.map(p => <ProjectCard key={p.id} project={p} />)}
          </div>
        )}
      </section>
    </div>
  )
}
