import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './hooks/useAuth'
import Layout from './components/Layout'

import LoginPage from './pages/LoginPage'
import SetupPage from './pages/SetupPage'
import DashboardPage from './pages/DashboardPage'
import ProjectsNewPage from './pages/ProjectsNewPage'
import ProjectDashboardPage from './pages/ProjectDashboardPage'
import ComposePage from './pages/ComposePage'
import EnvPage from './pages/EnvPage'
import NginxPage from './pages/NginxPage'
import DeployPage from './pages/DeployPage'
import LogsPage from './pages/LogsPage'
import ImagesPage from './pages/ImagesPage'
import UsersPage from './pages/UsersPage'
import SystemPage from './pages/SystemPage'
import TerminalPage from './pages/TerminalPage'
import ReverseProxyPage from './pages/ReverseProxyPage'
import ContainersPage from './pages/ContainersPage'
import NetworksPage from './pages/NetworksPage'
import VolumesPage from './pages/VolumesPage'
import FilesPage from './pages/FilesPage'
import AuditPage from './pages/AuditPage'
import TrafficPage from './pages/TrafficPage'
import DNSPage from './pages/DNSPage'
import SettingsPage from './pages/SettingsPage'
import TracingPage from './pages/TracingPage'
import DocsPage from './pages/DocsPage'
import AppLogsPage from './pages/AppLogsPage'
import OTelTracesPage from './pages/OTelTracesPage'
import HelpPage from './pages/HelpPage'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="flex items-center justify-center h-screen text-slate-400">Loading…</div>
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<DashboardPage />} />
            <Route path="/projects/new" element={<ProjectsNewPage />} />
            <Route path="/projects/:id" element={<ProjectDashboardPage />} />
            <Route path="/projects/:id/compose" element={<ComposePage />} />
            <Route path="/projects/:id/env" element={<EnvPage />} />
            <Route path="/projects/:id/nginx" element={<NginxPage />} />
            <Route path="/projects/:id/deploy" element={<DeployPage />} />
            <Route path="/projects/:id/logs" element={<LogsPage />} />
            <Route path="/images" element={<ImagesPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/system" element={<SystemPage />} />
            <Route path="/terminal" element={<TerminalPage />} />
            <Route path="/proxy" element={<ReverseProxyPage />} />
            <Route path="/containers" element={<ContainersPage />} />
            <Route path="/networks" element={<NetworksPage />} />
            <Route path="/volumes" element={<VolumesPage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/traffic" element={<TrafficPage />} />
            <Route path="/dns" element={<DNSPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/tracing" element={<TracingPage />} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="/app-logs" element={<AppLogsPage />} />
            <Route path="/otel-traces" element={<OTelTracesPage />} />
            <Route path="/help" element={<HelpPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
