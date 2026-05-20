import { useEffect, useState } from 'react'
import { api, User } from '../api/client'
import { useAuth } from '../hooks/useAuth'

export default function UsersPage() {
  const { user: me } = useAuth()
  const [users, setUsers] = useState<User[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ username: '', password: '', role: 'viewer' as User['role'] })
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'ok' | 'err'>('ok')

  const reload = () => api.listUsers().then(d => setUsers(d ?? [])).catch(() => {})
  useEffect(() => { reload() }, [])

  const handleCreate = async () => {
    try {
      await api.createUser(form)
      setShowCreate(false)
      setForm({ username: '', password: '', role: 'viewer' })
      reload()
      setMsg('User created')
      setMsgType('ok')
    } catch (e: unknown) {
      setMsg('Error: ' + (e instanceof Error ? e.message : 'unknown'))
      setMsgType('err')
    }
  }

  const handleToggleActive = async (u: User) => {
    await api.updateUser(u.id, { active: !u.active }).catch(() => {})
    reload()
  }

  const handleDelete = async (u: User) => {
    if (!confirm(`Delete user ${u.username}?`)) return
    await api.deleteUser(u.id).catch(() => {})
    reload()
  }

  if (me?.role !== 'superadmin') {
    return <div className="p-6 text-gray-400">Access restricted to superadmin.</div>
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white">Users</h1>
        <div className="flex items-center gap-3">
          {msg && <span className={`text-sm ${msgType === 'err' ? 'text-red-400' : 'text-gray-400'}`}>{msg}</span>}
          <button onClick={() => setShowCreate(!showCreate)} className="btn-primary">+ Add User</button>
        </div>
      </div>

      {showCreate && (
        <div className="card mb-4 space-y-3">
          <h2 className="text-sm font-medium text-white">New User</h2>
          <div className="grid grid-cols-3 gap-3">
            <input className="input" placeholder="Username" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
            <input className="input" type="password" placeholder="Password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
            <select className="input" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as User['role'] }))}>
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
              <option value="superadmin">Superadmin</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="btn-primary">Create</button>
            <button onClick={() => setShowCreate(false)} className="btn-ghost">Cancel</button>
          </div>
        </div>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500 text-xs">
              <th className="text-left px-4 py-2.5">Username</th>
              <th className="text-left px-4 py-2.5">Role</th>
              <th className="text-left px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className="border-b border-gray-800/50">
                <td className="px-4 py-2.5 text-gray-300">{u.username}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{u.role}</td>
                <td className="px-4 py-2.5">
                  <span className={u.active ? 'badge-running' : 'badge-stopped'}>{u.active ? 'active' : 'inactive'}</span>
                </td>
                <td className="px-4 py-2.5">
                  {u.id !== me?.id && (
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => handleToggleActive(u)} className="text-xs text-gray-400 hover:text-white">{u.active ? 'Deactivate' : 'Activate'}</button>
                      <button onClick={() => handleDelete(u)} className="text-xs text-red-500 hover:text-red-400">Delete</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
