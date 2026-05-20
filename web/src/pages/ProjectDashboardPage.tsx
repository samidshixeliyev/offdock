import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, Project, ContainerInfo } from '../api/client'
import clsx from 'clsx'

const projectLinks = [
  { to: 'compose', label: 'Compose' },
  { to: 'env', label: 'Env Vars' },
  { to: 'nginx', label: 'Nginx' },
  { to: 'deploy', label: 'Deploy' },
  { to: 'logs', label: 'Logs' },
]

export default function ProjectDashboardPage() {
  const { id } = useParams<{ id: string }>()
  const [project, setProject] = useState<Project | null>(null)
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!id) return
    api.getProject(id).then(setProject).catch(() => setError('Project not found'))
    api.listContainers(id).then(setContainers).catch(() => {})
  }, [id])

  if (error) return <div className="p-6 text-red-400">{error}</div>
  if (!project) return <div className="p-6 text-gray-500">Loading…</div>

  const statusBadge = {
    running: 'badge-running',
    stopped: 'badge-stopped',
    error: 'badge-error',
    degraded: 'badge-degraded',
  }[project.status] ?? 'badge-stopped'

  return (
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-white">{project.name}</h1>
            <span className={statusBadge}>{project.status}</span>
          </div>
          {project.description && <p className="text-sm text-gray-500 mt-0.5">{project.description}</p>}
        </div>
        <div className="ml-auto flex gap-2">
          <Link to={`/projects/${id}/deploy`} className="btn-primary">Deploy</Link>
        </div>
      </div>

      {/* Quick nav */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {projectLinks.map(({ to, label }) => (
          <Link key={to} to={`/projects/${id}/${to}`} className="btn-ghost border border-gray-700">
            {label}
          </Link>
        ))}
      </div>

      {/* Containers */}
      <section>
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Containers</h2>
        {containers.length === 0 ? (
          <div className="card text-gray-500 text-sm py-6 text-center">No containers running for this project</div>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs">
                  <th className="text-left px-4 py-2.5">Name</th>
                  <th className="text-left px-4 py-2.5">Image</th>
                  <th className="text-left px-4 py-2.5">Status</th>
                  <th className="text-left px-4 py-2.5">Ports</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {containers.map(c => (
                  <tr key={c.ID} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-300">{c.Names}</td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">{c.Image}</td>
                    <td className="px-4 py-2.5">
                      <span className={clsx(
                        'text-xs px-2 py-0.5 rounded-full',
                        c.State === 'running' ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-400'
                      )}>{c.Status}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 font-mono">{c.Ports}</td>
                    <td className="px-4 py-2.5">
                      <Link to={`/projects/${id}/logs?container=${c.Names}`} className="text-xs text-blue-500 hover:text-blue-400">
                        Logs →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
