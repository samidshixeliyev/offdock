import { useEffect, useRef, useState } from 'react'
import { api, FileEntry, StorageRoot } from '../api/client'
import clsx from 'clsx'
import {
  Database, FolderOpen, Folder, File as FileIcon, Download, Trash2, Upload,
  FolderPlus, RefreshCw, ChevronRight, HardDrive, ArrowLeft,
} from 'lucide-react'
import { useToast } from '../components/Toast'
import ConfirmModal from '../components/ConfirmModal'

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(n) / Math.log(1024))
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`
}

const ROOT_ICON: Record<string, typeof Database> = {
  backups: HardDrive, data: Database, projects: FolderOpen, images: HardDrive,
  certs: FileIcon, otel: FolderOpen, logs: FileIcon, config: FileIcon,
}

export default function StoragePage() {
  const toast = useToast()
  const [roots, setRoots] = useState<StorageRoot[]>([])
  const [cwd, setCwd] = useState<string>('')      // '' = overview
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [confirm, setConfirm] = useState<FileEntry | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const loadRoots = () => api.storageOverview().then(r => setRoots(r.roots ?? [])).catch(() => {})
  useEffect(() => { loadRoots() }, [])

  const browse = (path: string) => {
    setLoading(true)
    setCwd(path)
    api.fileBrowse(path)
      .then(e => setEntries((e ?? []).slice().sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1))))
      .catch(err => { toast.error(err instanceof Error ? err.message : 'Cannot open'); setEntries([]) })
      .finally(() => setLoading(false))
  }

  const parent = () => {
    const i = cwd.replace(/\/+$/, '').lastIndexOf('/')
    if (i <= 0) { setCwd(''); return }
    browse(cwd.slice(0, i))
  }

  const del = async (e: FileEntry) => {
    try {
      await api.fileDelete(e.path)
      toast.success(`Deleted ${e.name}`)
      browse(cwd)
      loadRoots()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Delete failed') }
    setConfirm(null)
  }

  const upload = async (f: File) => {
    try {
      const up = await api.uploadFile(f)
      // Move from the uploads staging area into the current directory.
      const dest = cwd.replace(/\/+$/, '') + '/' + f.name
      if (up.path !== dest) await api.fileImport(up.path, dest, 'move')
      toast.success(`Uploaded ${f.name}`)
      browse(cwd)
      loadRoots()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Upload failed') }
  }

  const mkdir = async () => {
    const name = window.prompt('New folder name')?.trim()
    if (!name) return
    try {
      await api.fileMkdir(cwd.replace(/\/+$/, '') + '/' + name)
      browse(cwd)
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not create folder') }
  }

  // ── Overview ──────────────────────────────────────────────────────────────
  if (!cwd) {
    const total = roots.reduce((s, r) => s + r.size, 0)
    return (
      <div className="p-6 max-w-5xl space-y-6 animate-fadeIn">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">Storage</h1>
            <p className="text-sm text-slate-500 mt-1">Browse, download, upload and clean up all OffDock data · {fmtBytes(total)} total</p>
          </div>
          <button onClick={loadRoots} className="btn-secondary text-sm gap-1.5"><RefreshCw className="w-4 h-4" /> Refresh</button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {roots.map(r => {
            const Icon = ROOT_ICON[r.key] ?? Folder
            return (
              <button
                key={r.key}
                onClick={() => r.exists && browse(r.path)}
                disabled={!r.exists}
                className={clsx('card text-left transition-all', r.exists ? 'hover:border-blue-500/40 cursor-pointer' : 'opacity-50 cursor-not-allowed')}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center"><Icon className="w-5 h-5 text-blue-400" /></div>
                  <div>
                    <div className="text-sm font-semibold text-slate-100">{r.label}</div>
                    <div className="text-[11px] text-slate-500 font-mono">{r.path}</div>
                  </div>
                </div>
                <p className="text-xs text-slate-500">{r.desc}</p>
                <div className="flex items-center gap-3 mt-3 text-xs">
                  <span className="text-slate-300 font-semibold">{r.exists ? fmtBytes(r.size) : 'missing'}</span>
                  {r.exists && <span className="text-slate-600">{r.files} file{r.files !== 1 ? 's' : ''}</span>}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // ── Browser ───────────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-5xl space-y-4 animate-fadeIn">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={parent} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"><ArrowLeft className="w-4 h-4" /></button>
          <button onClick={() => setCwd('')} className="text-sm text-slate-500 hover:text-slate-300">Storage</button>
          <ChevronRight className="w-3.5 h-3.5 text-slate-700 shrink-0" />
          <span className="text-sm font-mono text-slate-200 truncate">{cwd}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={mkdir} className="btn-secondary text-xs gap-1.5"><FolderPlus className="w-3.5 h-3.5" /> New folder</button>
          <button onClick={() => fileInput.current?.click()} className="btn-secondary text-xs gap-1.5"><Upload className="w-3.5 h-3.5" /> Upload</button>
          <button onClick={() => browse(cwd)} className="btn-secondary text-xs gap-1.5"><RefreshCw className="w-3.5 h-3.5" /></button>
          <input ref={fileInput} type="file" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }} />
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-600 text-sm flex items-center justify-center gap-2"><RefreshCw className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-slate-600 text-sm">Empty directory</div>
        ) : (
          <div className="divide-y divide-slate-800/50">
            {entries.map(e => (
              <div key={e.path} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-800/30 group">
                {e.is_dir
                  ? <Folder className="w-4 h-4 text-blue-400 shrink-0" />
                  : <FileIcon className="w-4 h-4 text-slate-500 shrink-0" />}
                <button
                  onClick={() => e.is_dir && browse(e.path)}
                  className={clsx('flex-1 min-w-0 text-left text-sm truncate', e.is_dir ? 'text-slate-200 hover:text-blue-400' : 'text-slate-300 cursor-default')}
                >
                  {e.name}
                </button>
                <span className="text-[11px] text-slate-600 tabular-nums shrink-0 w-20 text-right">{e.is_dir ? '' : fmtBytes(e.size)}</span>
                <span className="text-[11px] text-slate-700 shrink-0 hidden sm:block w-36 text-right">{new Date(e.mod_time).toLocaleString()}</span>
                <div className="flex items-center gap-1 shrink-0 w-16 justify-end">
                  {!e.is_dir && (
                    <a href={api.fileDownloadUrl(e.path)} title="Download" className="p-1.5 rounded-lg text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 opacity-0 group-hover:opacity-100">
                      <Download className="w-3.5 h-3.5" />
                    </a>
                  )}
                  <button onClick={() => setConfirm(e)} title="Delete" className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {confirm && (
        <ConfirmModal
          title={`Delete ${confirm.is_dir ? 'folder' : 'file'}?`}
          message={`Permanently delete "${confirm.name}"${confirm.is_dir ? ' and everything inside it' : ''}? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => del(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
