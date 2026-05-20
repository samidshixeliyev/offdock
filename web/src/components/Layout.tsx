import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import clsx from 'clsx'

const nav = [
  { to: '/', label: 'Dashboard', icon: '⬡' },
  { to: '/images', label: 'Images', icon: '📦' },
  { to: '/usb', label: 'Import', icon: '💾' },
  { to: '/system', label: 'System', icon: '📊' },
  { to: '/terminal', label: 'Terminal', icon: '⌨️' },
  { to: '/users', label: 'Users', icon: '👥' },
]

export default function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
        <div className="px-5 py-4 border-b border-gray-800">
          <Link to="/" className="text-lg font-bold text-white tracking-tight">
            Off<span className="text-blue-500">Dock</span>
          </Link>
          <p className="text-xs text-gray-500 mt-0.5">Offline deployment manager</p>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
          {nav.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors',
                  isActive
                    ? 'bg-blue-600/20 text-blue-400 font-medium'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                )
              }
            >
              <span className="text-base">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="px-4 py-3 border-t border-gray-800">
          <p className="text-xs text-gray-500 truncate mb-1">{user?.username}</p>
          <p className="text-xs text-gray-600 mb-2">{user?.role}</p>
          <button onClick={handleLogout} className="btn-ghost text-xs w-full justify-start">
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
