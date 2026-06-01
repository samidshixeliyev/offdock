import { useEffect, useState, useCallback } from 'react'
import { api, AuditEvent } from '../api/client'
import clsx from 'clsx'

const RESOURCE_TYPES = ['', 'project', 'user', 'proxy_host', 'system', 'nginx'] as const
type ResourceType = (typeof RESOURCE_TYPES)[number]

const ACTIONS = [
  '',
  'login',
  'logout',
  'create',
  'update',
  'delete',
  'deploy',
  'rollback',
  'apply',
  'reload',
  'start',
  'stop',
  'restart',
] as const
type ActionFilter = (typeof ACTIONS)[number]

const LIMITS = [50, 100, 200, 500] as const
type Limit = (typeof LIMITS)[number]

// Pad helper
const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${MONTHS[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function actionBadgeClass(action: string): string {
  const a = action.toLowerCase()
  if (a.includes('delete') || a.includes('remove'))
    return 'bg-red-950/60 text-red-300 border-red-900/50'
  if (a.includes('login') || a.includes('logout') || a.includes('auth'))
    return 'bg-green-950/60 text-green-300 border-green-900/50'
  if (a.includes('deploy') || a.includes('rollback'))
    return 'bg-blue-950/60 text-blue-300 border-blue-900/50'
  if (a.includes('create') || a.includes('add'))
    return 'bg-emerald-950/60 text-emerald-300 border-emerald-900/50'
  if (a.includes('update') || a.includes('patch') || a.includes('edit') || a.includes('apply') || a.includes('reload'))
    return 'bg-yellow-950/60 text-yellow-300 border-yellow-900/50'
  return 'bg-slate-800 text-slate-300 border-slate-700'
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5 text-blue-400">
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.063 2.522-.186 3.76-.21 2.12-1.61 3.78-3.687 4.205-1.585.324-3.187.5-4.815.535H12c-1.628-.034-3.23-.211-4.815-.535-2.076-.425-3.477-2.086-3.687-4.205A39.064 39.064 0 013 12c0-1.268.063-2.522.186-3.76C3.396 6.12 4.797 4.46 6.873 4.034 8.458 3.71 10.06 3.534 11.688 3.5h.624c1.628.034 3.23.21 4.815.535 2.076.425 3.477 2.086 3.687 4.205.123 1.238.186 2.492.186 3.76z" />
    </svg>
  )
}

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [resourceType, setResourceType] = useState<ResourceType>('')
  const [action, setAction] = useState<ActionFilter>('')
  const [limit, setLimit] = useState<Limit>(100)
  const [error, setError] = useState('')

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true)
    try {
      const data = await api.listAuditEvents({
        limit,
        resource_type: resourceType || undefined,
        action: action || undefined,
      })
      setEvents(data ?? [])
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load audit events')
    }
    if (initial) setLoading(false)
  }, [limit, resourceType, action])

  useEffect(() => {
    load(true)
  }, [load])

  useEffect(() => {
    const id = setInterval(() => load(false), 30000)
    return () => clearInterval(id)
  }, [load])

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <ShieldIcon />
          <div>
            <h1 className="text-lg font-semibold text-white">Audit Log</h1>
            <p className="text-xs text-slate-600 mt-0.5">
              {events.length} event{events.length !== 1 ? 's' : ''} · auto-refresh every 30s
            </p>
          </div>
        </div>
        <button onClick={() => load(true)} className="btn-ghost text-xs">↻ Refresh</button>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Resource Type</label>
          <select
            value={resourceType}
            onChange={e => setResourceType(e.target.value as ResourceType)}
            className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
          >
            <option value="">All Types</option>
            <option value="project">Project</option>
            <option value="user">User</option>
            <option value="proxy_host">Proxy Host</option>
            <option value="system">System</option>
            <option value="nginx">Nginx</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Action</label>
          <select
            value={action}
            onChange={e => setAction(e.target.value as ActionFilter)}
            className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
          >
            <option value="">All Actions</option>
            <option value="login">Login</option>
            <option value="logout">Logout</option>
            <option value="create">Create</option>
            <option value="update">Update</option>
            <option value="delete">Delete</option>
            <option value="deploy">Deploy</option>
            <option value="rollback">Rollback</option>
            <option value="apply">Apply</option>
            <option value="reload">Reload</option>
            <option value="start">Start</option>
            <option value="stop">Stop</option>
            <option value="restart">Restart</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Limit</label>
          <select
            value={limit}
            onChange={e => setLimit(Number(e.target.value) as Limit)}
            className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
          >
            {LIMITS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
      </div>

      {error && (
        <div className="card border-red-900/50 bg-red-950/30 text-red-300 text-xs mb-4">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading ? (
        <div className="card p-0 overflow-hidden">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="border-b border-slate-800/50 last:border-0 px-4 py-3 flex gap-4 animate-pulse">
              <div className="h-3 bg-slate-800 rounded w-32 shrink-0" />
              <div className="h-3 bg-slate-800 rounded w-20 shrink-0" />
              <div className="h-3 bg-slate-800 rounded w-16 shrink-0" />
              <div className="h-3 bg-slate-800 rounded flex-1" />
              <div className="h-3 bg-slate-800 rounded w-24 shrink-0" />
            </div>
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="card text-center py-16 text-slate-600 text-sm border-dashed">
          <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center mx-auto mb-3">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5 text-slate-600">
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.063 2.522-.186 3.76-.21 2.12-1.61 3.78-3.687 4.205-1.585.324-3.187.5-4.815.535H12c-1.628-.034-3.23-.211-4.815-.535-2.076-.425-3.477-2.086-3.687-4.205A39.064 39.064 0 013 12c0-1.268.063-2.522.186-3.76C3.396 6.12 4.797 4.46 6.873 4.034 8.458 3.71 10.06 3.534 11.688 3.5h.624c1.628.034 3.23.21 4.815.535 2.076.425 3.477 2.086 3.687 4.205.123 1.238.186 2.492.186 3.76z" />
            </svg>
          </div>
          <p className="text-slate-500 text-sm mb-1">No audit events found</p>
          <p className="text-slate-700 text-xs">Try adjusting the filters above</p>
        </div>
      ) : (
        <div className="card p-0 overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">Time</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">User</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">Action</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">Resource</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">Details</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">IP</th>
              </tr>
            </thead>
            <tbody>
              {events.map(ev => (
                <tr key={ev.id} className="border-b border-slate-800/40 hover:bg-slate-800/20">
                  <td className="px-4 py-2.5 text-xs text-slate-500 font-mono whitespace-nowrap">
                    {formatTime(ev.created_at)}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-300 font-medium whitespace-nowrap">
                    {ev.username || <span className="text-slate-600 font-normal">—</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={clsx(
                      'inline-block text-xs px-2 py-0.5 rounded-full border font-medium',
                      actionBadgeClass(ev.action),
                    )}>
                      {ev.action || 'unknown'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                    <span className="text-slate-400">{ev.resource_type || '—'}</span>
                    {ev.resource_name && (
                      <span className="text-slate-300 ml-1.5 font-mono">/ {ev.resource_name}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-400 max-w-md">
                    <span className="truncate block" title={ev.details}>
                      {ev.details || <span className="text-slate-700">—</span>}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600 font-mono whitespace-nowrap">
                    {ev.ip_addr || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
