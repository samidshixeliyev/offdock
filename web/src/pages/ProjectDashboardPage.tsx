import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import {
  api, Project, ContainerInfo, ComposeConfig, EnvVar, FileEntry,
} from '../api/client'
import { useToast } from '../components/Toast'
import { Copy } from 'lucide-react'
import DeployPage from './DeployPage'

type Tab = 'overview' | 'compose' | 'env' | 'deploy'
type MsgT = 'ok' | 'err'

function Msg({ text, type }: { text: string; type: MsgT }) {
  if (!text) return null
  return (
    <span className={`text-xs px-2 py-1 rounded border ${
      type === 'err'
        ? 'bg-red-950 text-red-300 border-red-900/50'
        : 'bg-green-950 text-green-300 border-green-900/50'
    }`}>
      {text}
    </span>
  )
}

// ─── Container Logs Modal ─────────────────────────────────────────────────────
function LogsModal({ projectId, containerName, onClose }: {
  projectId: string
  containerName: string
  onClose: () => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const es = new EventSource(
      `/api/v1/projects/${projectId}/containers/${encodeURIComponent(containerName)}/logs?tail=200`
    )
    es.onmessage = e => {
      try {
        const d = JSON.parse(e.data as string) as { line: string }
        setLines(prev => [...prev.slice(-499), d.line])
      } catch {}
    }
    es.onerror = () => es.close()
    return () => es.close()
  }, [projectId, containerName])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-white">Container Logs</h3>
            <p className="text-xs text-slate-500 font-mono">{containerName}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">×</button>
        </div>
        <div ref={logRef} className="flex-1 overflow-y-auto min-h-0 p-4 terminal text-green-400 text-xs leading-relaxed font-mono">
          {lines.length === 0
            ? <span className="text-slate-600 animate-pulse">Connecting to log stream…</span>
            : lines.map((l, i) => <div key={i}>{l || ' '}</div>)
          }
        </div>
      </div>
    </div>
  )
}

// ─── Exec Modal ───────────────────────────────────────────────────────────────
function ExecModal({ containerName, onClose }: { containerName: string; onClose: () => void }) {
  const [cmd, setCmd] = useState(`docker exec -it ${containerName} sh`)
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const run = async () => {
    if (!cmd.trim()) return
    setRunning(true)
    try {
      const r = await api.execCommand(cmd)
      const out = [r.stdout, r.stderr].filter(Boolean).join('\n')
      setOutput(prev => prev + `$ ${cmd}\n${out}\n`)
    } catch (e) {
      setOutput(prev => prev + `$ ${cmd}\nError: ${e instanceof Error ? e.message : 'unknown'}\n`)
    } finally { setRunning(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-white">Run Command</h3>
            <p className="text-xs text-slate-500">Commands run on the host. Use docker exec to reach containers.</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 p-4 terminal text-green-400 text-xs leading-relaxed">
          {output ? output.split('\n').map((l, i) => (
            <div key={i} className={l.startsWith('$') ? 'text-blue-300 mt-2' : ''}>{l || ' '}</div>
          )) : <span className="text-slate-600">Type a command below and press Enter</span>}
        </div>
        <div className="flex gap-2 px-4 py-3 border-t border-slate-800 shrink-0">
          <span className="text-blue-400 text-xs font-mono mt-2">$</span>
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-xs font-mono text-green-300 focus:outline-none py-2"
            value={cmd}
            onChange={e => setCmd(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !running) run() }}
            placeholder="command"
          />
          <button onClick={run} disabled={running} className="btn-ghost text-xs shrink-0">
            {running ? '…' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Server file row helper ───────────────────────────────────────────────────
function ServerFileRow({ entry, serverMount, onNavigate, onSelect, onPreview, fmtSize }: {
  entry: FileEntry
  serverMount: string
  onNavigate: (mount: string, path: string) => void
  onSelect: (entry: FileEntry) => void
  onPreview: (entry: FileEntry) => void
  fmtSize: (n: number) => string
}) {
  return (
    <div className="flex items-center justify-between px-4 py-1.5 border-b border-slate-800/40 hover:bg-slate-800/30">
      <button className="flex items-center gap-2.5 text-left min-w-0 flex-1"
        onClick={() => entry.is_dir ? onNavigate(serverMount, entry.path) : onPreview(entry)}>
        <span className={`text-xs w-3 shrink-0 ${entry.is_dir ? 'text-blue-400' : 'text-slate-600'}`}>
          {entry.is_dir ? '▸' : '·'}
        </span>
        <span className="font-mono text-xs text-slate-300 truncate">{entry.name}</span>
        {!entry.is_dir && entry.size > 0 && <span className="text-xs text-slate-700 shrink-0">{fmtSize(entry.size)}</span>}
      </button>
      {!entry.is_dir && (
        <button onClick={() => onSelect(entry)} className="btn-primary text-xs py-0.5 shrink-0 ml-2">Use</button>
      )}
    </div>
  )
}

// ─── Dual-mode File Browser ───────────────────────────────────────────────────
// Tab "local" — browser native file picker (reads file from user's computer).
// Tab "server" — browse server filesystem with a configurable base path.
type BrowserTab = 'local' | 'server'

function FileBrowser({ onSelect, onClose }: {
  onSelect: (value: string, filename: string) => void
  onClose: () => void
}) {
  const [activeTab, setActiveTab] = useState<BrowserTab>('local')
  const [localErr, setLocalErr] = useState('')

  // ── Server tab ──
  const [serverMount, setServerMount] = useState('/var/offdock')
  const [serverPath, setServerPath] = useState('/var/offdock')
  const [serverEntries, setServerEntries] = useState<FileEntry[]>([])
  const [serverLoading, setServerLoading] = useState(false)
  const [serverErr, setServerErr] = useState('')
  const [serverPreview, setServerPreview] = useState<{ name: string; content: string } | null>(null)

  const fmtSize = (bytes: number) => {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB'
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB'
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + ' KB'
    return bytes + ' B'
  }

  const browseServer = async (m: string, p: string) => {
    setServerLoading(true); setServerErr('')
    try {
      void m
      const files = await api.fileBrowse(p)
      setServerEntries(files ?? []); setServerPath(p)
    } catch (e) { setServerErr(e instanceof Error ? e.message : 'Error') }
    finally { setServerLoading(false) }
  }

  const serverUp = () => {
    const base = serverMount.replace(/\/$/, '')
    const parts = serverPath.split('/').filter(Boolean)
    if (!parts.length) return
    parts.pop()
    const parent = parts.length ? '/' + parts.join('/') : base
    if (parent === base || (parent + '/').startsWith(base + '/')) browseServer(serverMount, parent)
  }

  const selectServerFile = async (entry: FileEntry) => {
    try {
      const res = await api.fileRead(entry.path)
      onSelect(res.content, entry.name); onClose()
    } catch (e) { setServerErr(e instanceof Error ? e.message : 'Read failed') }
  }

  // ── Local file picker ──
  const handleLocalFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLocalErr('')
    const reader = new FileReader()
    reader.onload = ev => {
      const content = ev.target?.result as string
      onSelect(content, file.name)
      onClose()
    }
    reader.onerror = () => setLocalErr('Failed to read file')
    reader.readAsText(file)
  }

  useEffect(() => { if (activeTab === 'server') browseServer('/var/offdock', '/var/offdock') }, [activeTab])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 shrink-0">
          <h3 className="text-sm font-semibold text-white">Browse Files</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="flex border-b border-slate-800 shrink-0 px-5">
          {(['local', 'server'] as BrowserTab[]).map(t => (
            <button key={t} onClick={() => setActiveTab(t)}
              className={`px-4 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                activeTab === t ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}>
              {t === 'local' ? 'My Computer' : 'Server Files'}
            </button>
          ))}
        </div>

        {/* ── My Computer tab (client-side file picker) ── */}
        {activeTab === 'local' && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 gap-5">
            <div className="w-14 h-14 rounded-2xl bg-slate-800 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 text-slate-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 13.5l3 3m0 0l3-3m-3 3v-6m1.06-4.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-slate-200 mb-1">Choose a file from your computer</p>
              <p className="text-xs text-slate-500">Supports .yml, .yaml, .env, .txt and other text files</p>
            </div>
            {localErr && <p className="text-xs text-red-400">{localErr}</p>}
            <label className="btn-primary cursor-pointer">
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path d="M9.25 13.25a.75.75 0 001.5 0V4.636l2.955 3.129a.75.75 0 001.09-1.03l-4.25-4.5a.75.75 0 00-1.09 0l-4.25 4.5a.75.75 0 101.09 1.03L9.25 4.636v8.614z" />
                <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
              </svg>
              Select File
              <input type="file" className="hidden" accept=".yml,.yaml,.env,.txt,.conf,.json,.toml,.ini,.sh" onChange={handleLocalFile} />
            </label>
          </div>
        )}

        {/* ── Server Files tab ── */}
        {activeTab === 'server' && (
          <>
            <div className="px-5 py-3 border-b border-slate-800 space-y-1.5 shrink-0">
              <div className="flex gap-2">
                <input className="input font-mono text-xs flex-1"
                  placeholder="Base directory"
                  value={serverMount}
                  onChange={e => setServerMount(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && browseServer(serverMount, serverMount)} />
                <button onClick={() => { setServerPath(serverMount); browseServer(serverMount, serverMount) }}
                  className="btn-ghost text-xs">Go</button>
              </div>
              <p className="text-xs text-slate-600 font-mono truncate">{serverPath}</p>
              {serverErr && <p className="text-xs text-red-400">{serverErr}</p>}
            </div>
            <div className="flex flex-1 min-h-0 overflow-hidden">
              {/* File list */}
              <div className="w-1/2 overflow-y-auto border-r border-slate-800">
                {serverLoading && <p className="px-5 py-6 text-slate-500 text-sm text-center">Loading…</p>}
                {serverPath !== serverMount.replace(/\/$/, '') && (
                  <button onClick={serverUp}
                    className="w-full flex items-center gap-2 px-5 py-2.5 text-sm text-slate-400 hover:bg-slate-800 border-b border-slate-800">
                    <span className="text-slate-600">↑</span> ..
                  </button>
                )}
                {serverEntries.map(e => (
                  <ServerFileRow
                    key={e.path}
                    entry={e}
                    serverMount={serverMount}
                    onNavigate={browseServer}
                    onSelect={selectServerFile}
                    onPreview={async (entry) => {
                      try {
                        const res = await api.fileRead(entry.path)
                        setServerPreview({ name: entry.name, content: res.content })
                      } catch { setServerPreview({ name: entry.name, content: '[Error reading file]' }) }
                    }}
                    fmtSize={fmtSize}
                  />
                ))}
                {!serverLoading && serverEntries.length === 0 && (
                  <p className="px-5 py-8 text-slate-600 text-sm text-center">Empty directory</p>
                )}
              </div>

              {/* Content preview */}
              <div className="w-1/2 flex flex-col overflow-hidden">
                {serverPreview ? (
                  <>
                    <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 shrink-0">
                      <span className="text-xs font-mono text-slate-400 truncate">{serverPreview.name}</span>
                      <button onClick={() => setServerPreview(null)} className="text-slate-600 hover:text-slate-300 text-xs ml-2">✕</button>
                    </div>
                    <pre className="flex-1 overflow-y-auto p-3 text-xs font-mono text-slate-300 leading-relaxed whitespace-pre-wrap bg-slate-950">
                      {serverPreview.content}
                    </pre>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-xs text-slate-700">
                    Click a file to preview its content
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Inline Log Viewer ────────────────────────────────────────────────────────
function InlineLogViewer({ name, projectId }: { name: string; projectId: string }) {
  const [lines, setLines] = useState<string[]>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const es = new EventSource(
      `/api/v1/projects/${projectId}/containers/${encodeURIComponent(name)}/logs?tail=50`
    )
    es.onmessage = e => {
      try {
        const d = JSON.parse(e.data as string) as { line: string }
        setLines(prev => [...prev.slice(-199), d.line])
      } catch {}
    }
    es.onerror = () => es.close()
    return () => es.close()
  }, [name, projectId])

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines])

  return (
    <div ref={ref} className="terminal p-3 text-green-400 text-xs h-40 overflow-y-auto mt-2">
      {lines.length === 0
        ? <span className="text-slate-600 animate-pulse">Connecting…</span>
        : lines.map((l, i) => {
            const lc = l.toLowerCase()
            const cls = lc.includes('error') || lc.includes('err:') ? 'text-red-400'
              : lc.includes('warn') ? 'text-yellow-400' : ''
            return <div key={i} className={cls}>{l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s?/, '') || ' '}</div>
          })
      }
    </div>
  )
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────
function OverviewTab({ projectId, onStatusSync }: {
  projectId: string
  onStatusSync: (p: Project) => void
}) {
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [actionBusy, setActionBusy] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [execOpen, setExecOpen] = useState(false)
  const [inlineLogsFor, setInlineLogsFor] = useState<string | null>(null)

  const refresh = () => {
    setLoading(true)
    api.listContainers(projectId).then(d => setContainers(d ?? [])).catch(() => {}).finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [projectId])

  const syncStatus = async () => {
    setSyncing(true)
    try {
      const updated = await api.syncProjectStatus(projectId)
      onStatusSync(updated); refresh()
    } catch {} finally { setSyncing(false) }
  }

  const doAction = async (name: string, action: 'restart' | 'stop' | 'start') => {
    setActionBusy(name + ':' + action)
    try {
      await api.containerAction(projectId, name, action)
      await new Promise(r => setTimeout(r, 800))
      refresh()
    } catch {} finally { setActionBusy('') }
  }

  const stateColor = (state: string) =>
    state === 'running' ? 'text-green-300 bg-green-950 border-green-900/50' :
    state === 'exited'  ? 'text-red-300 bg-red-950 border-red-900/50' :
                          'text-slate-400 bg-slate-800 border-slate-700'

  return (
    <div className="space-y-4">
      {logsFor && (
        <LogsModal projectId={projectId} containerName={logsFor} onClose={() => setLogsFor(null)} />
      )}
      {execOpen && (
        <ExecModal containerName={containers[0]?.Names ?? ''} onClose={() => setExecOpen(false)} />
      )}

      {/* Containers */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="section-heading">Containers</p>
          <div className="flex gap-2">
            <button onClick={() => setExecOpen(true)} className="btn-ghost text-xs">Run Command</button>
            <button onClick={syncStatus} disabled={syncing} className="btn-ghost text-xs">
              {syncing ? 'Syncing…' : 'Sync Status'}
            </button>
            <button onClick={refresh} className="btn-ghost text-xs">Refresh</button>
          </div>
        </div>

        {loading ? (
          <div className="card text-slate-600 text-sm py-8 text-center">Loading…</div>
        ) : containers.length === 0 ? (
          <div className="card text-center py-10 border-dashed">
            <p className="text-slate-500 text-sm">No containers running for this project.</p>
            <p className="text-slate-700 text-xs mt-1 mb-4">Deploy the project to start containers.</p>
            <button onClick={syncStatus} disabled={syncing} className="btn-ghost text-xs">
              {syncing ? 'Syncing…' : 'Sync Status from Docker'}
            </button>
          </div>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-slate-500">
                  <th className="text-left px-4 py-3 text-xs font-medium">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-medium">Image</th>
                  <th className="text-left px-4 py-3 text-xs font-medium">State</th>
                  <th className="text-left px-4 py-3 text-xs font-medium">Ports</th>
                  <th className="px-4 py-3 text-xs font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {containers.map(c => (
                  <>
                    <tr key={c.ID} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                      <td className="px-4 py-3 font-mono text-xs text-slate-200">{c.Names}</td>
                      <td className="px-4 py-3 text-slate-500 text-xs truncate max-w-[160px]">{c.Image}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${stateColor(c.State)}`}>
                          {c.Status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600 font-mono">{c.Ports || '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-3">
                          <button
                            onClick={() => setInlineLogsFor(inlineLogsFor === c.Names ? null : c.Names)}
                            className={`text-xs transition-colors ${inlineLogsFor === c.Names ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'}`}>
                            {inlineLogsFor === c.Names ? '▲ Logs' : '▼ Logs'}
                          </button>
                          <button onClick={() => setLogsFor(c.Names)}
                            className="text-xs text-slate-500 hover:text-slate-300 transition-colors" title="Full screen logs">
                            ↗
                          </button>
                          <button onClick={() => doAction(c.Names, 'restart')} disabled={!!actionBusy}
                            className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 transition-colors">
                            {actionBusy === c.Names + ':restart' ? '…' : 'Restart'}
                          </button>
                          {c.State === 'running' ? (
                            <button onClick={() => doAction(c.Names, 'stop')} disabled={!!actionBusy}
                              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40 transition-colors">
                              {actionBusy === c.Names + ':stop' ? '…' : 'Stop'}
                            </button>
                          ) : (
                            <button onClick={() => doAction(c.Names, 'start')} disabled={!!actionBusy}
                              className="text-xs text-green-400 hover:text-green-300 disabled:opacity-40 transition-colors">
                              {actionBusy === c.Names + ':start' ? '…' : 'Start'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {inlineLogsFor === c.Names && (
                      <tr key={c.ID + '-logs'} className="border-b border-slate-800/50 bg-slate-950/50">
                        <td colSpan={5} className="px-4 pb-3 pt-0">
                          <InlineLogViewer name={c.Names} projectId={projectId} />
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Compose Tab ──────────────────────────────────────────────────────────────
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
      const { config: cfg, unchanged } = await api.saveCompose(projectId, yaml)
      setSelected(cfg)
      api.composeHistory(projectId).then(d => setHistory(d ?? []))
      notify(unchanged ? 'No changes — still on version ' + cfg.version : 'Saved as version ' + cfg.version)
    } catch (e) {
      notify('Error: ' + (e instanceof Error ? e.message : 'unknown'), 'err')
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <p className="section-heading flex-1">docker-compose.yml</p>
        <Msg text={msg} type={msgType} />
        <button onClick={() => setShowBrowser(true)} className="btn-ghost text-xs">Browse Files</button>
        <button onClick={save} disabled={saving} className="btn-primary">
          {saving ? 'Saving…' : 'Save Version'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-3">
          <textarea
            className="w-full font-mono text-xs bg-slate-900 border border-slate-700 rounded-xl p-4 text-slate-200 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40 resize-y leading-relaxed"
            style={{ minHeight: '24rem' }}
            placeholder={'services:\n  app:\n    image: myapp:latest\n    ports:\n      - "3000:3000"'}
            value={yaml}
            onChange={e => setYaml(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div>
          <p className="text-xs font-medium text-slate-600 uppercase tracking-widest mb-2">History</p>
          {history.length === 0
            ? <p className="text-xs text-slate-700 px-1">No versions yet</p>
            : (
              <div className="space-y-1">
                {history.map(cfg => (
                  <button key={cfg.id}
                    onClick={() => { setYaml(cfg.raw_yaml); setSelected(cfg) }}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-xs transition-colors border ${
                      selected?.id === cfg.id
                        ? 'bg-blue-950 text-blue-300 border-blue-900/50'
                        : 'text-slate-500 hover:bg-slate-800/70 border-transparent'
                    }`}
                  >
                    <div className="font-medium">v{cfg.version}</div>
                    <div className="text-slate-700 mt-0.5">{new Date(cfg.created_at).toLocaleString()}</div>
                  </button>
                ))}
              </div>
            )
          }
        </div>
      </div>

      {showBrowser && (
        <FileBrowser
          onSelect={(content) => { setYaml(content); notify('File loaded') }}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </div>
  )
}

// ─── Env Tab ──────────────────────────────────────────────────────────────────
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

  const save = async () => {
    setSaving(true); notify('')
    try {
      const payload: EnvVar[] = vars.map(({ key, value, is_secret }) => ({ key, value, is_secret }))
      const { env: set, unchanged } = await api.saveEnv(projectId, payload)
      setVars((set.vars ?? []).map(v => makeVar(v.key, v.value, v.is_secret)))
      notify(unchanged ? 'No changes — still on version ' + set.version : 'Saved as version ' + set.version)
    } catch (e) {
      notify('Error: ' + (e instanceof Error ? e.message : 'unknown'), 'err')
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <p className="section-heading flex-1">Environment Variables</p>
        <Msg text={msg} type={msgType} />
        <button onClick={() => setShowBrowser(true)} className="btn-ghost text-xs">Browse Files</button>
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
          <p className="text-xs text-slate-400">Paste .env content — existing keys will be updated, new keys added.</p>
          <textarea
            className="w-full font-mono text-xs bg-slate-950 border border-slate-700 rounded-lg p-3 text-slate-200 focus:outline-none focus:border-blue-500 resize-y"
            style={{ minHeight: '10rem' }}
            placeholder={'DATABASE_URL=postgres://localhost/mydb\nSECRET=changeme\nPORT=3000'}
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
          <div className="card text-center text-slate-500 py-10 text-sm border-dashed">
            No variables yet.
            <p className="text-xs text-slate-700 mt-1">Click "+ Add", "Browse Files" to pick a .env, or "Paste .env".</p>
          </div>
        )}
        {vars.map(v => (
          <div key={v._id} className="card-sm flex items-center gap-3">
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
                placeholder={v.is_secret && v.value === '********' ? '(saved — clear to change)' : 'value'}
                type={v.is_secret && !v.revealed ? 'password' : 'text'}
                value={v.value}
                onChange={e => update(v._id, 'value', e.target.value)}
              />
              {v.is_secret && (
                <button
                  type="button"
                  onClick={() => update(v._id, 'revealed', !v.revealed)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs"
                >
                  {v.revealed ? 'hide' : 'show'}
                </button>
              )}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-slate-500 shrink-0 cursor-pointer">
              <input type="checkbox" checked={v.is_secret}
                onChange={e => update(v._id, 'is_secret', e.target.checked)} className="rounded" />
              Secret
            </label>
            <button
              onClick={() => removeVar(v._id)}
              className="text-slate-700 hover:text-red-400 text-sm transition-colors shrink-0"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {showBrowser && (
        <FileBrowser
          onSelect={(content, filename) => {
            setPasteText(content); setPasteMode(true)
            notify('Loaded ' + filename + ' — review and click Import')
          }}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </div>
  )
}


// ─── Main Page ────────────────────────────────────────────────────────────────
const statusDot: Record<string, string> = {
  running: 'dot-running', stopped: 'dot-stopped', error: 'dot-error', degraded: 'dot-degraded',
}
const statusBadge: Record<string, string> = {
  running: 'badge-running', stopped: 'badge-stopped', error: 'badge-error', degraded: 'badge-degraded',
}

export default function ProjectDashboardPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('overview')
  const [project, setProject] = useState<Project | null>(null)
  const [error, setError] = useState('')
  const [cloning, setCloning] = useState(false)
  const [showClone, setShowClone] = useState(false)
  const [cloneName, setCloneName] = useState('')
  const toast = useToast()

  useEffect(() => {
    if (!id) return
    api.getProject(id).then(setProject).catch(() => setError('Project not found'))
  }, [id])

  const handleClone = async () => {
    if (!id || !cloneName.trim()) return
    setCloning(true)
    try {
      const cloned = await api.cloneProject(id, cloneName.trim())
      toast.success(`Project cloned as "${cloned.name}"`)
      setShowClone(false)
      setCloneName('')
      navigate(`/projects/${cloned.id}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Clone failed') } finally { setCloning(false) }
  }

  if (error) return <div className="p-6 text-red-400 text-sm">{error}</div>
  if (!project) return <div className="p-6 text-slate-600 text-sm">Loading…</div>

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'compose', label: 'Compose' },
    { id: 'env', label: 'Env Vars' },
    { id: 'deploy', label: 'Deploy' },
  ]

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-6xl">
      {/* Clone modal */}
      {showClone && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-80 shadow-2xl">
            <h2 className="text-sm font-semibold text-white mb-4">Clone project</h2>
            <label className="block text-xs text-slate-500 mb-1.5">New project name</label>
            <input
              autoFocus value={cloneName} onChange={e => setCloneName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleClone()}
              className="w-full h-8 px-3 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-blue-500 mb-4"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowClone(false)} className="btn-secondary text-xs">Cancel</button>
              <button onClick={handleClone} disabled={cloning || !cloneName.trim()} className="btn-primary text-xs">
                {cloning ? 'Cloning…' : 'Clone'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-xs text-slate-600 mb-5">
        <Link to="/" className="hover:text-slate-400 transition-colors">Dashboard</Link>
        <span>/</span>
        <span className="text-slate-400">{project.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start gap-4 mb-6 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <span className={statusDot[project.status] ?? 'dot-stopped'} />
            <h1 className="text-lg font-semibold text-white truncate">{project.name}</h1>
            <span className={statusBadge[project.status] ?? 'badge-stopped'}>{project.status}</span>
          </div>
          {project.description && (
            <p className="text-sm text-slate-600 mt-1 pl-4">{project.description}</p>
          )}
        </div>
        <button onClick={() => { setCloneName(project.name + '-copy'); setShowClone(true) }}
          title="Clone this project" className="btn-secondary shrink-0">
          <Copy className="w-4 h-4" /> Clone
        </button>
        <button onClick={() => setTab('deploy')} className="btn-primary shrink-0">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
          </svg>
          Deploy
        </button>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-0.5 mb-6 border-b border-slate-800 overflow-x-auto">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
              tab === t.id
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-500 hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && id && (
        <OverviewTab projectId={id} onStatusSync={p => setProject(p)} />
      )}
      {tab === 'compose' && id && <ComposeTab projectId={id} />}
      {tab === 'env' && id && <EnvTab projectId={id} />}
      {tab === 'deploy' && id && <DeployPage />}
    </div>
  )
}
