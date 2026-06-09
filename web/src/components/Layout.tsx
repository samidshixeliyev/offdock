import { useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { usePermissions, PERMS } from '../hooks/usePermissions'
import clsx from 'clsx'
import {
  LayoutDashboard, Boxes, Container, Globe, Network, HardDrive, FolderTree,
  Cpu, TerminalSquare, Activity, ScrollText, Users, LogOut, ChevronRight,
  MapPin, Settings, Radio, FileText, Menu, Layers, BookOpen,
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
  { to: '/system',      label: 'System',      icon: Cpu,           superadminOnly: true },
  { to: '/terminal',    label: 'Terminal',    icon: TerminalSquare, perm: PERMS.terminal },
  { to: '/traffic',     label: 'Traffic',     icon: Activity },
  { to: '/dns',         label: 'DNS',         icon: MapPin },
  { to: '/audit',       label: 'Audit Log',   icon: ScrollText },
  { to: '/users',       label: 'Users',       icon: Users,          superadminOnly: true },
  { to: '/tracing',     label: 'Net Traces',  icon: Radio },
  { to: '/otel-traces', label: 'App Traces',  icon: Layers },
  { to: '/app-logs',    label: 'App Logs',    icon: FileText },
  { to: '/settings',    label: 'Settings',    icon: Settings,       adminOnly: true },
  { to: '/help',        label: 'Help',        icon: BookOpen },
]

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

function SidebarLink({ item, delay, onNavigate }: { item: NavItem; delay: number; onNavigate?: () => void }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      style={{ animationDelay: `${delay}ms` }}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 opacity-0 animate-slideInLeft group',
          isActive
            ? 'bg-gradient-to-r from-blue-600/20 to-indigo-600/20 text-white border border-blue-500/30 shadow-lg shadow-blue-500/5'
            : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 border border-transparent',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={clsx('w-[18px] h-[18px] shrink-0 transition-colors', isActive ? 'text-blue-400' : 'text-slate-500 group-hover:text-slate-300')} />
          <span className="truncate">{item.label}</span>
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
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const visibleNavMain = navMain.filter(item => {
    if (item.superadminOnly && !isSuperAdmin) return false
    if (item.adminOnly && !isAdmin) return false
    if (item.perm && !can(item.perm)) return false
    return true
  })
  const visibleNavSystem = navSystem.filter(item => {
    if (item.superadminOnly && !isSuperAdmin) return false
    if (item.adminOnly && !isAdmin) return false
    if (item.perm && !can(item.perm)) return false
    return true
  })

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  const closeSidebar = () => setSidebarOpen(false)
  const crumb = breadcrumbFor(location.pathname)

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
        'w-64 bg-slate-950 border-r border-slate-800/50 flex flex-col shrink-0',
        'fixed inset-y-0 left-0 z-40 transition-transform duration-300 ease-in-out',
        'md:relative md:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      )}>
        <div className="px-5 py-5 border-b border-slate-800/50">
          <Link to="/" className="flex items-center gap-2.5 group" onClick={closeSidebar}>
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/30 group-hover:shadow-blue-500/50 transition-shadow duration-300">
              <Container className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="text-base font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent tracking-tight">
                OffDock
              </div>
              <div className="text-[10px] text-slate-500 uppercase tracking-widest -mt-0.5">
                Deploy Manager
              </div>
            </div>
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-6">
          <div>
            <p className="px-3 mb-2 text-[10px] font-semibold text-slate-600 uppercase tracking-widest">Main</p>
            <div className="space-y-1">
              {visibleNavMain.map((item, i) => <SidebarLink key={item.to} item={item} delay={30 + i * 30} onNavigate={closeSidebar} />)}
            </div>
          </div>
          <div>
            <p className="px-3 mb-2 text-[10px] font-semibold text-slate-600 uppercase tracking-widest">System</p>
            <div className="space-y-1">
              {visibleNavSystem.map((item, i) => <SidebarLink key={item.to} item={item} delay={30 + (visibleNavMain.length + i) * 30} onNavigate={closeSidebar} />)}
            </div>
          </div>
        </nav>

        <div className="px-3 py-3 border-t border-slate-800/50">
          <div className="flex items-center gap-3 px-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-700 to-slate-800 border border-slate-700 flex items-center justify-center text-sm font-semibold text-slate-200 shrink-0">
              {user?.username?.charAt(0).toUpperCase() ?? '?'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200 truncate leading-tight">{user?.username}</p>
              <div className="mt-0.5"><RoleBadge role={user?.role ?? 'viewer'} /></div>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 w-full px-3 py-2 text-xs font-medium text-slate-400 hover:text-red-400 hover:bg-red-500/5 border border-transparent hover:border-red-500/20 rounded-lg transition-all duration-200"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign out
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
