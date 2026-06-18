// Typed API client — the only place raw fetch is called in the frontend.

export interface User {
  id: string
  username: string
  email: string
  role: 'superadmin' | 'admin' | 'viewer'
  custom_role_id: string
  permissions: string[]
  project_ids: string[]
  oauth_subject: string
  oauth_provider: string
  created_by: string
  created_at: string
  updated_at: string
  active: boolean
  host_terminal_access?: 'otp' | 'bypass' | 'disabled'
}

export interface PermissionInfo { key: string; label: string }

export interface CustomRole {
  id: string
  name: string
  permissions: string[]
  created_at: string
  updated_at: string
}

export interface Session {
  id: string
  user_id: string
  username: string
  ip: string
  user_agent: string
  created_at: string
  last_seen: string
  revoked: boolean
}

export interface Project {
  id: string
  name: string
  description: string
  status: 'running' | 'stopped' | 'error' | 'degraded'
  created_at: string
  updated_at: string
}

export interface ComposeConfig {
  id: string
  project_id: string
  version: number
  raw_yaml: string
  created_at: string
  created_by: string
}

export interface EnvVar {
  key: string
  value: string
  is_secret: boolean
}

export interface EnvVarSet {
  id: string
  project_id: string
  version: number
  vars: EnvVar[]
  created_at: string
  created_by: string
}

export interface NginxConfig {
  id: string
  project_id: string
  domain: string
  ssl_enabled: boolean
  ssl_pem_path: string
  upstream_host: string
  upstream_port: number
  client_max_body_size: string
  proxy_read_timeout: number
  gzip_enabled: boolean
  custom_directives: string
  generated_config: string
  active: boolean
  applied: boolean
  applied_at: string | null
  created_at: string
}

export interface DeploymentRecord {
  id: string
  project_id: string
  triggered_by: string
  strategy: string
  old_compose_version: number
  new_compose_version: number
  env_version: number
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
  started_at: string
  finished_at: string | null
  log_text: string
}

export interface DeploySettings {
  id: string
  project_id: string
  health_timeout_secs: number
  deploy_timeout_secs: number
  health_stable_secs: number
  rollback_on_failure?: boolean
  dns_servers?: string[]
  dns_search?: string[]
  extra_hosts?: string[]
  // Per-service image override (service name → repo:tag) to deploy a specific
  // previously-loaded image version without editing the compose YAML.
  image_overrides?: Record<string, string>
  webhook_url?: string
  // OpenTelemetry — one toggle, everything auto-configured (native OTLP receiver)
  otel_enabled?: boolean
  // Manual language overrides: service name → "java"|"nodejs"|"php"|"python"|"ruby"|"dotnet"|"go"|"none"
  otel_language_overrides?: Record<string, string>
}

export interface ComposeServiceInfo {
  name: string
  image: string
  detected_langs: string[] | null
}

// ─── OpenTelemetry / Jaeger types ──────────────────────────────────────────

export interface OTelTag {
  key: string
  type: string
  value: string | number | boolean
}

export interface OTelSpanRef {
  refType: 'CHILD_OF' | 'FOLLOWS_FROM'
  traceID: string
  spanID: string
}

export interface OTelSpanLog {
  timestamp: number    // microseconds since epoch
  fields: OTelTag[]
}

export interface OTelSpan {
  traceID: string
  spanID: string
  operationName: string
  references: OTelSpanRef[]
  startTime: number    // microseconds since epoch
  duration: number     // microseconds
  tags: OTelTag[]
  logs: OTelSpanLog[] | null   // span events (exception stack traces, custom events)
  processID: string
  warnings: string[] | null
  scopeName?: string
  scopeVersion?: string
}

export interface OTelProcess {
  serviceName: string
  tags: OTelTag[]
}

export interface OTelTrace {
  traceID: string
  spans: OTelSpan[]
  processes: Record<string, OTelProcess>
  warnings: string[] | null
}

export interface OTelTraceSummary {
  traceID: string
  rootSpan: OTelSpan
  service: string
  spans: number
  duration: number   // microseconds
  startTime: number  // microseconds
  hasError: boolean
}

export interface OTelStatus {
  available: boolean
  message?: string
  otlp_http?: string   // e.g. http://HOST_IP:7070/v1/traces
  span_count?: number
}

export interface DiskUsageRow {
  type: string
  total: string
  active: string
  size: string
  reclaimable: string
}

export interface DockerImage {
  id: string
  project_id: string
  image_name: string
  image_tag: string
  tar_file_path: string
  loaded_at: string
  size_bytes: number
  docker_image_id: string
}

export interface ImageUsage {
  image_id: string
  repository: string
  tag: string
  size: string
  created_at: string
  in_use: boolean
  used_by: string[]
  tracked: boolean
  db_id: string
}

export interface ImageUsageResult {
  images: ImageUsage[]
  total: number
  in_use: number
  unused: number
}

export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  is_symlink: boolean
  size: number
  mode: string
  mod_time: string
  mime: string
}

export interface FileReadResult {
  path: string
  name: string
  content: string
  size: number
  mode: string
  mod_time: string
  is_binary: boolean
  mime: string
  truncated: boolean
}

export interface ContainerInfo {
  ID: string
  Names: string
  Image: string
  Status: string
  Ports: string
  State: string
  Labels?: string
}

export interface SystemStats {
  cpu_percent: number
  ram_total_bytes: number
  ram_used_bytes: number
  ram_free_bytes: number
  ram_cached_bytes: number
  disk_total_bytes: number
  disk_used_bytes: number
  load_avg: [number, number, number]
  uptime_secs: number
  containers: ContainerStats[]
  timestamp: string
}

export interface NetworkContainer {
  name: string
  id: string
}

export interface NetworkInfo {
  name: string
  exists: boolean
  containers: NetworkContainer[]
}

export interface Networks {
  external: NetworkInfo
  internal: NetworkInfo
}

export interface NginxEntry {
  project: Project
  config: NginxConfig | null
}


export interface RecentDeployment extends DeploymentRecord {
  project_name: string
}

export interface ProxyLocation {
  path: string
  upstream_host: string
  upstream_port: number
  strip_prefix: boolean
  ws_enabled: boolean
}

export interface ProxyHost {
  id: string
  domain: string
  aliases: string[]
  upstream_host: string
  upstream_port: number
  ssl_enabled: boolean
  ssl_pem_path: string
  client_max_body_size: string
  proxy_read_timeout: number
  gzip_enabled: boolean
  custom_directives: string
  locations: ProxyLocation[]
  access_log: boolean
  enabled: boolean
  created_at: string
  updated_at: string
}

export type ProxyHostInput = Omit<ProxyHost, 'id' | 'enabled' | 'created_at' | 'updated_at'>

export interface DockerNetworkContainer {
  Name: string
  IPv4: string
}

export interface DockerNetworkIPAMConfig {
  Subnet: string
  Gateway: string
}

export interface DockerNetwork {
  Id: string
  Name: string
  Driver: string
  Scope: string
  Internal: boolean
  Labels: Record<string, string> | null
  Containers: Record<string, DockerNetworkContainer> | null
  IPAM: { Config: DockerNetworkIPAMConfig[] }
}

export interface DockerVolume {
  Name: string
  Driver: string
  Scope: string
  Mountpoint: string
  Labels: Record<string, string> | null
  CreatedAt: string
}


export interface ContainerStats {
  name: string
  CPUPerc: string
  MemUsage: string
  MemPerc: string
  NetIO: string
  BlockIO: string
  PIDs: string
}

export interface AuditEvent {
  id: string
  user_id: string
  username: string
  action: string
  resource_type: string
  resource_id: string
  resource_name: string
  details: string
  ip_addr: string
  created_at: string
}

export interface TrafficCount { key: string; count: number }
export interface TrafficBucket { t: string; count: number; bytes: number; err: number; avg_ms: number }
export interface TrafficEntry {
  time: string; ip: string; method: string; path: string
  status: number; bytes: number; referer: string; user_agent: string; host: string
  response_ms: number; upstream_ms: number; upstream_addr: string
}
export interface TrafficSummary {
  total: number; bytes: number
  status_2xx: number; status_3xx: number; status_4xx: number; status_5xx: number
  unique_ips: number; rps: number; window_hours: number
  avg_response_ms: number; p95_response_ms: number; p99_response_ms: number
  avg_bytes_per_req: number
}
export interface HostStat {
  host: string; total: number; bytes: number; errors: number
  error_rate: number; avg_ms: number; p95_ms: number
}
export interface TrafficReport {
  summary: TrafficSummary
  series: TrafficBucket[]
  top_paths: TrafficCount[]
  top_ips: TrafficCount[]
  by_host: TrafficCount[]
  by_status: TrafficCount[]
  methods: TrafficCount[]
  recent: TrafficEntry[]
  hosts: string[]
  slow_requests: TrafficEntry[]
  by_upstream: TrafficCount[]
  host_stats: HostStat[]
  top_user_agents: TrafficCount[]
}
export interface TraceEvent {
  time: string
  type: 'http_req' | 'http_resp' | 'sql' | 'redis' | 'info' | 'error'
  method?: string; path?: string; host?: string; status?: number
  duration_ms?: number
  query?: string; db_type?: string
  src?: string; dst?: string; dst_port?: number
  message?: string
  // Span correlation
  span_id?: string
  parent_span_id?: string
  // SQL enrichment
  table_name?: string
  rows_affected?: number
}

export interface TraceSessionSummary {
  id: string
  container_name: string
  started_at: string
  ended_at: string | null
  event_count: number
  http_count: number
  sql_count: number
  redis_count: number
}

export interface TraceSession {
  id: string
  container_name: string
  started_at: string
  ended_at: string | null
  event_count: number
  events: TraceEvent[]
}

export interface NetworkConnection {
  proto: string; local_addr: string; local_port: number
  remote_addr: string; remote_port: number; state: string
  pid: number; program: string
}
export interface InterfaceStat {
  name: string; rx_bytes: number; tx_bytes: number; rx_pkts: number; tx_pkts: number
}
export interface ListenPort {
  proto: string; addr: string; port: number; program: string; pid: number
}
export interface ConnectionsReport {
  connections: NetworkConnection[]
  interfaces: InterfaceStat[]
  listen_ports: ListenPort[]
  snapshot: string
}

export interface DeployTag {
  id: string
  project_id: string
  name: string
  description: string
  compose_version: number
  env_version: number
  created_by: string
  created_at: string
  protected?: boolean
}

export type DNSTicketStatus = 'pending' | 'sent' | 'approved' | 'rejected'
export interface DNSTicket {
  id: string; record_type: string; hostname: string; value: string
  ttl: number; priority: number; notes: string
  status: DNSTicketStatus; requested_by: string; email_sent_to: string
  created_at: string; updated_at: string
}
export interface SMTPSettings {
  host: string; port: number; username: string; password_set: boolean
  from: string; from_name: string; mode: string; starttls: boolean; insecure_skip_verify: boolean
  ca_cert_file: string; client_cert_file: string; client_key_file: string
  dns_admin_email: string; configured: boolean
  otp_subject: string; otp_body: string
  dns_subject: string; dns_body: string
}

export interface UsbDrive {
  mount_point: string
  label: string
  free_bytes: number
  total_bytes: number
}

export interface OAuthSettings {
  enabled: boolean
  issuer: string
  client_id: string
  secret_set: boolean
  redirect_uri: string
  post_logout_redirect_uri: string
  scope: string
  claim_email: string
  claim_username: string
  claim_name: string
  ca_cert_file: string
  tls_skip_verify: boolean
}

export interface RetentionSettings {
  otel_spans_max_count: number
  otel_spans_max_age_days: number
  trace_sessions_max_count: number
  trace_sessions_max_age_days: number
  audit_events_max_count: number
  audit_events_max_age_days: number
  app_logs_max_lines: number
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(res.status, body.error ?? res.statusText)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  // Auth
  login: (username: string, password: string) =>
    request<{ id: string; username: string; role: User['role'] }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<void>('/api/v1/auth/logout', { method: 'POST' }),
  me: () => request<User>('/api/v1/auth/me'),
  setupStatus: () => request<{ setup_required: boolean }>('/api/v1/setup'),
  setupCreate: (username: string, password: string, email?: string) =>
    request<User>('/api/v1/setup', { method: 'POST', body: JSON.stringify({ username, password, email }) }),

  // Users
  listUsers: () => request<User[]>('/api/v1/users'),
  createUser: (data: { username: string; email?: string; password: string; role: User['role']; custom_role_id?: string; permissions?: string[]; project_ids?: string[] }) =>
    request<User>('/api/v1/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id: string, data: { role?: User['role']; email?: string; active?: boolean; custom_role_id?: string; permissions?: string[]; project_ids?: string[]; password?: string; host_terminal_access?: 'otp' | 'bypass' | 'disabled' }) =>
    request<User>(`/api/v1/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteUser: (id: string) =>
    request<void>(`/api/v1/users/${id}`, { method: 'DELETE' }),
  userAudit: (id: string) => request<AuditEvent[]>(`/api/v1/users/${id}/audit`),

  // Permissions, custom roles, sessions
  listPermissions: () => request<PermissionInfo[]>('/api/v1/permissions'),
  listRoles: () => request<CustomRole[]>('/api/v1/roles'),
  createRole: (data: { name: string; permissions: string[] }) =>
    request<CustomRole>('/api/v1/roles', { method: 'POST', body: JSON.stringify(data) }),
  updateRole: (id: string, data: { name?: string; permissions?: string[] }) =>
    request<CustomRole>(`/api/v1/roles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteRole: (id: string) => request<void>(`/api/v1/roles/${id}`, { method: 'DELETE' }),
  listSessions: (userId?: string) => request<Session[]>(`/api/v1/sessions${userId ? `?user_id=${userId}` : ''}`),
  revokeSession: (id: string) => request<void>(`/api/v1/sessions/${id}`, { method: 'DELETE' }),

  // Projects
  listProjects: () => request<Project[]>('/api/v1/projects'),
  // Refresh all project statuses from live container state (single docker ps).
  syncAllProjects: () => request<Project[]>('/api/v1/projects/sync-all', { method: 'POST' }),
  createProject: (data: { name: string; description?: string }) =>
    request<Project>('/api/v1/projects', { method: 'POST', body: JSON.stringify(data) }),
  getProject: (id: string) => request<Project>(`/api/v1/projects/${id}`),
  updateProject: (id: string, data: { name?: string; description?: string }) =>
    request<Project>(`/api/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (id: string) =>
    request<void>(`/api/v1/projects/${id}`, { method: 'DELETE' }),

  // Compose
  getCompose: (projectId: string) =>
    request<ComposeConfig | null>(`/api/v1/projects/${projectId}/compose`),
  saveCompose: async (projectId: string, rawYaml: string): Promise<{ config: ComposeConfig; unchanged: boolean }> => {
    const res = await request<ComposeConfig | { unchanged: true; config: ComposeConfig }>(
      `/api/v1/projects/${projectId}/compose`,
      { method: 'POST', body: JSON.stringify({ raw_yaml: rawYaml }) },
    )
    if (res && typeof res === 'object' && 'unchanged' in res) {
      return { config: res.config, unchanged: true }
    }
    return { config: res as ComposeConfig, unchanged: false }
  },
  composeHistory: (projectId: string) =>
    request<ComposeConfig[]>(`/api/v1/projects/${projectId}/compose/history`),
  deleteComposeVersion: (projectId: string, version: number) =>
    request<void>(`/api/v1/projects/${projectId}/compose/${version}`, { method: 'DELETE' }),

  // Env vars
  getEnv: (projectId: string) =>
    request<EnvVarSet | null>(`/api/v1/projects/${projectId}/env`),
  saveEnv: async (projectId: string, vars: EnvVar[]): Promise<{ env: EnvVarSet; unchanged: boolean }> => {
    const res = await request<EnvVarSet | { unchanged: true; env: EnvVarSet }>(
      `/api/v1/projects/${projectId}/env`,
      { method: 'POST', body: JSON.stringify({ vars }) },
    )
    if (res && typeof res === 'object' && 'unchanged' in res) {
      return { env: res.env, unchanged: true }
    }
    return { env: res as EnvVarSet, unchanged: false }
  },
  // reveal=true decrypts secret values (superadmin only, audited server-side).
  envHistory: (projectId: string, reveal = false) =>
    request<EnvVarSet[]>(`/api/v1/projects/${projectId}/env/history${reveal ? '?reveal=true' : ''}`),
  restoreEnv: (projectId: string, version: number) =>
    request<EnvVarSet>(`/api/v1/projects/${projectId}/env/restore`, {
      method: 'POST', body: JSON.stringify({ version }),
    }),
  deleteEnvVersion: (projectId: string, version: number) =>
    request<void>(`/api/v1/projects/${projectId}/env/${version}`, { method: 'DELETE' }),

  // Docker networks
  listNetworks: () => request<Networks>('/api/v1/networks'),
  networkConnect: (network: string, container: string) =>
    request<{ status: string }>(`/api/v1/networks/${network}/containers/${container}`, { method: 'POST' }),
  networkDisconnect: (network: string, container: string) =>
    request<{ status: string }>(`/api/v1/networks/${network}/containers/${container}`, { method: 'DELETE' }),
  containerNetworks: (container: string) =>
    request<{ networks: string[] }>(`/api/v1/containers/${container}/networks`),

  // Nginx — system (native nginx on host)
  getNginxSystemStatus: () =>
    request<{ available: boolean; status: string }>('/api/v1/nginx/system/status'),
  getSelfNginxConfig: (domain: string, port?: number) => {
    const params = new URLSearchParams({ domain })
    if (port) params.set('port', String(port))
    return request<{ config: string; domain: string; port: string }>(
      `/api/v1/nginx/system/self-config?${params.toString()}`,
    )
  },
  applySelfNginxConfig: (domain: string, port?: number) =>
    request<{ status: string; config_path: string; test_output: string }>(
      '/api/v1/nginx/system/self-config',
      { method: 'POST', body: JSON.stringify({ domain, port: port ?? 7070 }) },
    ),

  // Nginx — global view
  listAllNginx: () => request<NginxEntry[]>('/api/v1/nginx'),
  removeNginx: (projectId: string) =>
    request<void>(`/api/v1/projects/${projectId}/nginx`, { method: 'DELETE' }),
  // Nginx — per project
  getNginx: (projectId: string) =>
    request<NginxConfig | null>(`/api/v1/projects/${projectId}/nginx`),
  saveNginx: (projectId: string, data: Partial<NginxConfig>) =>
    request<NginxConfig>(`/api/v1/projects/${projectId}/nginx`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  applyNginx: (projectId: string) =>
    request<{ config_path: string; nginx_test_output: string }>(
      `/api/v1/projects/${projectId}/nginx/apply`,
      { method: 'POST' }
    ),
  previewNginx: (projectId: string) =>
    request<{ config: string }>(`/api/v1/projects/${projectId}/nginx/preview`),
  generateCert: (projectId: string, opts: {
    domain: string
    dns_names?: string[]
    ip_addresses?: string[]
    organization?: string
    country?: string
    days?: number
  }) =>
    request<{
      pem_path: string
      domain: string
      dns_names: string[]
      ip_addresses: string[]
      days: string
      valid_until: string
    }>(
      `/api/v1/projects/${projectId}/nginx/cert`,
      { method: 'POST', body: JSON.stringify({ days: 365, ...opts }) }
    ),

  // Proxy hosts
  listProxyHosts: () => request<ProxyHost[]>('/api/v1/proxy/hosts'),
  createProxyHost: (data: ProxyHostInput) =>
    request<ProxyHost>('/api/v1/proxy/hosts', { method: 'POST', body: JSON.stringify(data) }),
  previewProxyHost: (data: ProxyHostInput) =>
    request<{ config: string }>('/api/v1/proxy/hosts/preview', { method: 'POST', body: JSON.stringify(data) }),
  updateProxyHost: (id: string, data: ProxyHostInput) =>
    request<ProxyHost>(`/api/v1/proxy/hosts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  toggleProxyHost: (id: string) =>
    request<ProxyHost>(`/api/v1/proxy/hosts/${id}/toggle`, { method: 'POST' }),
  deleteProxyHost: (id: string) =>
    request<void>(`/api/v1/proxy/hosts/${id}`, { method: 'DELETE' }),
  testProxyHost: (id: string) =>
    request<{
      ok: boolean
      status_code?: number
      status?: string
      error?: string
      dns_resolved: boolean
      dns_addrs?: string[]
      dns_points_here: boolean
      server_ip: string
      nginx_ok: boolean
      nginx_error?: string
      hints: string[]
    }>(`/api/v1/proxy/hosts/${id}/test`),
  serverIP: () => request<{ ip: string; tip: string }>('/api/v1/proxy/server-ip'),

  // Docker network management (full)
  listAllDockerNetworks: () => request<DockerNetwork[]>('/api/v1/docker/networks'),
  createDockerNetwork: (name: string, driver: string) =>
    request<DockerNetwork>('/api/v1/docker/networks', { method: 'POST', body: JSON.stringify({ name, driver }) }),
  deleteDockerNetwork: (name: string) =>
    request<void>(`/api/v1/docker/networks/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  dockerNetworkConnect: (network: string, container: string) =>
    request<void>(`/api/v1/docker/networks/${encodeURIComponent(network)}/connect`, { method: 'POST', body: JSON.stringify({ container }) }),
  dockerNetworkDisconnect: (network: string, container: string) =>
    request<void>(`/api/v1/docker/networks/${encodeURIComponent(network)}/disconnect`, { method: 'POST', body: JSON.stringify({ container }) }),

  // Docker volume management
  listVolumes: () => request<DockerVolume[]>('/api/v1/docker/volumes'),
  createVolume: (name: string, driver?: string) =>
    request<DockerVolume>('/api/v1/docker/volumes', { method: 'POST', body: JSON.stringify({ name, driver: driver ?? 'local' }) }),
  deleteVolume: (name: string) =>
    request<void>(`/api/v1/docker/volumes/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  pruneVolumes: () =>
    request<{ pruned: string[]; space_reclaimed: string }>('/api/v1/docker/volumes/prune', { method: 'POST' }),

  // Deploy — global recent list
  listAllDeployments: () => request<RecentDeployment[]>('/api/v1/deployments'),
  // Deploy — per project
  triggerDeploy: (projectId: string, composeVersion?: number, envVersion?: number) =>
    request<{ deployment_id: string; stream: string }>(
      `/api/v1/projects/${projectId}/deploy`,
      { method: 'POST', body: JSON.stringify({ compose_version: composeVersion ?? 0, env_version: envVersion ?? 0 }) }
    ),
  listDeployments: (projectId: string) =>
    request<DeploymentRecord[]>(`/api/v1/projects/${projectId}/deployments`),
  getDeployment: (projectId: string, depId: string) =>
    request<DeploymentRecord>(`/api/v1/projects/${projectId}/deployments/${depId}`),
  cancelDeploy: (projectId: string, depId: string) =>
    request<{ status: string }>(`/api/v1/projects/${projectId}/deployments/${depId}/cancel`, { method: 'POST' }),
  deleteDeployment: (projectId: string, depId: string) =>
    request<void>(`/api/v1/projects/${projectId}/deployments/${depId}`, { method: 'DELETE' }),
  getDeploySettings: (projectId: string) =>
    request<DeploySettings>(`/api/v1/projects/${projectId}/deploy-settings`),
  // Deploy tags
  listDeployTags: (projectId: string) => request<DeployTag[]>(`/api/v1/projects/${projectId}/deploy-tags`),
  createDeployTag: (projectId: string, data: { name: string; description?: string; compose_version?: number; env_version?: number; protected?: boolean }) =>
    request<DeployTag>(`/api/v1/projects/${projectId}/deploy-tags`, { method: 'POST', body: JSON.stringify(data) }),
  deleteDeployTag: (projectId: string, tagId: string) =>
    request<void>(`/api/v1/projects/${projectId}/deploy-tags/${tagId}`, { method: 'DELETE' }),

  saveDeploySettings: (projectId: string, data: Omit<DeploySettings, 'id' | 'project_id'>) =>
    request<DeploySettings>(`/api/v1/projects/${projectId}/deploy-settings`, {
      method: 'PUT', body: JSON.stringify(data),
    }),

  getComposeServices: (projectId: string) =>
    request<{ services: ComposeServiceInfo[] }>(`/api/v1/projects/${projectId}/compose/services`),

  // Containers — per-project
  listContainers: (projectId: string) =>
    request<ContainerInfo[]>(`/api/v1/projects/${projectId}/containers`),
  syncProjectStatus: (projectId: string) =>
    request<Project>(`/api/v1/projects/${projectId}/sync`, { method: 'POST' }),
  containerAction: (projectId: string, name: string, action: 'restart' | 'stop' | 'start') =>
    request<{ status: string; action: string; container: string }>(
      `/api/v1/projects/${projectId}/containers/${encodeURIComponent(name)}/${action}`,
      { method: 'POST' }
    ),

  // Containers — global (all containers on host)
  listAllContainers: () => request<ContainerInfo[]>('/api/v1/containers'),
  containerStats: () => request<ContainerStats[]>('/api/v1/containers/stats'),
  deleteContainer: (name: string) =>
    request<{ status: string; container: string }>(
      `/api/v1/containers/${encodeURIComponent(name)}`,
      { method: 'DELETE' }
    ),
  globalContainerAction: (name: string, action: 'restart' | 'stop' | 'start') =>
    request<{ status: string; action: string; container: string }>(
      `/api/v1/containers/${encodeURIComponent(name)}/${action}`,
      { method: 'POST' }
    ),


  // Images
  listImages: () => request<DockerImage[]>('/api/v1/images'),
  imageUsage: () => request<ImageUsageResult>('/api/v1/images/usage'),
  loadImage: (data: { tar_file_path: string; project_id?: string; image_name?: string; image_tag?: string }) =>
    request<{ loaded: number; images: DockerImage[] }>('/api/v1/images/load', { method: 'POST', body: JSON.stringify(data) }),
  syncImages: () =>
    request<{ synced: number; images: DockerImage[] }>('/api/v1/images/sync', { method: 'POST' }),
  deleteImage: (id: string) => request<void>(`/api/v1/images/${id}`, { method: 'DELETE' }),
  removeImageByRef: (data: { ref?: string; image_id?: string; force?: boolean }) =>
    request<{ status: string }>('/api/v1/images/remove', { method: 'POST', body: JSON.stringify(data) }),

  // Terminal / exec
  execCommand: (command: string, cwd?: string) =>
    request<{ stdout: string; stderr: string; exit_code: number; cwd: string }>(
      '/api/v1/terminal/exec',
      { method: 'POST', body: JSON.stringify({ command, cwd: cwd ?? '' }) }
    ),
  // Returns either a challenge (otp mode) or {bypass:true} (bypass mode — no OTP).
  otpRequest: () =>
    request<{ challenge_id?: string; email?: string; expires_in?: number; bypass?: boolean; message?: string }>(
      '/api/v1/terminal/otp/request', { method: 'POST', body: '{}' }
    ),
  otpVerify: (challenge_id: string, code: string) =>
    request<{ terminal_token: string; expires_in: number }>(
      '/api/v1/terminal/otp/verify', { method: 'POST', body: JSON.stringify({ challenge_id, code }) }
    ),

  // Proxy status probe (server-side HTTP check to avoid CORS)
  proxyStatus: (url: string) =>
    request<{ accessible: boolean; status?: number }>(`/api/v1/proxy/status?url=${encodeURIComponent(url)}`),

  // File system explorer
  fileBrowse: (path: string) =>
    request<FileEntry[]>(`/api/v1/files/browse?path=${encodeURIComponent(path)}`),
  fileRead: (path: string) =>
    request<FileReadResult>(`/api/v1/files/read?path=${encodeURIComponent(path)}`),
  fileSearch: (path: string, q: string) =>
    request<FileEntry[]>(`/api/v1/files/search?path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`),
  fileWrite: (path: string, content: string) =>
    request<{ status: string; path: string }>('/api/v1/files/write', {
      method: 'POST', body: JSON.stringify({ path, content }),
    }),
  fileMkdir: (path: string) =>
    request<{ status: string; path: string }>('/api/v1/files/mkdir', {
      method: 'POST', body: JSON.stringify({ path }),
    }),
  fileRename: (from: string, to: string) =>
    request<{ status: string }>('/api/v1/files/rename', {
      method: 'POST', body: JSON.stringify({ from, to }),
    }),
  fileDelete: (path: string) =>
    request<{ status: string; path: string }>(
      `/api/v1/files/delete?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' }
    ),
  fileDownloadUrl: (path: string) =>
    `/api/v1/files/read?path=${encodeURIComponent(path)}&download=1`,

  // Audit log
  listAuditEvents: (params?: { limit?: number; resource_type?: string; action?: string }) => {
    const qs = new URLSearchParams()
    if (params?.limit !== undefined) qs.set('limit', String(params.limit))
    if (params?.resource_type) qs.set('resource_type', params.resource_type)
    if (params?.action) qs.set('action', params.action)
    const q = qs.toString()
    return request<AuditEvent[]>(`/api/v1/audit${q ? `?${q}` : ''}`)
  },

  // Traffic analytics
  traffic: (hours = 24, host?: string) => {
    const qs = new URLSearchParams({ hours: String(hours) })
    if (host) qs.set('host', host)
    return request<TrafficReport>(`/api/v1/traffic?${qs.toString()}`)
  },
  trafficConnections: () => request<ConnectionsReport>('/api/v1/traffic/connections'),

  // File import
  fileImport: (source: string, dest: string, action: 'copy' | 'move' = 'copy') =>
    request<{ source: string; dest: string; action: string; size: number }>('/api/v1/files/import', {
      method: 'POST', body: JSON.stringify({ source, dest, action }),
    }),
  listUploads: () => request<FileEntry[]>('/api/v1/uploads'),

  // DNS tickets
  listDNSTickets: () => request<DNSTicket[]>('/api/v1/dns/tickets'),
  createDNSTicket: (data: Partial<DNSTicket>) =>
    request<DNSTicket>('/api/v1/dns/tickets', { method: 'POST', body: JSON.stringify(data) }),
  updateDNSTicket: (id: string, data: Partial<DNSTicket>) =>
    request<DNSTicket>(`/api/v1/dns/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDNSTicket: (id: string) => request<void>(`/api/v1/dns/tickets/${id}`, { method: 'DELETE' }),
  sendDNSTicket: (id: string, to?: string, template?: string) =>
    request<{ status: string; sent_to: string; ticket: DNSTicket }>(`/api/v1/dns/tickets/${id}/send`, {
      method: 'POST', body: JSON.stringify({ to, template }),
    }),
  getSMTPSettings: () => request<SMTPSettings>('/api/v1/dns/settings'),
  saveSMTPSettings: (data: Partial<SMTPSettings> & { password?: string }) =>
    request<{ status: string }>('/api/v1/dns/settings', { method: 'POST', body: JSON.stringify(data) }),
  testSMTPSettings: (to: string) =>
    request<{ status: string; to: string }>('/api/v1/dns/settings/test', {
      method: 'POST', body: JSON.stringify({ to }),
    }),

  // OAuth2 / SSO settings
  oauthStatus: () => request<{ enabled: boolean; issuer: string }>('/api/v1/auth/oauth/status'),
  getOAuthSettings: () => request<OAuthSettings>('/api/v1/settings/oauth'),
  saveOAuthSettings: (data: Partial<OAuthSettings> & { client_secret?: string; tls_skip_verify?: boolean }) =>
    request<{ status: string }>('/api/v1/settings/oauth', { method: 'POST', body: JSON.stringify(data) }),
  // Container deep tracing
  getTraceStatus: () => request<{ traced: string[] }>('/api/v1/trace/status'),
  enableTrace: (name: string) =>
    request<{ status: string }>(`/api/v1/containers/${encodeURIComponent(name)}/trace/enable`, { method: 'POST', body: '{}' }),
  disableTrace: (name: string) =>
    request<void>(`/api/v1/containers/${encodeURIComponent(name)}/trace/enable`, { method: 'DELETE' }),
  traceUrl: (name: string) => `/api/v1/containers/${encodeURIComponent(name)}/trace`,
  // Persisted trace sessions
  listTraceSessions: () => request<TraceSessionSummary[]>('/api/v1/trace/sessions'),
  getTraceSession: (id: string) => request<TraceSession>(`/api/v1/trace/sessions/${id}`),
  deleteTraceSession: (id: string) =>
    request<void>(`/api/v1/trace/sessions/${id}`, { method: 'DELETE' }),

  oauthLoginUrl: (force?: boolean) =>
    `/api/v1/auth/oauth/start${force ? '?force=true' : ''}`,
  oauthLogoutUrl: () => `/api/v1/auth/oauth/logout`,

  // USB drive browser
  listDrives: () => request<UsbDrive[]>('/api/v1/usb/drives'),
  browseDrive: (mountPoint: string, path: string) =>
    request<FileEntry[]>(`/api/v1/usb/browse?mount=${encodeURIComponent(mountPoint)}&path=${encodeURIComponent(path)}`),
  readUsbFile: (mountPoint: string, path: string) =>
    request<{ content: string; path: string }>(`/api/v1/usb/read?mount=${encodeURIComponent(mountPoint)}&path=${encodeURIComponent(path)}`),

  // System backup — triggers a file download
  downloadBackup: (): void => {
    window.open('/api/v1/system/backup')
  },

  // App logs
  getAppLogs: (n = 500) => request<{ source: string; lines: string[] }>(`/api/v1/system/app-logs?n=${n}`),
  appLogsStreamUrl: () => '/api/v1/system/app-logs/stream',

  // OpenTelemetry / Jaeger proxy
  otelStatus: () => request<OTelStatus>('/api/v1/otel/status'),
  otelServices: () => request<{ data: string[] }>('/api/v1/otel/services'),
  otelOperations: (service: string) =>
    request<{ data: Array<{ name: string; spanKind: string }> }>(`/api/v1/otel/operations?service=${encodeURIComponent(service)}`),
  otelTraces: (params: {
    service?: string; limit?: number; operation?: string
    search?: string; status?: string; min_duration_ms?: number; time_range?: string
    span_kind?: string; attr_key?: string; attr_val?: string
  } = {}) => {
    const q = new URLSearchParams()
    if (params.service) q.set('service', params.service)
    if (params.limit) q.set('limit', String(params.limit))
    if (params.operation) q.set('operation', params.operation)
    if (params.search) q.set('search', params.search)
    if (params.status) q.set('status', params.status)
    if (params.min_duration_ms) q.set('min_duration_ms', String(params.min_duration_ms))
    if (params.time_range) q.set('time_range', params.time_range)
    if (params.span_kind) q.set('span_kind', params.span_kind)
    if (params.attr_key) q.set('attr_key', params.attr_key)
    if (params.attr_val) q.set('attr_val', params.attr_val)
    return request<{ data: OTelTrace[] }>(`/api/v1/otel/traces?${q}`)
  },
  otelTrace: (id: string) => request<{ data: OTelTrace[] }>(`/api/v1/otel/traces/${id}`),
  otelDeleteTraces: () => request<{ deleted: number }>('/api/v1/otel/traces', { method: 'DELETE' }),

  // Retention settings
  getRetentionSettings: () => request<RetentionSettings>('/api/v1/settings/retention'),
  saveRetentionSettings: (s: RetentionSettings) => request<RetentionSettings>('/api/v1/settings/retention', {
    method: 'PUT', body: JSON.stringify(s),
  }),

  // App log management
  clearAppLogs: () => request<{ status: string }>('/api/v1/system/app-logs', { method: 'DELETE' }),

  // Docker disk usage + image prune
  getSystemDf: () => request<{ rows: DiskUsageRow[] }>('/api/v1/system/df'),
  pruneImages: (all = false) =>
    request<{ output: string; removed_records: number }>(`/api/v1/images/prune${all ? '?all=true' : ''}`, { method: 'POST', body: '{}' }),

  // Project clone
  cloneProject: (projectId: string, name: string, description?: string) =>
    request<{ id: string; name: string; description: string; status: string }>(`/api/v1/projects/${projectId}/clone`, {
      method: 'POST', body: JSON.stringify({ name, description }),
    }),

  // Self-update, rollback, and DB compaction
  getUpdateStatus: () => request<{ can_update: boolean; can_rollback: boolean; install_path: string; backup_path: string }>('/api/v1/system/update/status'),
  systemUpdateUrl: () => '/api/v1/system/update',
  systemRollbackUrl: () => '/api/v1/system/rollback',

  // Scheduled self-update — upload now, install automatically at a chosen time.
  scheduleUpdateUrl: () => '/api/v1/system/update/schedule',
  getScheduledUpdate: () => request<{
    scheduled: boolean
    run_at?: string
    filename?: string
    version?: string
    uploaded_by?: string
    uploaded_at?: string
    active: boolean
    last_result?: string
    last_log?: string
  }>('/api/v1/system/update/scheduled'),
  cancelScheduledUpdate: () => request<{ status: string }>('/api/v1/system/update/scheduled', { method: 'DELETE' }),
  compactDB: () => request<{ status: string; bytes_before: number; bytes_after: number; bytes_freed: number }>('/api/v1/system/compact', { method: 'POST', body: '{}' }),
  pruneAll: (params?: { sessions?: number; otel_spans?: number; audit?: number; deployments?: number }) => {
    const q = params ? '?' + new URLSearchParams(Object.entries(params).filter(([,v]) => v !== undefined).map(([k,v]) => [k, String(v)])).toString() : ''
    return request<{ status: string; sessions_deleted: number; otel_spans_deleted: number; audit_deleted: number; deployments_deleted: number }>(`/api/v1/system/prune${q}`, { method: 'POST', body: '{}' })
  },

  // File upload — uses XHR (not fetch) so upload.onprogress fires for large files.
  uploadFile: (
    file: File,
    onProgress?: (loaded: number, total: number, pct: number) => void,
  ): Promise<{ path: string; name: string; size: number }> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.timeout = 0 // no timeout — 5 GB over a slow link may take hours

      if (onProgress) {
        xhr.upload.onprogress = (e: ProgressEvent) => {
          if (e.lengthComputable) {
            onProgress(e.loaded, e.total, Math.round((e.loaded / e.total) * 100))
          }
        }
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)) }
          catch { reject(new ApiError(xhr.status, 'invalid server response')) }
        } else {
          try { reject(new ApiError(xhr.status, JSON.parse(xhr.responseText).error ?? xhr.statusText)) }
          catch { reject(new ApiError(xhr.status, xhr.statusText)) }
        }
      }

      xhr.onerror = () => reject(new Error('Network error during upload'))
      xhr.ontimeout = () => reject(new Error('Upload timed out'))
      xhr.onabort = () => reject(new Error('Upload cancelled'))

      const form = new FormData()
      form.append('file', file)
      xhr.open('POST', '/api/v1/upload')
      xhr.send(form)
    })
  },

  // --- Host package safety (Tier 1) ---
  packageStatus: () => request<{ protected: string[]; held: string[] }>('/api/v1/system/packages/status'),
  ensurePackageHolds: () => request<{ held: string[] }>('/api/v1/system/packages/hold', { method: 'POST' }),
  installPackages: (paths: string[], force = false) =>
    request<PackageInstallResult>('/api/v1/system/packages/install', {
      method: 'POST', body: JSON.stringify({ paths, force }),
    }),
  fixBroken: (force = false) =>
    request<PackageInstallResult>('/api/v1/system/packages/fix-broken', {
      method: 'POST', body: JSON.stringify({ force }),
    }),

  // --- System maintenance (Tier 1 / 4) ---
  reconcile: () => request<ReconcileReport>('/api/v1/system/reconcile', { method: 'POST' }),
  optimize: (opts: { compact?: boolean; drop_caches?: boolean; docker_prune?: boolean }) =>
    request<OptimizeResult>('/api/v1/system/optimize', { method: 'POST', body: JSON.stringify(opts) }),

  // --- Rollback + tags (Tier 6) ---
  rollback: (projectId: string, body: { tag_id?: string; deployment_id?: string; compose_version?: number; env_version?: number }) =>
    request<{ deployment_id: string; stream: string }>(`/api/v1/projects/${projectId}/rollback`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  toggleTagProtected: (projectId: string, tagId: string) =>
    request<DeployTag>(`/api/v1/projects/${projectId}/deploy-tags/${tagId}/protect`, { method: 'POST' }),

  // --- Backups (Tier 2) ---
  listBackups: () => request<BackupRecord[]>('/api/v1/system/backups'),
  createBackup: (body: { scope: string; project_id?: string; include_volumes?: boolean; include_config?: boolean; encrypt?: boolean }) =>
    request<BackupRecord>('/api/v1/system/backups', { method: 'POST', body: JSON.stringify(body) }),
  inspectBackup: (id: string) => request<RestorePlan>(`/api/v1/system/backups/${id}/inspect`),
  restoreBackup: (id: string, opts: RestoreOptions) =>
    request<{ result: RestoreResult; warning?: string }>(`/api/v1/system/backups/${id}/restore`, {
      method: 'POST', body: JSON.stringify(opts),
    }),
  deleteBackup: (id: string) => request<void>(`/api/v1/system/backups/${id}`, { method: 'DELETE' }),
  downloadBackupURL: (id: string) => `/api/v1/system/backups/${id}/download`,
  getBackupSchedule: () => request<BackupSchedule>('/api/v1/system/backups-schedule'),
  saveBackupSchedule: (s: BackupSchedule) =>
    request<BackupSchedule>('/api/v1/system/backups-schedule', { method: 'POST', body: JSON.stringify(s) }),

  // --- Terminal policy (Tier 3) ---
  getTerminalPolicy: () => request<TerminalPolicy>('/api/v1/terminal/policy'),
  getTerminalPolicyDefaults: () => request<{ default_deny: string[] }>('/api/v1/terminal/policy/defaults'),
  saveTerminalPolicy: (p: TerminalPolicy) =>
    request<TerminalPolicy>('/api/v1/terminal/policy', { method: 'POST', body: JSON.stringify(p) }),

  // --- Docker network IPAM (Tier 8) ---
  createDockerNetworkIPAM: (body: { name: string; driver?: string; subnet?: string; gateway?: string; ip_range?: string; internal?: boolean; attachable?: boolean }) =>
    request<DockerNetwork>('/api/v1/docker/networks', { method: 'POST', body: JSON.stringify(body) }),
}

export { ApiError }

// --- New types (Tiers 1-8) ---
export interface PackageSimulation {
  install: string[]; upgrade: string[]; remove: string[]; protected_removals: string[]; raw: string
}
export interface PackageInstallResult {
  applied?: boolean; output?: string; simulation?: PackageSimulation; error?: string; protected?: string[]
}
export interface ReconcileItemErr { name: string; err: string }
export interface ReconcileReport {
  docker_ready: boolean
  projects_up: string[]
  project_errors: ReconcileItemErr[]
  nginx_applied: string[]
  nginx_errors: ReconcileItemErr[]
  started_at: string
  finished_at: string
}
export interface CompactResult { collection: string; reclaimed_bytes: number; error?: string }
export interface OptimizeResult {
  ram_used_before: number; ram_used_after: number; ram_freed_bytes: number
  compacted: CompactResult[]; disk_reclaimed_bytes: number; dropped_caches: boolean
  docker_prune_output?: string; errors?: string[]
}
export interface BackupRecord {
  id: string; created_at: string; scope: string; project_id: string; path: string
  size_bytes: number; contents: string[]; volumes: string[]; encrypted: boolean
  sensitive: boolean; triggered_by: string; status: string; note: string
}
export interface BackupSchedule {
  id: string; enabled: boolean; time_of_day: string; scope: string
  include_volumes: boolean; include_config: boolean; encrypt: boolean
  retention: number; dest_path: string; last_run_at?: string | null; updated_at: string
}
export interface BackupManifest {
  version: number; created_at: string; scope: string; project_id: string
  volumes: string[]; encrypted: boolean; has_config: boolean
}
export interface RestorePlan {
  manifest: BackupManifest; projects: string[]; volumes: string[]
  has_config: boolean; has_db: boolean; has_nginx: boolean
}
export interface RestoreOptions {
  volumes?: boolean; projects?: boolean; config?: boolean; db?: boolean; nginx?: boolean; certs?: boolean
}
export interface RestoreResult {
  restored_projects: string[]; restored_volumes: string[]
  restored_config: boolean; restored_db: boolean; errors: string[]
}
export interface TerminalPolicy {
  id: string; mode: string; deny: string[]; allow: string[]; restricted_paths: string[]; updated_at?: string
}
