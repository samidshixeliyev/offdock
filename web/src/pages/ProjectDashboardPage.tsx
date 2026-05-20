import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  api, Project, ContainerInfo, ComposeConfig, EnvVar,
  NginxConfig, DeploymentRecord, FileEntry,
} from '../api/client'
import ConfirmModal from '../components/ConfirmModal'

type Tab = 'overview' | 'compose' | 'env' | 'nginx' | 'deploy'
type MsgT = 'ok' | 'err'

function Msg({ text, type }: { text: string; type: MsgT }) {
  if (!text) return null
  return <span className={`text-sm ${type === 'err' ? 'text-red-400' : 'text-green-400'}`}>{text}</span>
}

// ─── File Browser Modal ───────────────────────────────────────────────────────
// mode='content' reads file and returns its text; mode='path' returns the file path
function FileBrowser({ onSelect, onClose, mode = 'content' }: {
  onSelect: (value: string, filename: string) => void
  onClose: () => void
  mode?: 'content' | 'path'
}) {
  const [mount, setMount] = useState('/var/offdock')
  const [path, setPath] = useState('/var/offdock')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const browse = async (m: string, p: string) => {
    setLoading(true); setErr('')
    try {
      const files = await api.browseDrive(m, p)
      setEntries(files ?? []); setPath(p)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Error') }
    finally { setLoading(false) }
  }

  useEffect(() => { browse('/var/offdock', '/var/offdock') }, [])

  const navigateUp = () => {
    const base = mount.replace(/\/$/, '')
    const parts = path.split('/').filter(Boolean)
    if (!parts.length) return
    parts.pop()
    const parent = parts.length ? '/' + parts.join('/') : base
    if (parent === base || (parent + '/').startsWith(base + '/')) browse(mount, parent)
  }

  const selectFile = async (entry: FileEntry) => {
    setErr('')
    if (mode === 'path') {
      onSelect(entry.path, entry.name)
      onClose()
      return
    }
    try {
      const res = await api.readFile(mount, entry.path)
      onSelect(res.content, entry.name)
      onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Read failed') }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
          <h3 className="text-sm font-semibold text-white">
            {mode === 'path' ? 'Select File Path' : 'Browse Server Filesystem'}
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="px-4 py-3 border-b border-gray-800 space-y-2 shrink-0">
          <div className="flex gap-2">
            <input
              className="input font-mono text-xs flex-1"
              placeholder="Base directory (security boundary)"
              value={mount}
              onChange={e => setMount(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && browse(mount, mount)}
            />
            <button onClick={() => { setPath(mount); browse(mount, mount) }} className="btn-ghost text-xs">Go</button>
          </div>
          <p className="text-xs text-gray-600 font-mono truncate">{path}</p>
          {err && <p className="text-xs text-red-400">{err}</p>}
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading && <p className="px-4 py-6 text-gray-500 text-sm text-center">Loading…</p>}
          {path !== mount.replace(/\/$/, '') && (
            <button onClick={navigateUp}
              className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-gray-400 hover:bg-gray-800 border-b border-gray-800">
              ↑ ..
            </button>
          )}
          {entries.map(e => (
            <div key={e.path} className="flex items-center justify-between px-4 py-2 border-b border-gray-800/50 hover:bg-gray-800/30">
              <button className="flex items-center gap-2 text-left min-w-0 flex-1"
                onClick={() => e.is_dir ? browse(mount, e.path) : selectFile(e)}>
                <span>{e.is_dir ? '📁' : '📄'}</span>
                <span className="font-mono text-xs text-gray-300 truncate">{e.name}</span>
              </button>
              {!e.is_dir && (
                <button onClick={() => selectFile(e)} className="btn-primary text-xs py-1 shrink-0 ml-2">
                  {mode === 'path' ? 'Use path' : 'Use file'}
                </button>
              )}
            </div>
          ))}
          {!loading && entries.length === 0 && (
            <p className="px-4 py-8 text-gray-500 text-sm text-center">Empty directory or no supported files</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────
function OverviewTab({ projectId, onStatusSync }: {
  projectId: string
  onStatusSync: (p: import('../api/client').Project) => void
}) {
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [actionBusy, setActionBusy] = useState<string>('')
  const [syncing, setSyncing] = useState(false)

  const refresh = () => {
    setLoading(true)
    api.listContainers(projectId)
      .then(d => setContainers(d ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [projectId])

  const syncStatus = async () => {
    setSyncing(true)
    try {
      const updated = await api.syncProjectStatus(projectId)
      onStatusSync(updated)
      refresh()
    } catch {}
    finally { setSyncing(false) }
  }

  const doAction = async (name: string, action: 'restart' | 'stop' | 'start') => {
    setActionBusy(name + ':' + action)
    try {
      await api.containerAction(projectId, name, action)
      await new Promise(r => setTimeout(r, 800))
      refresh()
    } catch {}
    finally { setActionBusy('') }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Containers</h2>
        <div className="flex gap-2">
          <button onClick={syncStatus} disabled={syncing} className="btn-ghost text-xs">
            {syncing ? 'Syncing…' : 'Sync Status'}
          </button>
          <button onClick={refresh} className="btn-ghost text-xs">Refresh</button>
        </div>
      </div>
      {loading ? (
        <div className="card text-gray-500 text-sm py-6 text-center">Loading…</div>
      ) : containers.length === 0 ? (
        <div className="card text-gray-500 text-sm py-8 text-center">
          No containers found for this project.
          <p className="text-xs text-gray-600 mt-1">Go to Deploy tab to start the project.</p>
          <button onClick={syncStatus} disabled={syncing} className="btn-ghost text-xs mt-3">
            {syncing ? 'Syncing…' : 'Sync Status from Docker'}
          </button>
        </div>
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
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      c.State === 'running' ? 'bg-green-900 text-green-300' :
                      c.State === 'exited' ? 'bg-red-900/50 text-red-400' :
                      'bg-gray-800 text-gray-400'
                    }`}>{c.Status}</span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 font-mono">{c.Ports}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-2">
                      <button
                        onClick={() => doAction(c.Names, 'restart')}
                        disabled={!!actionBusy}
                        className="text-xs text-blue-500 hover:text-blue-400 disabled:opacity-40"
                      >
                        {actionBusy === c.Names + ':restart' ? '…' : 'Restart'}
                      </button>
                      {c.State === 'running' ? (
                        <button
                          onClick={() => doAction(c.Names, 'stop')}
                          disabled={!!actionBusy}
                          className="text-xs text-red-500 hover:text-red-400 disabled:opacity-40"
                        >
                          {actionBusy === c.Names + ':stop' ? '…' : 'Stop'}
                        </button>
                      ) : (
                        <button
                          onClick={() => doAction(c.Names, 'start')}
                          disabled={!!actionBusy}
                          className="text-xs text-green-500 hover:text-green-400 disabled:opacity-40"
                        >
                          {actionBusy === c.Names + ':start' ? '…' : 'Start'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ─── Compose Tab ─────────────────────────────────────────────────────────────
function ComposeTab({ projectId }: { projectId: string }) {
  const [yaml, setYaml] = useState('')
  const [history, setHistory] = useState<ComposeConfig[]>([])
  const [selected, setSelected] = useState<ComposeConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<MsgT>('ok')
  const [showBrowser, setShowBrowser] = useState(false)

  const notify = (text: string, type: MsgT = 'ok') => { setMsg(text); setMsgType(type) }

  useEffect(() => {
    api.getCompose(projectId).then(c => { if (c) { setYaml(c.raw_yaml); setSelected(c) } }).catch(() => {})
    api.composeHistory(projectId).then(d => setHistory(d ?? [])).catch(() => {})
  }, [projectId])

  const save = async () => {
    if (!yaml.trim()) { notify('Compose content is empty', 'err'); return }
    setSaving(true); notify('')
    try {
      const cfg = await api.saveCompose(projectId, yaml)
      setSelected(cfg)
      api.composeHistory(projectId).then(d => setHistory(d ?? []))
      notify('Saved as version ' + cfg.version)
    } catch (e) {
      notify('Error: ' + (e instanceof Error ? e.message : 'unknown'), 'err')
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider flex-1">docker-compose.yml</h2>
        <Msg text={msg} type={msgType} />
        <button onClick={() => setShowBrowser(true)} className="btn-ghost text-xs">Browse Disk</button>
        <button onClick={save} disabled={saving} className="btn-primary">
          {saving ? 'Saving…' : 'Save Version'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-3">
          <textarea
            className="w-full font-mono text-xs bg-gray-900 border border-gray-700 rounded-xl p-4 text-gray-200 focus:outline-none focus:border-blue-500 resize-y leading-relaxed"
            style={{ minHeight: '24rem' }}
            placeholder={'services:\n  app:\n    image: myapp:latest\n    ports:\n      - "3000:3000"'}
            value={yaml}
            onChange={e => setYaml(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Version History</p>
          {history.length === 0
            ? <p className="text-xs text-gray-600 px-1">No versions yet</p>
            : (
              <div className="space-y-1.5">
                {history.map(cfg => (
                  <button key={cfg.id}
                    onClick={() => { setYaml(cfg.raw_yaml); setSelected(cfg) }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${
                      selected?.id === cfg.id
                        ? 'bg-blue-600/20 text-blue-400'
                        : 'text-gray-400 hover:bg-gray-800'
                    }`}
                  >
                    <div className="font-medium">v{cfg.version}</div>
                    <div className="text-gray-600 mt-0.5">{new Date(cfg.created_at).toLocaleString()}</div>
                  </button>
                ))}
              </div>
            )
          }
        </div>
      </div>

      {showBrowser && (
        <FileBrowser
          onSelect={(content) => { setYaml(content); notify('File loaded from disk') }}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </div>
  )
}

// ─── Env Tab ─────────────────────────────────────────────────────────────────
interface EditableVar { _id: number; key: string; value: string; is_secret: boolean; revealed: boolean }
let _nextId = 0
const makeVar = (key = '', value = '', is_secret = false): EditableVar =>
  ({ _id: ++_nextId, key, value, is_secret, revealed: false })

function parseEnvText(text: string): EditableVar[] {
  const result: EditableVar[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    result.push(makeVar(key, val))
  }
  return result
}

function EnvTab({ projectId }: { projectId: string }) {
  const [vars, setVars] = useState<EditableVar[]>([])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<MsgT>('ok')
  const [showBrowser, setShowBrowser] = useState(false)
  const [pasteMode, setPasteMode] = useState(false)
  const [pasteText, setPasteText] = useState('')

  const notify = (text: string, type: MsgT = 'ok') => { setMsg(text); setMsgType(type) }

  useEffect(() => {
    api.getEnv(projectId)
      .then(s => { if (s) setVars((s.vars ?? []).map(v => makeVar(v.key, v.value, v.is_secret))) })
      .catch(() => {})
  }, [projectId])

  const addVar = () => setVars(v => [...v, makeVar()])
  const removeVar = (_id: number) => setVars(v => v.filter(x => x._id !== _id))
  const update = (_id: number, field: keyof EditableVar, val: string | boolean) =>
    setVars(v => v.map(x => x._id === _id ? { ...x, [field]: val } : x))

  const applyPaste = () => {
    const parsed = parseEnvText(pasteText)
    if (!parsed.length) { notify('No valid KEY=value lines found', 'err'); return }
    setVars(prev => {
      const byKey = new Map(prev.map(x => [x.key, x]))
      for (const p of parsed) {
        if (byKey.has(p.key)) byKey.set(p.key, { ...byKey.get(p.key)!, value: p.value })
        else byKey.set(p.key, p)
      }
      return Array.from(byKey.values())
    })
    notify(`Imported ${parsed.length} variable${parsed.length !== 1 ? 's' : ''}`)
    setPasteMode(false); setPasteText('')
  }

  const handleFileSelect = (content: string, filename: string) => {
    setPasteText(content)
    setPasteMode(true)
    notify('File loaded: ' + filename + ' — review and click Import')
  }

  const save = async () => {
    setSaving(true); notify('')
    try {
      const payload: EnvVar[] = vars.map(({ key, value, is_secret }) => ({ key, value, is_secret }))
      const set = await api.saveEnv(projectId, payload)
      setVars((set.vars ?? []).map(v => makeVar(v.key, v.value, v.is_secret)))
      notify('Saved as version ' + set.version)
    } catch (e) {
      notify('Error: ' + (e instanceof Error ? e.message : 'unknown'), 'err')
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider flex-1">Environment Variables</h2>
        <Msg text={msg} type={msgType} />
        <button onClick={() => setShowBrowser(true)} className="btn-ghost text-xs">Browse Disk</button>
        <button
          onClick={() => setPasteMode(p => !p)}
          className={`btn-ghost text-xs ${pasteMode ? 'text-blue-400' : ''}`}
        >
          {pasteMode ? 'Close Paste' : 'Paste .env'}
        </button>
        <button onClick={addVar} className="btn-ghost text-xs">+ Add</button>
        <button onClick={save} disabled={saving} className="btn-primary">
          {saving ? 'Saving…' : 'Save Version'}
        </button>
      </div>

      {pasteMode && (
        <div className="card space-y-3">
          <p className="text-xs text-gray-400">
            Paste .env file content. Existing keys will be updated; new keys will be added.
          </p>
          <textarea
            className="w-full font-mono text-xs bg-gray-950 border border-gray-700 rounded-lg p-3 text-gray-200 focus:outline-none focus:border-blue-500 resize-y"
            style={{ minHeight: '10rem' }}
            placeholder={'DATABASE_URL=postgres://localhost/mydb\nAPP_SECRET=changeme\nPORT=3000'}
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            spellCheck={false}
          />
          <div className="flex gap-2">
            <button onClick={applyPaste} className="btn-primary text-xs">Import Variables</button>
            <button onClick={() => { setPasteMode(false); setPasteText('') }} className="btn-ghost text-xs">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {vars.length === 0 && !pasteMode && (
          <div className="card text-center text-gray-500 py-10 text-sm">
            No variables yet.
            <p className="text-xs text-gray-600 mt-1">Click "+ Add", "Browse Disk" to pick a .env file, or "Paste .env" to paste content.</p>
          </div>
        )}
        {vars.map(v => (
          <div key={v._id} className="card flex items-center gap-3 py-3">
            <input
              className="input font-mono text-xs w-44 shrink-0"
              placeholder="KEY"
              value={v.key}
              onChange={e => update(v._id, 'key', e.target.value)}
            />
            <div className="flex-1 relative min-w-0">
              <input
                className="input font-mono text-xs w-full"
                style={{ paddingRight: v.is_secret ? '3.5rem' : undefined }}
                placeholder={v.is_secret && v.value === '********' ? '(saved secret — clear to change)' : 'value'}
                type={v.is_secret && !v.revealed ? 'password' : 'text'}
                value={v.value}
                onChange={e => update(v._id, 'value', e.target.value)}
              />
              {v.is_secret && (
                <button
                  type="button"
                  onClick={() => update(v._id, 'revealed', !v.revealed)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs"
                >
                  {v.revealed ? 'hide' : 'show'}
                </button>
              )}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-gray-400 shrink-0 cursor-pointer">
              <input
                type="checkbox"
                checked={v.is_secret}
                onChange={e => update(v._id, 'is_secret', e.target.checked)}
                className="rounded"
              />
              Secret
            </label>
            <button
              onClick={() => removeVar(v._id)}
              className="text-gray-600 hover:text-red-400 text-sm transition-colors shrink-0"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {showBrowser && (
        <FileBrowser
          onSelect={handleFileSelect}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </div>
  )
}

// ─── Nginx Tab ─────────────────────────────────────────────────────────────────
type NginxForm = Omit<NginxConfig, 'id' | 'project_id' | 'generated_config' | 'active' | 'created_at'>
const defaultNginx: NginxForm = {
  domain: '', ssl_enabled: false, ssl_cert_path: '', ssl_key_path: '',
  upstream_host: 'localhost', upstream_port: 3000,
  client_max_body_size: '1m', proxy_read_timeout: 60,
  gzip_enabled: false, custom_directives: '',
}

function NginxTab({ projectId }: { projectId: string }) {
  const [form, setForm] = useState<NginxForm>(defaultNginx)
  const [preview, setPreview] = useState('')
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<MsgT>('ok')
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)
  const [generatingCert, setGeneratingCert] = useState(false)
  const [certDays, setCertDays] = useState(365)
  const [certBrowser, setCertBrowser] = useState<'cert' | 'key' | null>(null)

  const notify = (text: string, type: MsgT = 'ok') => { setMsg(text); setMsgType(type) }
  const set = <K extends keyof NginxForm>(key: K, val: NginxForm[K]) => setForm(f => ({ ...f, [key]: val }))

  const sanitizeDomain = (d: string) =>
    d.replace(/^https?:\/\//i, '').replace(/^https?\/\//i, '').replace(/\/.*$/, '').trim()

  useEffect(() => {
    api.getNginx(projectId).then(cfg => {
      if (cfg) setForm({
        domain: cfg.domain,
        ssl_enabled: cfg.ssl_enabled,
        ssl_cert_path: cfg.ssl_cert_path,
        ssl_key_path: cfg.ssl_key_path,
        upstream_host: cfg.upstream_host,
        upstream_port: cfg.upstream_port,
        client_max_body_size: cfg.client_max_body_size || '1m',
        proxy_read_timeout: cfg.proxy_read_timeout || 60,
        gzip_enabled: cfg.gzip_enabled || false,
        custom_directives: cfg.custom_directives,
      })
    }).catch(() => {})
    api.previewNginx(projectId).then(r => setPreview(r.config)).catch(() => {})
  }, [projectId])

  const handleSave = async () => {
    setSaving(true); notify('')
    try {
      await api.saveNginx(projectId, form)
      const r = await api.previewNginx(projectId)
      setPreview(r.config)
      notify('Saved successfully')
    } catch (e) {
      notify('Error: ' + (e instanceof Error ? e.message : 'unknown'), 'err')
    } finally { setSaving(false) }
  }

  const handleApply = async () => {
    setApplying(true); notify('')
    try {
      await api.applyNginx(projectId)
      notify('Applied to host — nginx reloaded')
    } catch (e) {
      notify('Error: ' + (e instanceof Error ? e.message : 'unknown'), 'err')
    } finally { setApplying(false) }
  }

  const handleGenerateCert = async () => {
    if (!form.domain) { notify('Enter a domain first', 'err'); return }
    setGeneratingCert(true); notify('')
    try {
      const r = await api.generateCert(projectId, form.domain, certDays)
      setForm(f => ({ ...f, ssl_cert_path: r.cert_path, ssl_key_path: r.key_path, ssl_enabled: true }))
      notify(`Self-signed cert generated for ${r.domain} (${r.days} days)`)
    } catch (e) {
      notify('Error: ' + (e instanceof Error ? e.message : 'unknown'), 'err')
    } finally { setGeneratingCert(false) }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider flex-1">Nginx Reverse Proxy</h2>
        <Msg text={msg} type={msgType} />
        <button onClick={handleSave} disabled={saving} className="btn-ghost">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={handleApply} disabled={applying} className="btn-primary">
          {applying ? 'Applying…' : 'Apply to Host'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-4">
          {/* Basic settings */}
          <div className="card space-y-4">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Routing</p>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Domain</label>
              <input
                className="input"
                value={form.domain}
                onChange={e => set('domain', e.target.value)}
                onBlur={e => set('domain', sanitizeDomain(e.target.value))}
                placeholder="app.example.com"
              />
              <p className="text-xs text-gray-600 mt-1">Protocol and trailing slashes are stripped automatically.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Upstream Host</label>
                <input className="input" value={form.upstream_host}
                  onChange={e => set('upstream_host', e.target.value)} placeholder="localhost" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Upstream Port</label>
                <input className="input" type="number" min={1} max={65535} value={form.upstream_port}
                  onChange={e => set('upstream_port', Number(e.target.value))} />
              </div>
            </div>
          </div>

          {/* SSL */}
          <div className="card space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">SSL / TLS</p>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.ssl_enabled}
                  onChange={e => set('ssl_enabled', e.target.checked)} />
                <span className="text-sm text-gray-300">Enable SSL</span>
              </label>
            </div>

            {form.ssl_enabled && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Certificate Path (.crt / .pem)</label>
                  <div className="flex gap-2">
                    <input className="input font-mono text-xs flex-1" value={form.ssl_cert_path}
                      onChange={e => set('ssl_cert_path', e.target.value)}
                      placeholder="/var/offdock/certs/project.crt" />
                    <button onClick={() => setCertBrowser('cert')} className="btn-ghost text-xs shrink-0">Browse</button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Private Key Path (.key)</label>
                  <div className="flex gap-2">
                    <input className="input font-mono text-xs flex-1" value={form.ssl_key_path}
                      onChange={e => set('ssl_key_path', e.target.value)}
                      placeholder="/var/offdock/certs/project.key" />
                    <button onClick={() => setCertBrowser('key')} className="btn-ghost text-xs shrink-0">Browse</button>
                  </div>
                </div>

                {/* Generate self-signed cert */}
                <div className="pt-2 border-t border-gray-800">
                  <p className="text-xs text-gray-500 mb-2">Generate a self-signed certificate (for internal / development use)</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <label className="text-xs text-gray-400 shrink-0">Valid for</label>
                    <input
                      type="number" min={1} max={3650}
                      value={certDays}
                      onChange={e => setCertDays(Number(e.target.value))}
                      className="input text-xs w-20"
                    />
                    <label className="text-xs text-gray-400 shrink-0">days</label>
                    <button
                      onClick={handleGenerateCert}
                      disabled={generatingCert || !form.domain}
                      className="btn-ghost text-xs ml-auto"
                    >
                      {generatingCert ? 'Generating…' : 'Generate Self-Signed Cert'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Performance */}
          <div className="card space-y-4">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Performance</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Max Body Size</label>
                <input className="input font-mono text-xs" value={form.client_max_body_size}
                  onChange={e => set('client_max_body_size', e.target.value)}
                  placeholder="1m" />
                <p className="text-xs text-gray-600 mt-1">e.g. 10m, 500k, 1g</p>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Proxy Timeout (s)</label>
                <input className="input" type="number" min={1} value={form.proxy_read_timeout}
                  onChange={e => set('proxy_read_timeout', Number(e.target.value))} />
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.gzip_enabled}
                onChange={e => set('gzip_enabled', e.target.checked)} />
              <span className="text-sm text-gray-300">Enable Gzip Compression</span>
            </label>
          </div>

          {/* Custom directives */}
          <div className="card space-y-2">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">Custom Directives</p>
            <p className="text-xs text-gray-600">Added inside the <code className="text-gray-500">location /</code> block. Semicolons are added automatically.</p>
            <textarea
              className="input font-mono text-xs resize-y"
              style={{ minHeight: '6rem' }}
              value={form.custom_directives}
              onChange={e => set('custom_directives', e.target.value)}
              placeholder={'add_header X-Frame-Options DENY\nadd_header X-Content-Type-Options nosniff'}
              spellCheck={false}
            />
          </div>
        </div>

        {/* Preview */}
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Generated Config Preview</p>
          <pre className="card font-mono text-xs text-green-400 overflow-auto whitespace-pre-wrap"
            style={{ minHeight: '20rem', maxHeight: '60vh' }}>
            {preview || '# Save config to generate preview'}
          </pre>
          <p className="text-xs text-gray-600 mt-2">
            Written to <code className="text-gray-500">/etc/nginx/sites-available/</code> on Apply.
          </p>
        </div>
      </div>

      {certBrowser && (
        <FileBrowser
          mode="path"
          onSelect={(p) => {
            if (certBrowser === 'cert') set('ssl_cert_path', p)
            else set('ssl_key_path', p)
            setCertBrowser(null)
          }}
          onClose={() => setCertBrowser(null)}
        />
      )}
    </div>
  )
}

// ─── Deploy Tab ───────────────────────────────────────────────────────────────
function DeployTab({ projectId }: { projectId: string }) {
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([])
  const [log, setLog] = useState<string[]>([])
  const [deploying, setDeploying] = useState(false)
  const [streamKey, setStreamKey] = useState('')
  const [rollbackTarget, setRollbackTarget] = useState<DeploymentRecord | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeploymentRecord | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  const loadHistory = () =>
    api.listDeployments(projectId).then(d => setDeployments(d ?? [])).catch(() => {})

  useEffect(() => { loadHistory() }, [projectId])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  useEffect(() => {
    if (!streamKey) return
    const es = new EventSource(`/api/v1/projects/${projectId}/deployments/${streamKey}/stream`)
    esRef.current = es
    es.onmessage = e => {
      try {
        const data = JSON.parse(e.data as string) as Record<string, string>
        if (data.log) setLog(prev => [...prev, data.log])
        if (data.status) {
          setLog(prev => [...prev, `\n✓ Deployment ${data.status}`])
          setDeploying(false); es.close(); loadHistory()
        }
        if (data.error) {
          setLog(prev => [...prev, `\n✗ Error: ${data.error}`])
          setDeploying(false); es.close()
        }
      } catch {}
    }
    es.onerror = () => { setDeploying(false); es.close() }
    return () => es.close()
  }, [streamKey, projectId])

  const handleDeploy = async (composeVersion?: number) => {
    setDeploying(true)
    setLog([composeVersion ? `Rolling back to compose v${composeVersion}…` : 'Starting deployment…'])
    setRollbackTarget(null)
    try {
      const { deployment_id } = await api.triggerDeploy(projectId, composeVersion)
      setStreamKey(deployment_id)
    } catch (e) {
      setLog(['Error: ' + (e instanceof Error ? e.message : 'unknown')])
      setDeploying(false)
    }
  }

  const handleDeleteDeployment = async (dep: DeploymentRecord) => {
    try {
      await api.deleteDeployment(projectId, dep.id)
      setDeployments(prev => prev.filter(d => d.id !== dep.id))
    } catch (e) {
      // If delete fails (e.g., still running), silently ignore — user sees status
    }
    setDeleteTarget(null)
  }

  const statusBadge = (s: string) => ({
    pending: 'badge-pending', running: 'badge-pending',
    success: 'badge-running', failed: 'badge-error',
  } as Record<string, string>)[s] ?? 'badge-stopped'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Deploy</h2>
        <button onClick={() => handleDeploy()} disabled={deploying} className="btn-primary">
          {deploying ? '⟳ Deploying…' : '▶ Trigger Deploy'}
        </button>
      </div>

      {log.length > 0 && (
        <div className="card">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Live Output</p>
          <div ref={logRef}
            className="font-mono text-xs text-green-400 bg-gray-950 rounded-lg p-4 h-64 overflow-y-auto">
            {log.map((line, i) => <div key={i}>{line || ' '}</div>)}
            {deploying && <span className="animate-pulse">▌</span>}
          </div>
        </div>
      )}

      <section>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Deployment History</p>
        {deployments.length === 0 ? (
          <div className="card text-gray-500 text-sm text-center py-8">No deployments yet</div>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs">
                  <th className="text-left px-4 py-2.5">Status</th>
                  <th className="text-left px-4 py-2.5">Compose Ver</th>
                  <th className="text-left px-4 py-2.5">Triggered By</th>
                  <th className="text-left px-4 py-2.5">Started</th>
                  <th className="text-left px-4 py-2.5">Duration</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {deployments.map(d => (
                  <tr key={d.id} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                    <td className="px-4 py-2.5"><span className={statusBadge(d.status)}>{d.status}</span></td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">v{d.new_compose_version}</td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">{d.triggered_by}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{new Date(d.started_at).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">
                      {d.finished_at
                        ? Math.round((new Date(d.finished_at).getTime() - new Date(d.started_at).getTime()) / 1000) + 's'
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        {d.status === 'success' && (
                          <button
                            onClick={() => setRollbackTarget(d)}
                            disabled={deploying}
                            className="text-xs text-blue-500 hover:text-blue-400 disabled:opacity-40"
                          >
                            Rollback
                          </button>
                        )}
                        {(d.status === 'success' || d.status === 'failed') && (
                          <button
                            onClick={() => setDeleteTarget(d)}
                            className="text-xs text-gray-600 hover:text-red-400 transition-colors"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {rollbackTarget && (
          <ConfirmModal
            title="Rollback Deployment"
            message={`Re-deploy compose version v${rollbackTarget.new_compose_version} (from ${new Date(rollbackTarget.started_at).toLocaleString()})? This will trigger a new deployment using that compose version.`}
            confirmLabel="Rollback"
            onConfirm={() => handleDeploy(rollbackTarget.new_compose_version)}
            onCancel={() => setRollbackTarget(null)}
          />
        )}

        {deleteTarget && (
          <ConfirmModal
            title="Delete Deployment Record"
            message={`Delete the ${deleteTarget.status} deployment from ${new Date(deleteTarget.started_at).toLocaleString()}? This only removes the record — it does not affect running containers.`}
            confirmLabel="Delete"
            danger
            onConfirm={() => handleDeleteDeployment(deleteTarget)}
            onCancel={() => setDeleteTarget(null)}
          />
        )}
      </section>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ProjectDashboardPage() {
  const { id } = useParams<{ id: string }>()
  const [tab, setTab] = useState<Tab>('overview')
  const [project, setProject] = useState<Project | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!id) return
    api.getProject(id).then(setProject).catch(() => setError('Project not found'))
  }, [id])

  if (error) return <div className="p-6 text-red-400">{error}</div>
  if (!project) return <div className="p-6 text-gray-500">Loading…</div>

  const statusBadge = ({
    running: 'badge-running', stopped: 'badge-stopped',
    error: 'badge-error', degraded: 'badge-degraded',
  } as Record<string, string>)[project.status] ?? 'badge-stopped'

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'compose', label: 'Compose' },
    { id: 'env', label: 'Env Vars' },
    { id: 'nginx', label: 'Nginx' },
    { id: 'deploy', label: 'Deploy' },
  ]

  return (
    <div className="p-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-semibold text-white">{project.name}</h1>
            <span className={statusBadge}>{project.status}</span>
          </div>
          {project.description && (
            <p className="text-sm text-gray-500 mt-0.5">{project.description}</p>
          )}
        </div>
        <button onClick={() => setTab('deploy')} className="ml-auto btn-primary">
          Deploy
        </button>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 mb-6 border-b border-gray-800 overflow-x-auto">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
              tab === t.id
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && id && <OverviewTab projectId={id} onStatusSync={p => setProject(p)} />}
      {tab === 'compose' && id && <ComposeTab projectId={id} />}
      {tab === 'env' && id && <EnvTab projectId={id} />}
      {tab === 'nginx' && id && <NginxTab projectId={id} />}
      {tab === 'deploy' && id && <DeployTab projectId={id} />}
    </div>
  )
}
