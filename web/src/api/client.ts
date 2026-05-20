// Typed API client — the only place raw fetch is called in the frontend.

export interface User {
  id: string
  username: string
  role: 'superadmin' | 'admin' | 'viewer'
  created_by: string
  created_at: string
  updated_at: string
  active: boolean
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
  ssl_cert_path: string
  ssl_key_path: string
  upstream_host: string
  upstream_port: number
  client_max_body_size: string
  proxy_read_timeout: number
  gzip_enabled: boolean
  custom_directives: string
  generated_config: string
  active: boolean
  created_at: string
}

export interface DeploymentRecord {
  id: string
  project_id: string
  triggered_by: string
  strategy: string
  old_compose_version: number
  new_compose_version: number
  status: 'pending' | 'running' | 'success' | 'failed'
  started_at: string
  finished_at: string | null
  log_text: string
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

export interface UsbDrive {
  mount_point: string
  label: string
  free_bytes: number
  total_bytes: number
}

export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
}

export interface ContainerInfo {
  ID: string
  Names: string
  Image: string
  Status: string
  Ports: string
  State: string
}

export interface SystemStats {
  cpu_percent: number
  ram_total_bytes: number
  ram_used_bytes: number
  disk_total_bytes: number
  disk_used_bytes: number
  containers: ContainerStats[]
  timestamp: string
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
  setupCreate: (username: string, password: string) =>
    request<User>('/api/v1/setup', { method: 'POST', body: JSON.stringify({ username, password }) }),

  // Users
  listUsers: () => request<User[]>('/api/v1/users'),
  createUser: (data: { username: string; password: string; role: User['role'] }) =>
    request<User>('/api/v1/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id: string, data: { role?: User['role']; active?: boolean }) =>
    request<User>(`/api/v1/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteUser: (id: string) =>
    request<void>(`/api/v1/users/${id}`, { method: 'DELETE' }),

  // Projects
  listProjects: () => request<Project[]>('/api/v1/projects'),
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
  saveCompose: (projectId: string, rawYaml: string) =>
    request<ComposeConfig>(`/api/v1/projects/${projectId}/compose`, {
      method: 'POST',
      body: JSON.stringify({ raw_yaml: rawYaml }),
    }),
  composeHistory: (projectId: string) =>
    request<ComposeConfig[]>(`/api/v1/projects/${projectId}/compose/history`),

  // Env vars
  getEnv: (projectId: string) =>
    request<EnvVarSet | null>(`/api/v1/projects/${projectId}/env`),
  saveEnv: (projectId: string, vars: EnvVar[]) =>
    request<EnvVarSet>(`/api/v1/projects/${projectId}/env`, {
      method: 'POST',
      body: JSON.stringify({ vars }),
    }),
  envHistory: (projectId: string) =>
    request<EnvVarSet[]>(`/api/v1/projects/${projectId}/env/history`),

  // Nginx
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
  generateCert: (projectId: string, domain: string, days?: number) =>
    request<{ cert_path: string; key_path: string; domain: string; days: string }>(
      `/api/v1/projects/${projectId}/nginx/cert`,
      { method: 'POST', body: JSON.stringify({ domain, days: days ?? 365 }) }
    ),

  // Deploy
  triggerDeploy: (projectId: string, composeVersion?: number) =>
    request<{ deployment_id: string; stream: string }>(
      `/api/v1/projects/${projectId}/deploy`,
      { method: 'POST', body: JSON.stringify(composeVersion ? { compose_version: composeVersion } : {}) }
    ),
  listDeployments: (projectId: string) =>
    request<DeploymentRecord[]>(`/api/v1/projects/${projectId}/deployments`),
  getDeployment: (projectId: string, depId: string) =>
    request<DeploymentRecord>(`/api/v1/projects/${projectId}/deployments/${depId}`),
  deleteDeployment: (projectId: string, depId: string) =>
    request<void>(`/api/v1/projects/${projectId}/deployments/${depId}`, { method: 'DELETE' }),

  // Containers
  listContainers: (projectId: string) =>
    request<ContainerInfo[]>(`/api/v1/projects/${projectId}/containers`),

  // Images
  listImages: () => request<DockerImage[]>('/api/v1/images'),
  loadImage: (data: { tar_file_path: string; project_id?: string; image_name?: string; image_tag?: string }) =>
    request<DockerImage>('/api/v1/images/load', { method: 'POST', body: JSON.stringify(data) }),
  syncImages: () =>
    request<{ synced: number; images: DockerImage[] }>('/api/v1/images/sync', { method: 'POST' }),
  deleteImage: (id: string) => request<void>(`/api/v1/images/${id}`, { method: 'DELETE' }),

  // USB
  listDrives: () => request<UsbDrive[]>('/api/v1/usb/drives'),
  browseDrive: (mount: string, path?: string) =>
    request<FileEntry[]>(`/api/v1/usb/browse?mount=${encodeURIComponent(mount)}${path ? `&path=${encodeURIComponent(path)}` : ''}`),
  readFile: (mount: string, path: string) =>
    request<{ content: string }>(`/api/v1/usb/file?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(path)}`),

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
}

export { ApiError }
