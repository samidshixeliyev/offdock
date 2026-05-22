import { useCallback, useEffect, useRef, useState } from 'react'
import { api, FileEntry, FileReadResult } from '../api/client'
import clsx from 'clsx'

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtSize(bytes: number): string {
  if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + ' TB'
  if (bytes >= 1e9)  return (bytes / 1e9).toFixed(2) + ' GB'
  if (bytes >= 1e6)  return (bytes / 1e6).toFixed(1) + ' MB'
  if (bytes >= 1e3)  return (bytes / 1e3).toFixed(0) + ' KB'
  return bytes + ' B'
}

function fmtDate(iso: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

function parentPath(p: string) {
  if (p === '/') return '/'
  const parts = p.split('/').filter(Boolean)
  if (parts.length <= 1) return '/'
  return '/' + parts.slice(0, -1).join('/')
}

function isImageMime(mime: string) {
  return mime.startsWith('image/')
}

function langFromMime(mime: string): string {
  const map: Record<string, string> = {
    'text/yaml': 'yaml', 'text/x-shellscript': 'bash',
    'text/x-python': 'python', 'text/x-go': 'go',
    'text/typescript': 'typescript', 'text/javascript': 'javascript',
    'text/html': 'html', 'text/css': 'css', 'text/markdown': 'markdown',
    'application/json': 'json', 'text/toml': 'toml',
    'text/x-sql': 'sql', 'text/xml': 'xml',
  }
  return map[mime] ?? 'plaintext'
}

// ─── File icon ────────────────────────────────────────────────────────────────
function FileIcon({ entry }: { entry: FileEntry }) {
  if (entry.is_dir) {
    return (
      <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-blue-400 shrink-0">
        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
      </svg>
    )
  }
  const mime = entry.mime ?? ''
  if (isImageMime(mime)) {
    return (
      <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-purple-400 shrink-0">
        <path fillRule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clipRule="evenodd"/>
      </svg>
    )
  }
  const colorMap: Record<string, string> = {
    'text/yaml': 'text-orange-400', 'text/x-shellscript': 'text-green-400',
    'application/json': 'text-yellow-400', 'text/x-go': 'text-cyan-400',
    'text/x-python': 'text-blue-400', 'text/plain': 'text-gray-400',
    'text/markdown': 'text-gray-300',
  }
  const color = colorMap[mime] ?? 'text-gray-500'
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={`w-4 h-4 ${color} shrink-0`}>
      <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd"/>
    </svg>
  )
}

// ─── Breadcrumb ───────────────────────────────────────────────────────────────
function Breadcrumb({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const parts = path.split('/').filter(Boolean)
  return (
    <div className="flex items-center gap-1 text-xs font-mono overflow-x-auto py-1">
      <button onClick={() => onNavigate('/')} className="text-blue-400 hover:text-blue-300 shrink-0">/</button>
      {parts.map((part, i) => {
        const p = '/' + parts.slice(0, i + 1).join('/')
        const isLast = i === parts.length - 1
        return (
          <span key={i} className="flex items-center gap-1 shrink-0">
            <span className="text-gray-700">/</span>
            <button
              onClick={() => !isLast && onNavigate(p)}
              className={isLast ? 'text-white cursor-default' : 'text-blue-400 hover:text-blue-300'}
            >
              {part}
            </button>
          </span>
        )
      })}
    </div>
  )
}

// ─── Content viewer ───────────────────────────────────────────────────────────
function ContentViewer({ file, onClose, onEdit }: {
  file: FileReadResult
  onClose: () => void
  onEdit: (content: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(file.content)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  const save = async () => {
    setSaving(true)
    try {
      await api.fileWrite(file.path, draft)
      setSaveMsg('Saved')
      onEdit(draft)
      setTimeout(() => setSaveMsg(''), 2000)
      setEditing(false)
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : 'Save failed')
    } finally { setSaving(false) }
  }

  const lineCount = (editing ? draft : file.content).split('\n').length

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 shrink-0 flex-wrap">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">{file.name}</p>
          <p className="text-xs text-gray-600 font-mono">{file.path}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-600">{fmtSize(file.size)}</span>
          <span className="text-xs text-gray-700 font-mono">{file.mode}</span>
          {!file.is_binary && !editing && (
            <button onClick={() => setEditing(true)}
              className="text-xs px-2.5 py-1 rounded border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 transition-colors">
              Edit
            </button>
          )}
          {editing && (
            <>
              {saveMsg && <span className="text-xs text-green-400">{saveMsg}</span>}
              <button onClick={() => { setEditing(false); setDraft(file.content) }}
                className="btn-ghost text-xs">Cancel</button>
              <button onClick={save} disabled={saving} className="btn-primary text-xs">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
          <a href={api.fileDownloadUrl(file.path)} download={file.name}
            className="text-xs px-2.5 py-1 rounded border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 transition-colors">
            ↓ Download
          </a>
          <button onClick={onClose} className="text-gray-500 hover:text-white ml-1">×</button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {file.is_binary ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-500">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-10 h-10 opacity-40">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <p className="text-sm">Binary file — {fmtSize(file.size)}</p>
            <a href={api.fileDownloadUrl(file.path)} download={file.name} className="btn-primary text-xs">
              ↓ Download
            </a>
          </div>
        ) : isImageMime(file.mime) ? (
          <div className="flex items-center justify-center h-full p-4">
            <img src={api.fileDownloadUrl(file.path)} alt={file.name}
              className="max-w-full max-h-full object-contain rounded" />
          </div>
        ) : editing ? (
          <textarea
            className="w-full h-full resize-none font-mono text-xs text-gray-200 bg-gray-950 p-4 focus:outline-none leading-relaxed"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        ) : (
          <div className="h-full overflow-auto">
            <div className="flex min-h-full">
              {/* Line numbers */}
              <div className="select-none text-right pr-3 pt-4 pb-4 pl-3 font-mono text-xs text-gray-700 bg-gray-950/60 border-r border-gray-800/50 shrink-0 leading-relaxed"
                style={{ minWidth: `${String(lineCount).length * 8 + 24}px` }}>
                {file.content.split('\n').map((_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
              {/* Code */}
              <pre className="flex-1 p-4 font-mono text-xs text-gray-200 leading-relaxed bg-gray-950 overflow-x-auto whitespace-pre">
                {file.content}
              </pre>
            </div>
          </div>
        )}
      </div>

      {/* Footer bar */}
      {!file.is_binary && (
        <div className="px-4 py-1.5 border-t border-gray-800 shrink-0 flex items-center gap-4 text-xs text-gray-600">
          <span>{lineCount} lines</span>
          <span>{fmtSize(file.size)}</span>
          <span className="font-mono">{langFromMime(file.mime)}</span>
          <span>{fmtDate(file.mod_time)}</span>
          {file.truncated && <span className="text-yellow-400">⚠ File truncated — download for full content</span>}
        </div>
      )}
    </div>
  )
}

// ─── Quick paths sidebar ──────────────────────────────────────────────────────
const QUICK_PATHS = [
  { label: 'Root', path: '/', icon: '/' },
  { label: 'Home', path: '/root', icon: '~' },
  { label: 'OffDock data', path: '/var/offdock', icon: '⬡' },
  { label: 'OffDock config', path: '/etc/offdock', icon: '⚙' },
  { label: 'Nginx', path: '/etc/nginx', icon: '⇄' },
  { label: 'System logs', path: '/var/log', icon: '▤' },
  { label: 'Docker', path: '/var/lib/docker', icon: '◈' },
  { label: 'Temp', path: '/tmp', icon: '∅' },
  { label: 'etc', path: '/etc', icon: '⊙' },
  { label: 'var', path: '/var', icon: '∷' },
]

// ─── New file / dir modal ─────────────────────────────────────────────────────
function NewItemModal({ basePath, onClose, onCreated }: {
  basePath: string; onClose: () => void; onCreated: () => void
}) {
  const [type, setType] = useState<'file' | 'dir'>('file')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const create = async () => {
    if (!name.trim()) return
    setBusy(true); setErr('')
    const path = basePath.replace(/\/$/, '') + '/' + name.trim()
    try {
      if (type === 'dir') {
        await api.fileMkdir(path)
      } else {
        await api.fileWrite(path, '')
      }
      onCreated(); onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm p-5 shadow-2xl">
        <h3 className="text-sm font-semibold text-white mb-4">New {type === 'dir' ? 'Directory' : 'File'}</h3>
        <div className="flex gap-2 mb-3">
          {(['file', 'dir'] as const).map(t => (
            <button key={t} onClick={() => setType(t)}
              className={`flex-1 py-1.5 text-xs rounded-lg border transition-colors ${
                type === t ? 'bg-blue-600/20 text-blue-300 border-blue-700/50' : 'text-gray-500 border-gray-700 hover:border-gray-600'
              }`}>
              {t === 'dir' ? 'Directory' : 'File'}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-600 font-mono mb-2">{basePath}/</p>
        <input ref={inputRef} className="input w-full text-sm font-mono mb-3"
          placeholder={type === 'dir' ? 'dirname' : 'filename.txt'}
          value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && create()} />
        {err && <p className="text-xs text-red-400 mb-2">{err}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn-ghost text-xs">Cancel</button>
          <button onClick={create} disabled={busy || !name.trim()} className="btn-primary text-xs">
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Delete confirm ───────────────────────────────────────────────────────────
function DeleteModal({ entry, onClose, onDeleted }: {
  entry: FileEntry; onClose: () => void; onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const doDelete = async () => {
    setBusy(true)
    try {
      await api.fileDelete(entry.path)
      onDeleted(); onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-red-900/50 rounded-xl w-full max-w-sm p-5 shadow-2xl">
        <h3 className="text-sm font-semibold text-white mb-2">Delete {entry.is_dir ? 'Directory' : 'File'}?</h3>
        <p className="text-xs text-gray-400 mb-4 font-mono break-all">{entry.path}</p>
        {entry.is_dir && <p className="text-xs text-yellow-400 mb-4">⚠ All contents will be permanently removed.</p>}
        {err && <p className="text-xs text-red-400 mb-2">{err}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn-ghost text-xs">Cancel</button>
          <button onClick={doDelete} disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium transition-colors disabled:opacity-50">
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Rename modal ─────────────────────────────────────────────────────────────
function RenameModal({ entry, onClose, onRenamed }: {
  entry: FileEntry; onClose: () => void; onRenamed: () => void
}) {
  const [name, setName] = useState(entry.name)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.select() }, [])

  const doRename = async () => {
    const newPath = parentPath(entry.path) + '/' + name.trim()
    if (newPath === entry.path) { onClose(); return }
    setBusy(true)
    try {
      await api.fileRename(entry.path, newPath)
      onRenamed(); onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm p-5 shadow-2xl">
        <h3 className="text-sm font-semibold text-white mb-3">Rename</h3>
        <input ref={inputRef} className="input w-full text-sm font-mono mb-3"
          value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && doRename()} />
        {err && <p className="text-xs text-red-400 mb-2">{err}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn-ghost text-xs">Cancel</button>
          <button onClick={doRename} disabled={busy || !name.trim()} className="btn-primary text-xs">
            {busy ? 'Renaming…' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function FilesPage() {
  const [cwd, setCwd] = useState('/var/offdock')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openFile, setOpenFile] = useState<FileReadResult | null>(null)
  const [loadingFile, setLoadingFile] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [deleteEntry, setDeleteEntry] = useState<FileEntry | null>(null)
  const [renameEntry, setRenameEntry] = useState<FileEntry | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [editingPath, setEditingPath] = useState(false)
  const pathInputRef = useRef<HTMLInputElement>(null)

  const browse = useCallback(async (path: string) => {
    setLoading(true); setError(''); setSearchResults(null); setSelected(new Set())
    setCwd(path); setPathInput(path)
    try {
      const items = await api.fileBrowse(path)
      setEntries(items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to browse')
      setEntries([])
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { browse(cwd) }, [])

  const openEntry = async (entry: FileEntry) => {
    if (entry.is_dir) { browse(entry.path); return }
    setLoadingFile(entry.path)
    try {
      const result = await api.fileRead(entry.path)
      setOpenFile(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to read file')
    } finally { setLoadingFile('') }
  }

  const search = async () => {
    if (!searchQuery.trim()) { setSearchResults(null); return }
    setSearching(true)
    try {
      const results = await api.fileSearch(cwd, searchQuery.trim())
      setSearchResults(results ?? [])
    } catch (e) { setError(e instanceof Error ? e.message : 'Search failed') }
    finally { setSearching(false) }
  }

  const toggleSelect = (path: string) => {
    setSelected(s => {
      const n = new Set(s)
      if (n.has(path)) n.delete(path); else n.add(path)
      return n
    })
  }

  const displayEntries = searchResults ?? entries

  return (
    <div className="flex h-full overflow-hidden">
      {/* Modals */}
      {showNew && <NewItemModal basePath={cwd} onClose={() => setShowNew(false)} onCreated={() => browse(cwd)} />}
      {deleteEntry && <DeleteModal entry={deleteEntry} onClose={() => setDeleteEntry(null)} onDeleted={() => { browse(cwd); if (openFile?.path === deleteEntry.path) setOpenFile(null) }} />}
      {renameEntry && <RenameModal entry={renameEntry} onClose={() => setRenameEntry(null)} onRenamed={() => browse(cwd)} />}

      {/* Sidebar */}
      <aside className="w-44 bg-gray-900/60 border-r border-gray-800 flex flex-col shrink-0">
        <div className="px-3 py-3 border-b border-gray-800">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Quick Access</p>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {QUICK_PATHS.map(q => (
            <button key={q.path} onClick={() => browse(q.path)}
              className={clsx(
                'w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors text-left',
                cwd === q.path
                  ? 'text-blue-400 bg-blue-950/30'
                  : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800/50'
              )}>
              <span className="font-mono text-[10px] w-3 text-center shrink-0">{q.icon}</span>
              {q.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main area */}
      <div className={clsx('flex-1 flex overflow-hidden', openFile ? 'flex-row' : 'flex-col')}>
        {/* File browser panel */}
        <div className={clsx('flex flex-col overflow-hidden', openFile ? 'w-80 shrink-0 border-r border-gray-800' : 'flex-1')}>
          {/* Toolbar */}
          <div className="px-4 py-2.5 border-b border-gray-800 shrink-0 space-y-2">
            {/* Path bar */}
            <div className="flex items-center gap-2">
              <button onClick={() => browse(parentPath(cwd))} disabled={cwd === '/'}
                className="text-gray-500 hover:text-gray-200 disabled:opacity-30 text-sm px-1" title="Up">↑</button>
              {editingPath ? (
                <input
                  ref={pathInputRef}
                  className="flex-1 input font-mono text-xs py-1"
                  value={pathInput}
                  onChange={e => setPathInput(e.target.value)}
                  onBlur={() => setEditingPath(false)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { browse(pathInput); setEditingPath(false) }
                    if (e.key === 'Escape') setEditingPath(false)
                  }}
                  autoFocus
                />
              ) : (
                <div className="flex-1 cursor-text" onClick={() => { setEditingPath(true); setPathInput(cwd) }}>
                  <Breadcrumb path={cwd} onNavigate={browse} />
                </div>
              )}
              <button onClick={() => browse(cwd)} className="text-gray-600 hover:text-gray-300 text-sm px-1" title="Refresh">↻</button>
            </div>

            {/* Search + actions */}
            <div className="flex items-center gap-1.5">
              <div className="flex-1 flex items-center gap-1">
                <div className="relative flex-1">
                  <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-600" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd"/>
                  </svg>
                  <input className="input pl-7 text-xs w-full py-1.5"
                    placeholder="Search in folder…"
                    value={searchQuery}
                    onChange={e => { setSearchQuery(e.target.value); if (!e.target.value) setSearchResults(null) }}
                    onKeyDown={e => e.key === 'Enter' && search()} />
                </div>
                {searchResults && (
                  <button onClick={() => { setSearchResults(null); setSearchQuery('') }}
                    className="text-xs text-gray-500 hover:text-gray-300 px-1">✕</button>
                )}
              </div>
              <button onClick={() => setShowNew(true)}
                className="text-xs px-2 py-1.5 rounded border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 transition-colors shrink-0"
                title="New file or directory">
                + New
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="px-4 py-2 bg-red-950/30 border-b border-red-900/30 text-xs text-red-400">
              {error}
              <button onClick={() => setError('')} className="ml-2 opacity-60 hover:opacity-100">✕</button>
            </div>
          )}

          {/* Search result header */}
          {searchResults && (
            <div className="px-4 py-1.5 bg-blue-950/20 border-b border-blue-900/20 text-xs text-blue-400">
              {searching ? 'Searching…' : `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''} for "${searchQuery}"`}
            </div>
          )}

          {/* File list */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-16 text-gray-600 text-sm">
                <div className="w-5 h-5 border-2 border-gray-700 border-t-blue-400 rounded-full animate-spin mr-3" />
                Loading…
              </div>
            ) : displayEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-600 text-sm">
                <p>{searchResults ? 'No matches' : 'Empty directory'}</p>
              </div>
            ) : (
              <table className="w-full text-xs">
                <colgroup>
                  <col className="w-6" />
                  <col />
                  <col className="w-20" />
                  <col className={clsx('w-20', openFile && 'hidden')} />
                  <col className={clsx('w-16', openFile && 'hidden')} />
                </colgroup>
                <thead className="sticky top-0 bg-gray-900 z-10">
                  <tr className="border-b border-gray-800 text-gray-600">
                    <th className="px-2 py-2 text-left">
                      <input type="checkbox"
                        className="rounded border-gray-700 bg-gray-800 cursor-pointer"
                        checked={selected.size > 0 && selected.size === displayEntries.length}
                        onChange={() => {
                          if (selected.size === displayEntries.length) setSelected(new Set())
                          else setSelected(new Set(displayEntries.map(e => e.path)))
                        }}
                      />
                    </th>
                    <th className="px-2 py-2 text-left font-medium">Name</th>
                    <th className="px-2 py-2 text-right font-medium">Size</th>
                    {!openFile && (
                      <>
                        <th className="px-2 py-2 text-left font-medium">Modified</th>
                        <th className="px-2 py-2 text-left font-medium">Mode</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {!searchResults && cwd !== '/' && (
                    <tr className="border-b border-gray-800/30 hover:bg-gray-800/20 cursor-pointer"
                      onClick={() => browse(parentPath(cwd))}>
                      <td className="px-2 py-1.5" />
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-gray-600 shrink-0">
                            <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
                          </svg>
                          <span className="text-gray-600 font-mono">..</span>
                        </div>
                      </td>
                      <td colSpan={openFile ? 1 : 3} />
                    </tr>
                  )}
                  {displayEntries.map(entry => {
                    const isOpen = openFile?.path === entry.path
                    const isSel = selected.has(entry.path)
                    const busy = loadingFile === entry.path
                    return (
                      <tr key={entry.path}
                        className={clsx(
                          'border-b border-gray-800/30 cursor-pointer transition-colors group',
                          isOpen ? 'bg-blue-950/30' : isSel ? 'bg-blue-950/10' : 'hover:bg-gray-800/20'
                        )}
                        onClick={() => openEntry(entry)}
                      >
                        <td className="px-2 py-1.5" onClick={e => { e.stopPropagation(); toggleSelect(entry.path) }}>
                          <input type="checkbox"
                            className="rounded border-gray-700 bg-gray-800 cursor-pointer"
                            checked={isSel} onChange={() => {}} />
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-2 min-w-0">
                            {busy ? (
                              <div className="w-4 h-4 border border-gray-600 border-t-blue-400 rounded-full animate-spin shrink-0" />
                            ) : (
                              <FileIcon entry={entry} />
                            )}
                            <span className={clsx(
                              'font-mono truncate',
                              entry.is_dir ? 'text-blue-300' : 'text-gray-300',
                              entry.is_symlink && 'italic opacity-80'
                            )}>
                              {entry.name}{entry.is_dir ? '/' : ''}
                            </span>
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-right text-gray-600 tabular-nums">
                          {entry.is_dir ? '—' : fmtSize(entry.size)}
                        </td>
                        {!openFile && (
                          <>
                            <td className="px-2 py-1.5 text-gray-700 tabular-nums">{fmtDate(entry.mod_time)}</td>
                            <td className="px-2 py-1.5">
                              <div className="flex items-center gap-1.5">
                                <span className="text-gray-700 font-mono text-[10px]">{entry.mode?.slice(0, 4)}</span>
                                {/* Context actions — show on hover */}
                                <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 ml-auto transition-opacity">
                                  <button
                                    onClick={e => { e.stopPropagation(); setRenameEntry(entry) }}
                                    className="text-gray-500 hover:text-gray-200 px-1 text-xs" title="Rename">✎</button>
                                  <a
                                    href={api.fileDownloadUrl(entry.path)} download={entry.name}
                                    onClick={e => e.stopPropagation()}
                                    className="text-gray-500 hover:text-gray-200 px-1 text-xs" title="Download">↓</a>
                                  <button
                                    onClick={e => { e.stopPropagation(); setDeleteEntry(entry) }}
                                    className="text-gray-600 hover:text-red-400 px-1 text-xs" title="Delete">✕</button>
                                </div>
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Status bar */}
          <div className="px-4 py-1.5 border-t border-gray-800 shrink-0 flex items-center justify-between text-xs text-gray-700">
            <span>
              {displayEntries.length} item{displayEntries.length !== 1 ? 's' : ''}
              {selected.size > 0 && ` · ${selected.size} selected`}
            </span>
            {selected.size > 0 && (
              <button onClick={() => {
                if (window.confirm(`Delete ${selected.size} item(s)?`)) {
                  Promise.all([...selected].map(p => api.fileDelete(p)))
                    .finally(() => { setSelected(new Set()); browse(cwd) })
                }
              }} className="text-red-500 hover:text-red-400 transition-colors">
                Delete selected
              </button>
            )}
          </div>
        </div>

        {/* Content viewer panel */}
        {openFile && (
          <div className="flex-1 min-w-0 overflow-hidden flex flex-col bg-gray-950">
            <ContentViewer
              file={openFile}
              onClose={() => setOpenFile(null)}
              onEdit={content => setOpenFile(prev => prev ? { ...prev, content } : prev)}
            />
          </div>
        )}
      </div>
    </div>
  )
}
