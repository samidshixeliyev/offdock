import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  api, Project, ContainerInfo, ComposeConfig, EnvVar,
  DeploymentRecord, FileEntry,
} from '../api/client'
import ConfirmModal from '../components/ConfirmModal'

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

// ─── Deploy Tab ───────────────────────────────────────────────────────────────
const DEPLOY_STEPS = [
  'Write Compose',
  'Write .env',
  'Force-Recreate',
  'Health Check',
]

type StepStatus = 'done' | 'active' | 'failed' | 'pending'

function parseStepStatuses(log: string[], deploying: boolean): StepStatus[] {
  let maxStep = -1
  const hasFailed = log.some(l => l.includes('FAILED:') || l.startsWith('✗'))
  for (const line of log) {
    const m = line.match(/\[(\d+)\/4\]/)
    if (m) {
      const n = parseInt(m[1]) - 1
      if (n > maxStep) maxStep = n
    }
  }
  return DEPLOY_STEPS.map((_, i) => {
    if (maxStep < 0) return 'pending'
    if (i < maxStep) return 'done'
    if (i === maxStep) {
      if (hasFailed) return 'failed'
      if (deploying) return 'active'
      return 'done'
    }
    return 'pending'
  })
}

function StepPipeline({ statuses }: { statuses: StepStatus[] }) {
  const icon: Record<StepStatus, React.ReactNode> = {
    done: <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>,
    active: <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>,
    failed: <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>,
    pending: <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-30"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" fill="none"/></svg>,
  }
  return (
    <div className="flex items-center gap-0">
      {DEPLOY_STEPS.map((label, i) => {
        const s = statuses[i]
        const cls = { done: 'step-done', active: 'step-active', failed: 'step-failed', pending: 'step-pending' }[s]
        return (
          <div key={i} className="flex items-center flex-1 min-w-0">
            <div className={`flex-1 border rounded-lg px-2 py-2.5 text-center ${cls} min-w-0`}>
              <div className="flex items-center justify-center mb-1">{icon[s]}</div>
              <div className="text-xs leading-tight truncate">{label}</div>
            </div>
            {i < DEPLOY_STEPS.length - 1 && (
              <div className={`w-3 h-px shrink-0 ${s === 'done' ? 'bg-green-700' : 'bg-slate-800'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

const depBadge: Record<string, string> = {
  pending: 'badge-pending', running: 'badge-pending',
  success: 'badge-running', failed: 'badge-error',
  cancelled: 'badge-stopped',
}

function DeployTab({ projectId }: { projectId: string }) {
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([])
  const [log, setLog] = useState<string[]>([])
  const [deploying, setDeploying] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [streamKey, setStreamKey] = useState('')
  const [activeDepId, setActiveDepId] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [rollbackTarget, setRollbackTarget] = useState<DeploymentRecord | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeploymentRecord | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const loadHistory = () =>
    api.listDeployments(projectId).then(d => setDeployments(d ?? [])).catch(() => {})

  useEffect(() => { loadHistory() }, [projectId])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  useEffect(() => {
    if (!streamKey) return
    const es = new EventSource(`/api/v1/projects/${projectId}/deployments/${streamKey}/stream`)
    es.onmessage = e => {
      try {
        const data = JSON.parse(e.data as string) as Record<string, string>
        if (data.log) setLog(prev => [...prev, data.log])
        if (data.error) {
          setLog(prev => [...prev, `✗ ${data.error}`])
          // don't close — wait for the status event that always follows
        }
        if (data.status) {
          const ok = data.status === 'success'
          setLog(prev => [...prev, ok ? '✓ Deployment complete' : `✗ Deployment ${data.status}`])
          setDeploying(false)
          setCancelling(false)
          es.close()
          loadHistory()
        }
      } catch {}
    }
    es.onerror = () => {
      setDeploying(false)
      setCancelling(false)
      es.close()
      loadHistory()
    }
    return () => es.close()
  }, [streamKey, projectId])

  const handleDeploy = async (composeVersion?: number) => {
    setDeploying(true)
    setCancelling(false)
    setLog([composeVersion ? `Rolling back to compose v${composeVersion}…` : 'Starting deployment…'])
    setExpandedId(null)
    setRollbackTarget(null)
    try {
      const { deployment_id } = await api.triggerDeploy(projectId, composeVersion)
      setStreamKey(deployment_id)
      setActiveDepId(deployment_id)
    } catch (e) {
      setLog(['✗ ' + (e instanceof Error ? e.message : 'unknown error')])
      setDeploying(false)
    }
  }

  const handleCancel = async () => {
    if (!activeDepId || cancelling) return
    setCancelling(true)
    try {
      await api.cancelDeploy(projectId, activeDepId)
      setLog(prev => [...prev, '⚠ Cancellation requested — waiting for cleanup…'])
    } catch (e) {
      setLog(prev => [...prev, '✗ Cancel failed: ' + (e instanceof Error ? e.message : 'unknown')])
      setCancelling(false)
    }
  }

  const handleDelete = async (dep: DeploymentRecord) => {
    try {
      await api.deleteDeployment(projectId, dep.id)
      setDeployments(prev => prev.filter(d => d.id !== dep.id))
    } catch {}
    setDeleteTarget(null)
  }

  const durStr = (d: DeploymentRecord) => {
    if (!d.finished_at) return d.status === 'running' ? 'running…' : '—'
    const ms = new Date(d.finished_at).getTime() - new Date(d.started_at).getTime()
    return Math.round(ms / 1000) + 's'
  }

  const stepStatuses = parseStepStatuses(log, deploying)

  return (
    <div className="space-y-6">
      {/* Action */}
      <div className="flex items-center justify-between">
        <p className="section-heading">Deploy</p>
        <div className="flex items-center gap-2">
          {deploying && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="text-xs text-slate-500 hover:text-red-400 disabled:opacity-40 transition-colors px-3 py-1.5 border border-slate-700 hover:border-red-900/60 rounded-lg"
            >
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          <button onClick={() => handleDeploy()} disabled={deploying} className="btn-primary">
            {deploying ? (
              <>
                <svg className="animate-spin w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Deploying…
              </>
            ) : (
              <>
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                </svg>
                Trigger Deploy
              </>
            )}
          </button>
        </div>
      </div>

      {/* Live pipeline + terminal */}
      {log.length > 0 && (
        <div className="card space-y-4">
          <p className="section-heading">Pipeline</p>
          <StepPipeline statuses={stepStatuses} />
          <div>
            <p className="text-xs text-slate-600 mb-2">Live output</p>
            <div ref={logRef} className="terminal p-4 text-green-400 h-56">
              {log.map((line, i) => (
                <div key={i} className={
                  line.startsWith('✗') ? 'text-red-400' :
                  line.startsWith('✓') ? 'text-green-300 font-medium' :
                  line.match(/\[\d+\/7\]/) ? 'text-blue-300' :
                  ''
                }>
                  {line || ' '}
                </div>
              ))}
              {deploying && <span className="animate-pulse opacity-60">▌</span>}
            </div>
          </div>
        </div>
      )}

      {/* Deployment history */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <p className="section-heading">History</p>
          {deployments.some(d => d.status === 'success') && (
            <span className="text-xs text-slate-600">
              {deployments.filter(d => d.status === 'success').length} successful · click row for logs · Rollback re-deploys a prior compose version
            </span>
          )}
        </div>
        {deployments.length === 0 ? (
          <div className="card text-slate-600 text-sm text-center py-8 border-dashed">
            No deployments yet — trigger one above.
          </div>
        ) : (
          <div className="card p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-slate-500">
                  <th className="text-left px-4 py-3 text-xs font-medium">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-medium">Compose</th>
                  <th className="text-left px-4 py-3 text-xs font-medium">By</th>
                  <th className="text-left px-4 py-3 text-xs font-medium">Started</th>
                  <th className="text-left px-4 py-3 text-xs font-medium">Duration</th>
                  <th className="px-4 py-3 text-xs"></th>
                </tr>
              </thead>
              <tbody>
                {deployments.map(d => (
                  <>
                    <tr
                      key={d.id}
                      className="border-b border-slate-800/50 hover:bg-slate-800/20 cursor-pointer"
                      onClick={() => setExpandedId(expandedId === d.id ? null : d.id)}
                    >
                      <td className="px-4 py-3">
                        <span className={depBadge[d.status] ?? 'badge-stopped'}>{d.status}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs font-mono font-medium">v{d.new_compose_version}</td>
                      <td className="px-4 py-3 text-slate-500 text-xs">{d.triggered_by}</td>
                      <td className="px-4 py-3 text-slate-600 text-xs">{new Date(d.started_at).toLocaleString()}</td>
                      <td className="px-4 py-3 text-slate-600 text-xs tabular-nums">{durStr(d)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 justify-end">
                          <span className="text-xs text-slate-700">{expandedId === d.id ? '▲' : '▼'}</span>
                          {d.status === 'success' && (
                            <button
                              onClick={e => { e.stopPropagation(); setRollbackTarget(d) }}
                              disabled={deploying}
                              className="text-xs px-2.5 py-1 rounded border border-blue-900/50 text-blue-400 hover:bg-blue-950/50 disabled:opacity-40 transition-colors"
                            >
                              ↩ Rollback
                            </button>
                          )}
                          {(d.status === 'success' || d.status === 'failed' || d.status === 'cancelled') && (
                            <button
                              onClick={e => { e.stopPropagation(); setDeleteTarget(d) }}
                              className="text-xs text-slate-600 hover:text-red-400 transition-colors px-1"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>

                    {expandedId === d.id && (
                      <tr key={d.id + '-log'} className="border-b border-slate-800/50 bg-slate-950/60">
                        <td colSpan={6} className="px-4 pb-4 pt-3">
                          {d.status === 'success' && (
                            <div className="mb-3 flex items-center gap-2">
                              <span className="text-xs text-slate-500">Rollback plan:</span>
                              <span className="text-xs text-slate-300">Re-deploy compose <code className="text-blue-400 font-mono">v{d.new_compose_version}</code> through the full healthcheck-cutover pipeline</span>
                              <button
                                onClick={e => { e.stopPropagation(); setRollbackTarget(d) }}
                                disabled={deploying}
                                className="text-xs px-2.5 py-1 rounded border border-blue-900/50 text-blue-400 hover:bg-blue-950/50 disabled:opacity-40 transition-colors ml-auto shrink-0"
                              >
                                ↩ Rollback to v{d.new_compose_version}
                              </button>
                            </div>
                          )}
                          <div className="terminal p-4 text-green-400 max-h-72 overflow-y-auto">
                            {d.log_text
                              ? d.log_text.split('\n').map((line, i) => (
                                  <div key={i} className={
                                    line.startsWith('FAILED') || line.startsWith('CANCELLED') ? 'text-red-400' :
                                    line.match(/\[\d+\/7\]/) ? 'text-blue-300 font-medium' :
                                    line.includes('complete') ? 'text-green-300 font-medium' :
                                    line.startsWith('  [cleanup]') || line.startsWith('  [rollback]') ? 'text-yellow-400' :
                                    ''
                                  }>
                                    {line || ' '}
                                  </div>
                                ))
                              : <span className="text-slate-600">No log captured</span>
                            }
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {rollbackTarget && (
        <ConfirmModal
          title="Rollback Deployment"
          message={`Re-deploy compose version v${rollbackTarget.new_compose_version} (from ${new Date(rollbackTarget.started_at).toLocaleString()})? This triggers a new deployment using that compose version.`}
          confirmLabel="Rollback"
          onConfirm={() => handleDeploy(rollbackTarget.new_compose_version)}
          onCancel={() => setRollbackTarget(null)}
        />
      )}
      {deleteTarget && (
        <ConfirmModal
          title="Delete Record"
          message={`Delete the ${deleteTarget.status} deployment from ${new Date(deleteTarget.started_at).toLocaleString()}? Running containers are not affected.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
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
  const [tab, setTab] = useState<Tab>('overview')
  const [project, setProject] = useState<Project | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!id) return
    api.getProject(id).then(setProject).catch(() => setError('Project not found'))
  }, [id])

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
      {tab === 'deploy' && id && <DeployTab projectId={id} />}
    </div>
  )
}
