import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { usePermissions, PERMS } from '../hooks/usePermissions'
import clsx from 'clsx'
import {
  LayoutDashboard, Boxes, Container, Globe, Network, HardDrive, FolderTree,
  Cpu, TerminalSquare, Activity, ScrollText, Users, LogOut, ChevronRight,
  MapPin, Settings, FileText, Menu, Layers, BookOpen,
  PanelLeftClose, PanelLeftOpen, GripVertical, Eye, EyeOff, Pencil, RotateCcw, Check,
  type LucideIcon,
} from 'lucide-react'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  perm?: string       // required permission (undefined = visible to all)
  adminOnly?: boolean // requires admin or superadmin
  superadminOnly?: boolean
}

type Group = 'main' | 'system'

const navMain: NavItem[] = [
  { to: '/',           label: 'Dashboard',     icon: LayoutDashboard, end: true },
  { to: '/images',     label: 'Images',        icon: Boxes },
  { to: '/containers', label: 'Containers',    icon: Container },
  { to: '/proxy',      label: 'Reverse Proxy', icon: Globe },
  { to: '/networks',   label: 'Networks',      icon: Network },
  { to: '/volumes',    label: 'Volumes',       icon: HardDrive },
  { to: '/files',      label: 'Files',         icon: FolderTree },
]
const navSystem: NavItem[] = [
  { to: '/system',      label: 'System',      icon: Cpu,            superadminOnly: true },
  { to: '/terminal',    label: 'Terminal',    icon: TerminalSquare, perm: PERMS.terminal },
  { to: '/traffic',     label: 'Traffic',     icon: Activity },
  { to: '/dns',         label: 'DNS',         icon: MapPin },
  { to: '/audit',       label: 'Audit Log',   icon: ScrollText },
  { to: '/users',       label: 'Users',       icon: Users,          superadminOnly: true },
  { to: '/otel-traces', label: 'App Traces',  icon: Layers },
  { to: '/app-logs',    label: 'App Logs',    icon: FileText },
  { to: '/settings',    label: 'Settings',    icon: Settings,       adminOnly: true },
  { to: '/docs',        label: 'Docs',        icon: BookOpen },
  { to: '/help',        label: 'Help',        icon: BookOpen },
]

// ─── Persistence keys ──────────────────────────────────────────────────────────
const LS_COLLAPSED = 'offdock.sidebar.collapsed'
const LS_ORDER = 'offdock.nav.order'
const LS_HIDDEN = 'offdock.nav.hidden'

function loadJSON<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback } catch { return fallback }
}

// Merge a saved order (array of `to`) with the canonical list so that newly
// added nav items always surface (appended in their canonical position).
function applyOrder(items: NavItem[], order: string[]): NavItem[] {
  const byTo = new Map(items.map(i => [i.to, i]))
  const out: NavItem[] = []
  for (const to of order) {
    const it = byTo.get(to)
    if (it) { out.push(it); byTo.delete(to) }
  }
  for (const it of items) if (byTo.has(it.to)) out.push(it)
  return out
}

function reorder(list: string[], from: string, to: string): string[] {
  const arr = [...list]
  const fi = arr.indexOf(from), ti = arr.indexOf(to)
  if (fi < 0 || ti < 0 || fi === ti) return arr
  arr.splice(fi, 1)
  arr.splice(ti, 0, from)
  return arr
}

function breadcrumbFor(pathname: string): string {
  if (pathname === '/' || pathname === '') return 'Dashboard'
  const segs = pathname.split('/').filter(Boolean)
  if (segs[0] === 'projects') {
    if (segs.length === 1) return 'Projects'
    if (segs[1] === 'new') return 'New Project'
    if (segs.length === 2) return 'Project'
    if (!segs[2]) return 'Project'
    return `Project · ${segs[2].charAt(0).toUpperCase() + segs[2].slice(1)}`
  }
  const all = [...navMain, ...navSystem]
  const found = all.find(n => n.to === `/${segs[0]}`)
  if (found) return found.label
  return segs[0].charAt(0).toUpperCase() + segs[0].slice(1)
}

function RoleBadge({ role }: { role: string }) {
  const variants: Record<string, string> = {
    superadmin: 'bg-gradient-to-r from-blue-500/15 to-indigo-500/15 text-blue-300 border-blue-500/30',
    admin:      'bg-blue-500/10 text-blue-400 border-blue-500/20',
    viewer:     'bg-slate-800 text-slate-400 border-slate-700',
  }
  return (
    <span className={clsx(
      'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider border',
      variants[role] ?? variants.viewer,
    )}>
      {role}
    </span>
  )
}

interface SidebarLinkProps {
  item: NavItem
  delay: number
  collapsed: boolean
  editing: boolean
  hidden: boolean
  group: Group
  onNavigate?: () => void
  onToggleHidden: (to: string) => void
  onDragStart: (group: Group, to: string) => void
  onDropOn: (group: Group, to: string) => void
}

function SidebarLink({
  item, delay, collapsed, editing, hidden, group,
  onNavigate, onToggleHidden, onDragStart, onDropOn,
}: SidebarLinkProps) {
  const Icon = item.icon

  // In edit mode the row is a draggable, non-navigating control.
  if (editing) {
    return (
      <div
        draggable
        onDragStart={() => onDragStart(group, item.to)}
        onDragOver={e => e.preventDefault()}
        onDrop={() => onDropOn(group, item.to)}
        className={clsx(
          'flex items-center gap-2 px-2 py-2 rounded-lg text-sm font-medium border cursor-grab active:cursor-grabbing',
          'border-slate-700/60 bg-slate-900/60',
          hidden ? 'opacity-45' : 'text-slate-200',
        )}
      >
        <GripVertical className="w-4 h-4 text-slate-600 shrink-0" />
        <Icon className="w-[18px] h-[18px] shrink-0 text-slate-400" />
        <span className="truncate flex-1">{item.label}</span>
        <button
          onClick={() => onToggleHidden(item.to)}
          title={hidden ? 'Show in sidebar' : 'Hide from sidebar'}
          className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 shrink-0"
        >
          {hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
    )
  }

  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      style={{ animationDelay: `${delay}ms` }}
      className={({ isActive }) =>
        clsx(
          'flex items-center rounded-lg text-sm font-medium transition-all duration-200 opacity-0 animate-slideInLeft group',
          collapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-3 py-2',
          isActive
            ? 'bg-gradient-to-r from-blue-600/20 to-indigo-600/20 text-white border border-blue-500/30 shadow-lg shadow-blue-500/5'
            : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 border border-transparent',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={clsx('w-[18px] h-[18px] shrink-0 transition-colors', isActive ? 'text-blue-400' : 'text-slate-500 group-hover:text-slate-300')} />
          {!collapsed && <span className="truncate">{item.label}</span>}
        </>
      )}
    </NavLink>
  )
}

export default function Layout() {
  const { user, logout } = useAuth()
  const { can, isSuperAdmin, isAdmin } = usePermissions()
  const navigate = useNavigate()
  const location = useLocation()

  const [sidebarOpen, setSidebarOpen] = useState(false) // mobile drawer
  const [collapsed, setCollapsed] = useState<boolean>(() => loadJSON<boolean>(LS_COLLAPSED, false))
  const [editing, setEditing] = useState(false)
  const [order, setOrder] = useState<{ main: string[]; system: string[] }>(() => loadJSON(LS_ORDER, { main: [], system: [] }))
  const [hidden, setHidden] = useState<string[]>(() => loadJSON<string[]>(LS_HIDDEN, []))
  const [dragItem, setDragItem] = useState<{ group: Group; to: string } | null>(null)

  useEffect(() => { localStorage.setItem(LS_COLLAPSED, JSON.stringify(collapsed)) }, [collapsed])
  useEffect(() => { localStorage.setItem(LS_ORDER, JSON.stringify(order)) }, [order])
  useEffect(() => { localStorage.setItem(LS_HIDDEN, JSON.stringify(hidden)) }, [hidden])

  const permitted = (item: NavItem): boolean => {
    if (item.superadminOnly && !isSuperAdmin) return false
    if (item.adminOnly && !isAdmin) return false
    if (item.perm && !can(item.perm)) return false
    return true
  }

  const hiddenSet = new Set(hidden)
  const mainItems = applyOrder(navMain.filter(permitted), order.main)
  const systemItems = applyOrder(navSystem.filter(permitted), order.system)
  const visibleMain = editing ? mainItems : mainItems.filter(i => !hiddenSet.has(i.to))
  const visibleSystem = editing ? systemItems : systemItems.filter(i => !hiddenSet.has(i.to))

  const handleLogout = async () => { await logout(); navigate('/login') }
  const closeSidebar = () => setSidebarOpen(false)
  const crumb = breadcrumbFor(location.pathname)

  const onDragStart = (group: Group, to: string) => setDragItem({ group, to })
  const onDropOn = (group: Group, to: string) => {
    if (!dragItem || dragItem.group !== group) { setDragItem(null); return }
    const current = (group === 'main' ? mainItems : systemItems).map(i => i.to)
    const next = reorder(current, dragItem.to, to)
    setOrder(o => ({ ...o, [group]: next }))
    setDragItem(null)
  }
  const toggleHidden = (to: string) =>
    setHidden(h => h.includes(to) ? h.filter(x => x !== to) : [...h, to])
  const resetNav = () => { setOrder({ main: [], system: [] }); setHidden([]) }

  const renderGroup = (label: string, items: NavItem[], group: Group, indexOffset: number) => (
    <div>
      {!collapsed && <p className="px-3 mb-2 text-[10px] font-semibold text-slate-600 uppercase tracking-widest">{label}</p>}
      <div className="space-y-1">
        {items.map((item, i) => (
          <SidebarLink
            key={item.to}
            item={item}
            delay={30 + (indexOffset + i) * 30}
            collapsed={collapsed && !editing}
            editing={editing}
            hidden={hiddenSet.has(item.to)}
            group={group}
            onNavigate={closeSidebar}
            onToggleHidden={toggleHidden}
            onDragStart={onDragStart}
            onDropOn={onDropOn}
          />
        ))}
      </div>
    </div>
  )

  const railCollapsed = collapsed && !editing

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-30 md:hidden"
          onClick={closeSidebar}
        />
      )}

      <aside className={clsx(
        'bg-slate-950 border-r border-slate-800/50 flex flex-col shrink-0 w-64',
        railCollapsed ? 'md:w-16' : 'md:w-64',
        'fixed inset-y-0 left-0 z-40 transition-[transform,width] duration-300 ease-in-out',
        'md:relative md:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      )}>
        {/* Header / logo */}
        <div className={clsx('border-b border-slate-800/50 flex items-center', railCollapsed ? 'px-3 py-5 justify-center' : 'px-5 py-5 justify-between')}>
          <Link to="/" className="flex items-center gap-2.5 group min-w-0" onClick={closeSidebar}>
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/30 group-hover:shadow-blue-500/50 transition-shadow duration-300 shrink-0">
              <Container className="w-5 h-5 text-white" />
            </div>
            {!railCollapsed && (
              <div className="min-w-0">
                <div className="text-base font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent tracking-tight">
                  OffDock
                </div>
                <div className="text-[10px] text-slate-500 uppercase tracking-widest -mt-0.5">
                  Deploy Manager
                </div>
              </div>
            )}
          </Link>
          {!railCollapsed && (
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                onClick={() => setEditing(e => !e)}
                title={editing ? 'Done customizing' : 'Customize navigation'}
                className={clsx(
                  'hidden md:flex p-1.5 rounded-lg transition-colors',
                  editing ? 'text-blue-300 bg-blue-500/15' : 'text-slate-500 hover:text-slate-200 hover:bg-slate-800',
                )}
              >
                <Settings className="w-4 h-4" />
              </button>
              <button
                onClick={() => setCollapsed(true)}
                title="Collapse sidebar"
                className="hidden md:flex p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Expand button when collapsed */}
        {railCollapsed && (
          <button
            onClick={() => setCollapsed(false)}
            title="Expand sidebar"
            className="hidden md:flex mx-auto mt-3 p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        )}

        {/* Edit-mode banner */}
        {editing && !collapsed && (
          <div className="mx-3 mt-3 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/25 text-[11px] text-blue-200 flex items-center gap-2">
            <GripVertical className="w-3.5 h-3.5 shrink-0" />
            Drag to reorder · eye toggles visibility
          </div>
        )}

        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-6">
          {renderGroup('Main', visibleMain, 'main', 0)}
          {renderGroup('System', visibleSystem, 'system', visibleMain.length)}
        </nav>

        {/* Customize controls */}
        {!railCollapsed && (
          <div className="px-3 pb-2">
            {editing ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setEditing(false)}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 rounded-lg hover:bg-emerald-500/15 transition-colors"
                >
                  <Check className="w-3.5 h-3.5" /> Done
                </button>
                <button
                  onClick={resetNav}
                  title="Reset to default order"
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-400 border border-slate-700 rounded-lg hover:text-slate-200 hover:bg-slate-800 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Reset
                </button>
              </div>
            ) : (
              <button
                onClick={() => setEditing(true)}
                className="flex items-center justify-center gap-2 w-full px-3 py-2 text-xs font-medium text-slate-300 bg-slate-800/60 border border-slate-700 rounded-lg hover:bg-slate-800 hover:text-white hover:border-slate-600 transition-all"
              >
                <Pencil className="w-3.5 h-3.5" /> Customize navigation
              </button>
            )}
          </div>
        )}

        {/* User footer */}
        <div className="px-3 py-3 border-t border-slate-800/50">
          <div className={clsx('flex items-center gap-3 mb-2', railCollapsed ? 'justify-center px-0' : 'px-2')}>
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-700 to-slate-800 border border-slate-700 flex items-center justify-center text-sm font-semibold text-slate-200 shrink-0"
                 title={railCollapsed ? user?.username : undefined}>
              {user?.username?.charAt(0).toUpperCase() ?? '?'}
            </div>
            {!railCollapsed && (
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-200 truncate leading-tight">{user?.username}</p>
                <div className="mt-0.5"><RoleBadge role={user?.role ?? 'viewer'} /></div>
              </div>
            )}
          </div>
          <button
            onClick={handleLogout}
            title={railCollapsed ? 'Sign out' : undefined}
            className={clsx(
              'flex items-center w-full text-xs font-medium text-slate-400 hover:text-red-400 hover:bg-red-500/5 border border-transparent hover:border-red-500/20 rounded-lg transition-all duration-200',
              railCollapsed ? 'justify-center px-2 py-2' : 'gap-2 px-3 py-2',
            )}
          >
            <LogOut className="w-3.5 h-3.5" />
            {!railCollapsed && 'Sign out'}
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col min-h-0 bg-slate-950 w-0 md:w-auto">
        <header className="h-14 border-b border-slate-800/50 bg-slate-950/80 backdrop-blur flex items-center px-4 md:px-6 shrink-0 gap-3">
          <button
            onClick={() => setSidebarOpen(s => !s)}
            className="md:hidden p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors shrink-0"
            aria-label="Open navigation"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 text-sm min-w-0">
            <Link to="/" className="text-slate-500 hover:text-slate-300 transition-colors shrink-0">OffDock</Link>
            <ChevronRight className="w-3.5 h-3.5 text-slate-700 shrink-0" />
            <span className="text-slate-200 font-medium truncate">{crumb}</span>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
