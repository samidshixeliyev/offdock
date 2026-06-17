import { useEffect, useState } from 'react'
import { api, User, CustomRole, PermissionInfo, Session, Project, AuditEvent } from '../api/client'
import { useAuth } from '../hooks/useAuth'
import { Page, PageHeader, Panel, Tabs, EmptyState, StatusBadge, IconButton } from '../components/ui'
import { Modal } from '../components/Modal'
import ConfirmModal from '../components/ConfirmModal'
import { useToast } from '../components/Toast'
import { timeAgo, formatDateTime } from '../lib/format'
import clsx from 'clsx'
import {
  Users, Plus, Pencil, Trash2, Shield, ShieldCheck, Monitor,
  ScrollText, LogOut, Check, X, FolderTree, Loader2,
} from 'lucide-react'

type TabId = 'users' | 'roles' | 'sessions'

// ─── User create/edit modal ────────────────────────────────────────────────────
function UserModal({ user, perms, roles, projects, onSaved, onClose }: {
  user: User | null; perms: PermissionInfo[]; roles: CustomRole[]; projects: Project[]
  onSaved: () => void; onClose: () => void
}) {
  const toast = useToast()
  const [username, setUsername] = useState(user?.username ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<User['role']>(user?.role ?? 'viewer')
  const [customRoleId, setCustomRoleId] = useState(user?.custom_role_id ?? '')
  const [explicitPerms, setExplicitPerms] = useState<string[]>(user?.permissions ?? [])
  const [useExplicit, setUseExplicit] = useState((user?.permissions ?? []).length > 0)
  const [projectIds, setProjectIds] = useState<string[]>(user?.project_ids ?? [])
  const [hostTerm, setHostTerm] = useState<'otp' | 'bypass' | 'disabled'>(user?.host_terminal_access ?? 'otp')
  const [saving, setSaving] = useState(false)

  const togglePerm = (k: string) => setExplicitPerms(p => p.includes(k) ? p.filter(x => x !== k) : [...p, k])
  const toggleProject = (id: string) => setProjectIds(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])

  const save = async () => {
    setSaving(true)
    try {
      const permsPayload = useExplicit ? explicitPerms : []
      if (user) {
        await api.updateUser(user.id, {
          role, email: email || undefined, custom_role_id: useExplicit ? '' : customRoleId,
          permissions: permsPayload, project_ids: projectIds, host_terminal_access: hostTerm,
          ...(password ? { password } : {}),
        })
        toast.success('User updated')
      } else {
        if (!username || !password) { toast.error('Username and password required'); setSaving(false); return }
        await api.createUser({ username, email: email || undefined, password, role, custom_role_id: useExplicit ? '' : customRoleId, permissions: permsPayload, project_ids: projectIds })
        toast.success('User created')
      }
      onSaved()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed') } finally { setSaving(false) }
  }

  const isSuper = role === 'superadmin'

  return (
    <Modal open onClose={onClose} size="lg" icon={Users} title={user ? `Edit ${user.username}` : 'New User'}
      footer={<>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button onClick={save} disabled={saving} className="btn-primary">{saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Save'}</button>
      </>}>
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Username</label>
            <input className="input" value={username} disabled={!!user} onChange={e => setUsername(e.target.value)} placeholder="username" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">{user ? 'New password (optional)' : 'Password'}</label>
            <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
          </div>
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1.5">
            Email <span className="text-slate-600">(required for OTP terminal access)</span>
          </label>
          <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="user@company.local" />
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1.5">Base role</label>
          <select className="select" value={role} onChange={e => setRole(e.target.value as User['role'])}>
            <option value="viewer">Viewer — read-only</option>
            <option value="admin">Admin — full access</option>
            <option value="superadmin">Superadmin — full access + user management</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1.5">
            Host terminal access <span className="text-slate-600">(root shell gate)</span>
          </label>
          <select className="select" value={hostTerm} onChange={e => setHostTerm(e.target.value as 'otp' | 'bypass' | 'disabled')}>
            <option value="otp">OTP required — email one-time code (default)</option>
            <option value="bypass">Bypass OTP — trusted, no email code</option>
            <option value="disabled">Disabled — cannot open the host shell</option>
          </select>
          {hostTerm === 'bypass' && <p className="text-xs text-amber-500 mt-1">Removes the email second-factor for this user's root terminal.</p>}
          {!user && <p className="text-xs text-slate-600 mt-1">Applied after the user is created (save, then edit if needed).</p>}
        </div>

        {!isSuper && (
          <>
            {/* Permission source toggle */}
            <div className="border border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-200">Permissions</span>
                <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                  <input type="checkbox" checked={useExplicit} onChange={e => setUseExplicit(e.target.checked)} />
                  Custom per-user grants
                </label>
              </div>
              {useExplicit ? (
                <div className="grid grid-cols-2 gap-2">
                  {perms.map(p => (
                    <button key={p.key} onClick={() => togglePerm(p.key)}
                      className={clsx('flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs text-left transition-colors',
                        explicitPerms.includes(p.key) ? 'bg-blue-500/10 border-blue-500/30 text-blue-300' : 'border-slate-800 text-slate-400 hover:border-slate-700')}>
                      <span className={clsx('w-3.5 h-3.5 rounded flex items-center justify-center shrink-0', explicitPerms.includes(p.key) ? 'bg-blue-500' : 'border border-slate-600')}>
                        {explicitPerms.includes(p.key) && <Check className="w-2.5 h-2.5 text-white" />}
                      </span>
                      {p.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Custom role (optional — overrides base role permissions)</label>
                  <select className="select" value={customRoleId} onChange={e => setCustomRoleId(e.target.value)}>
                    <option value="">Use base role defaults</option>
                    {roles.map(r => <option key={r.id} value={r.id}>{r.name} ({r.permissions.length} perms)</option>)}
                  </select>
                </div>
              )}
            </div>

            {/* Project scope */}
            <div className="border border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <FolderTree className="w-4 h-4 text-slate-500" />
                <span className="text-sm font-medium text-slate-200">Project access</span>
                <span className="text-xs text-slate-500">{projectIds.length === 0 ? 'all projects' : `${projectIds.length} selected`}</span>
              </div>
              {projects.length === 0 ? <p className="text-xs text-slate-600">No projects yet.</p> : (
                <div className="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto">
                  {projects.map(p => (
                    <button key={p.id} onClick={() => toggleProject(p.id)}
                      className={clsx('flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs text-left transition-colors',
                        projectIds.includes(p.id) ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'border-slate-800 text-slate-400 hover:border-slate-700')}>
                      <span className={clsx('w-3.5 h-3.5 rounded flex items-center justify-center shrink-0', projectIds.includes(p.id) ? 'bg-emerald-500' : 'border border-slate-600')}>
                        {projectIds.includes(p.id) && <Check className="w-2.5 h-2.5 text-white" />}
                      </span>
                      <span className="truncate">{p.name}</span>
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-slate-600">Empty selection = access to all projects.</p>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

// ─── Per-user audit modal ───────────────────────────────────────────────────────
function UserAuditModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { api.userAudit(user.id).then(e => setEvents(e ?? [])).finally(() => setLoading(false)) }, [user.id])
  return (
    <Modal open onClose={onClose} size="lg" icon={ScrollText} title={`Activity — ${user.username}`}>
      {loading ? <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-slate-500" /></div>
        : events.length === 0 ? <EmptyState icon={ScrollText} title="No activity recorded" />
        : (
          <div className="divide-y divide-slate-800 max-h-96 overflow-y-auto">
            {events.map(e => (
              <div key={e.id} className="flex items-center gap-3 py-2.5">
                <span className="text-xs font-mono text-blue-400 w-36 shrink-0">{e.action}</span>
                <span className="text-xs text-slate-400 flex-1 truncate">{e.resource_type}{e.resource_name ? ` · ${e.resource_name}` : ''}{e.details ? ` (${e.details})` : ''}</span>
                <span className="text-xs text-slate-600 shrink-0">{timeAgo(e.created_at)}</span>
              </div>
            ))}
          </div>
        )}
    </Modal>
  )
}

// ─── Role modal ──────────────────────────────────────────────────────────────
function RoleModal({ role, perms, onSaved, onClose }: { role: CustomRole | null; perms: PermissionInfo[]; onSaved: () => void; onClose: () => void }) {
  const toast = useToast()
  const [name, setName] = useState(role?.name ?? '')
  const [selected, setSelected] = useState<string[]>(role?.permissions ?? [])
  const [saving, setSaving] = useState(false)
  const toggle = (k: string) => setSelected(p => p.includes(k) ? p.filter(x => x !== k) : [...p, k])
  const save = async () => {
    if (!name.trim()) { toast.error('Name required'); return }
    setSaving(true)
    try {
      if (role) { await api.updateRole(role.id, { name, permissions: selected }); toast.success('Role updated') }
      else { await api.createRole({ name, permissions: selected }); toast.success('Role created') }
      onSaved()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed') } finally { setSaving(false) }
  }
  return (
    <Modal open onClose={onClose} size="md" icon={Shield} title={role ? `Edit role — ${role.name}` : 'New custom role'}
      footer={<><button onClick={onClose} className="btn-secondary">Cancel</button><button onClick={save} disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Save'}</button></>}>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-slate-500 mb-1.5">Role name</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. deployer" autoFocus />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-2">Permissions ({selected.length})</label>
          <div className="grid grid-cols-2 gap-2">
            {perms.map(p => (
              <button key={p.key} onClick={() => toggle(p.key)}
                className={clsx('flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs text-left transition-colors',
                  selected.includes(p.key) ? 'bg-blue-500/10 border-blue-500/30 text-blue-300' : 'border-slate-800 text-slate-400 hover:border-slate-700')}>
                <span className={clsx('w-3.5 h-3.5 rounded flex items-center justify-center shrink-0', selected.includes(p.key) ? 'bg-blue-500' : 'border border-slate-600')}>
                  {selected.includes(p.key) && <Check className="w-2.5 h-2.5 text-white" />}
                </span>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function RoleBadge({ role }: { role: string }) {
  const tone = role === 'superadmin' ? 'pending' : role === 'admin' ? 'running' : 'neutral'
  return <StatusBadge meta={{ tone: tone as any, label: role }} />
}

// ─── Main page ──────────────────────────────────────────────────────────────────
export default function UsersPage() {
  const { user: me } = useAuth()
  const toast = useToast()
  const [tab, setTab] = useState<TabId>('users')
  const [users, setUsers] = useState<User[]>([])
  const [roles, setRoles] = useState<CustomRole[]>([])
  const [perms, setPerms] = useState<PermissionInfo[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<Session[]>([])

  const [userModal, setUserModal] = useState<{ user: User | null } | null>(null)
  const [roleModal, setRoleModal] = useState<{ role: CustomRole | null } | null>(null)
  const [auditUser, setAuditUser] = useState<User | null>(null)
  const [deleteUser, setDeleteUser] = useState<User | null>(null)
  const [deleteRole, setDeleteRole] = useState<CustomRole | null>(null)

  const isSuper = me?.role === 'superadmin'

  const reload = () => {
    api.listUsers().then(d => setUsers(d ?? [])).catch(() => {})
    api.listRoles().then(d => setRoles(d ?? [])).catch(() => {})
    api.listSessions().then(d => setSessions(d ?? [])).catch(() => {})
  }
  useEffect(() => {
    reload()
    api.listPermissions().then(d => setPerms(d ?? [])).catch(() => {})
    api.listProjects().then(d => setProjects(d ?? [])).catch(() => {})
  }, [])

  const roleName = (id: string) => roles.find(r => r.id === id)?.name
  const scopeLabel = (u: User) => u.project_ids.length === 0 ? 'all projects' : `${u.project_ids.length} project${u.project_ids.length > 1 ? 's' : ''}`
  const permLabel = (u: User) => u.permissions.length > 0 ? `${u.permissions.length} custom perms` : u.custom_role_id ? (roleName(u.custom_role_id) ?? 'custom role') : 'role defaults'

  const toggleActive = async (u: User) => { await api.updateUser(u.id, { active: !u.active }).catch(() => {}); reload() }
  const doDeleteUser = async () => { if (!deleteUser) return; try { await api.deleteUser(deleteUser.id); toast.success('User deleted') } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') } setDeleteUser(null); reload() }
  const doDeleteRole = async () => { if (!deleteRole) return; try { await api.deleteRole(deleteRole.id); toast.success('Role deleted') } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') } setDeleteRole(null); reload() }
  const revoke = async (s: Session) => { try { await api.revokeSession(s.id); toast.success('Session revoked') } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') } reload() }

  if (!isSuper) return (
    <Page><PageHeader title="Users" icon={Users} /><Panel><EmptyState icon={Shield} title="Access restricted" description="Only superadmins can manage users, roles, and sessions." /></Panel></Page>
  )

  const tabs = [
    { id: 'users' as const, label: 'Users', icon: Users, count: users.length },
    { id: 'roles' as const, label: 'Custom Roles', icon: Shield, count: roles.length },
    { id: 'sessions' as const, label: 'Sessions', icon: Monitor, count: sessions.length },
  ]

  return (
    <Page>
      <PageHeader title="Access Control" subtitle="Users, roles & sessions" icon={Users}
        actions={
          tab === 'users' ? <button onClick={() => setUserModal({ user: null })} className="btn-primary"><Plus className="w-4 h-4" /> Add User</button>
          : tab === 'roles' ? <button onClick={() => setRoleModal({ role: null })} className="btn-primary"><Plus className="w-4 h-4" /> New Role</button>
          : undefined
        } />

      <div className="mb-4"><Tabs tabs={tabs} active={tab} onChange={setTab} /></div>

      {userModal && <UserModal user={userModal.user} perms={perms} roles={roles} projects={projects} onSaved={() => { setUserModal(null); reload() }} onClose={() => setUserModal(null)} />}
      {roleModal && <RoleModal role={roleModal.role} perms={perms} onSaved={() => { setRoleModal(null); reload() }} onClose={() => setRoleModal(null)} />}
      {auditUser && <UserAuditModal user={auditUser} onClose={() => setAuditUser(null)} />}
      {deleteUser && <ConfirmModal title="Delete user?" danger confirmLabel="Delete" message={`Permanently delete ${deleteUser.username}.`} onConfirm={doDeleteUser} onCancel={() => setDeleteUser(null)} />}
      {deleteRole && <ConfirmModal title="Delete role?" danger confirmLabel="Delete" message={`Delete "${deleteRole.name}". Users using it revert to base-role defaults.`} onConfirm={doDeleteRole} onCancel={() => setDeleteRole(null)} />}

      {tab === 'users' && (
        <Panel>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead><tr className="border-b border-slate-800">
                <th className="th text-left">User</th><th className="th text-left">Role</th>
                <th className="th text-left">Permissions</th><th className="th text-left">Scope</th>
                <th className="th text-left">Status</th><th className="th text-right">Actions</th>
              </tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30">
                    <td className="px-4 py-3"><span className="text-sm font-medium text-slate-200">{u.username}</span>{u.id === me?.id && <span className="ml-2 text-[10px] text-slate-500">you</span>}</td>
                    <td className="px-4 py-3"><RoleBadge role={u.role} /></td>
                    <td className="px-4 py-3 text-xs text-slate-400">{permLabel(u)}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">{scopeLabel(u)}</td>
                    <td className="px-4 py-3"><StatusBadge meta={{ tone: u.active ? 'running' : 'stopped', label: u.active ? 'Active' : 'Inactive' }} /></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-0.5 justify-end">
                        <IconButton icon={ScrollText} title="Activity" onClick={() => setAuditUser(u)} />
                        <IconButton icon={Pencil} title="Edit" onClick={() => setUserModal({ user: u })} />
                        {u.id !== me?.id && <>
                          <IconButton icon={u.active ? X : Check} title={u.active ? 'Deactivate' : 'Activate'} onClick={() => toggleActive(u)} />
                          <IconButton icon={Trash2} tone="danger" title="Delete" onClick={() => setDeleteUser(u)} />
                        </>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {tab === 'roles' && (
        <Panel>
          {roles.length === 0 ? (
            <EmptyState icon={Shield} title="No custom roles" description="Define named permission sets to assign to users."
              action={<button onClick={() => setRoleModal({ role: null })} className="btn-primary"><Plus className="w-4 h-4" /> New Role</button>} />
          ) : (
            <div className="divide-y divide-slate-800">
              {roles.map(r => (
                <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                  <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-200">{r.name}</p>
                    <p className="text-xs text-slate-500 truncate">{r.permissions.length === 0 ? 'no permissions' : r.permissions.map(p => perms.find(x => x.key === p)?.label ?? p).join(', ')}</p>
                  </div>
                  <IconButton icon={Pencil} title="Edit" onClick={() => setRoleModal({ role: r })} />
                  <IconButton icon={Trash2} tone="danger" title="Delete" onClick={() => setDeleteRole(r)} />
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {tab === 'sessions' && (
        <Panel title="Active sessions" icon={Monitor}>
          {sessions.length === 0 ? <EmptyState icon={Monitor} title="No active sessions" /> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px]">
                <thead><tr className="border-b border-slate-800">
                  <th className="th text-left">User</th><th className="th text-left">IP</th>
                  <th className="th text-left">Client</th><th className="th text-left">Signed in</th>
                  <th className="th text-left">Last seen</th><th className="th text-right"></th>
                </tr></thead>
                <tbody>
                  {sessions.map(s => (
                    <tr key={s.id} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30">
                      <td className="px-4 py-3 text-sm text-slate-200">{s.username}</td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-400">{s.ip}</td>
                      <td className="px-4 py-3 text-xs text-slate-500 max-w-[220px] truncate" title={s.user_agent}>{s.user_agent}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{formatDateTime(s.created_at)}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{timeAgo(s.last_seen)}</td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => revoke(s)} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-red-400 hover:border-red-500/40 transition-colors">
                          <LogOut className="w-3.5 h-3.5" /> Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </Page>
  )
}
