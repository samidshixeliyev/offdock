import { useEffect, useRef, useState } from 'react'
import { api, DockerImage, DiskUsageRow } from '../api/client'
import ConfirmModal from '../components/ConfirmModal'
import { Page, PageHeader, Panel, EmptyState, IconButton } from '../components/ui'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { formatBytes, formatDateTime } from '../lib/format'
import clsx from 'clsx'
import {
  Boxes, Upload, RefreshCw, RotateCw, Trash2, FileArchive, HardDriveUpload,
  Loader2, CheckCircle2,
} from 'lucide-react'
import { usePermissions, PERMS } from '../hooks/usePermissions'
import { ReadOnlyBanner } from '../components/ReadOnlyBanner'

type UploadTab = 'computer' | 'server'

// ─── Upload + load modal ────────────────────────────────────────────────────
function UploadModal({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const toast = useToast()
  const [tab, setTab] = useState<UploadTab>('computer')
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'loading' | 'done'>('idle')
  const [serverPath, setServerPath] = useState('/var/offdock/uploads/')
  const fileRef = useRef<HTMLInputElement>(null)

  const loadIntoDocker = async (path: string, label: string) => {
    setPhase('loading')
    const res = await api.loadImage({ tar_file_path: path })
    setPhase('done')
    const n = res.images?.length ?? 0
    toast.success(n > 0 ? `Loaded ${n} image${n !== 1 ? 's' : ''} from ${label}` : `Loaded ${label} (no new images — already present)`)
    onDone()
  }

  const uploadFromComputer = async () => {
    if (!file) return
    try {
      setPhase('uploading'); setProgress(0)
      const up = await api.uploadFile(file, (_l, _t, pct) => setProgress(pct))
      toast.info(`Uploaded ${up.name} (${formatBytes(up.size)})`)
      await loadIntoDocker(up.path, up.name)
    } catch (e) {
      setPhase('idle')
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    }
  }

  const loadFromServer = async () => {
    if (!serverPath.trim().endsWith('.tar')) { toast.error('Path must point to a .tar file'); return }
    try { await loadIntoDocker(serverPath.trim(), serverPath.split('/').pop() || serverPath) }
    catch (e) { setPhase('idle'); toast.error(e instanceof Error ? e.message : 'Load failed') }
  }

  const busy = phase === 'uploading' || phase === 'loading'

  return (
    <Modal open onClose={busy ? () => {} : onClose} size="md" icon={HardDriveUpload} title="Add Docker Image"
      subtitle="Upload a .tar from your computer or load one already on the server"
      footer={
        tab === 'computer'
          ? <><button onClick={onClose} disabled={busy} className="btn-secondary">Cancel</button>
              <button onClick={uploadFromComputer} disabled={!file || busy} className="btn-primary">
                {phase === 'uploading' ? <><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</> : phase === 'loading' ? <><Loader2 className="w-4 h-4 animate-spin" /> Loading…</> : <><Upload className="w-4 h-4" /> Upload & Load</>}
              </button></>
          : <><button onClick={onClose} disabled={busy} className="btn-secondary">Cancel</button>
              <button onClick={loadFromServer} disabled={busy} className="btn-primary">
                {phase === 'loading' ? <><Loader2 className="w-4 h-4 animate-spin" /> Loading…</> : <><HardDriveUpload className="w-4 h-4" /> Load into Docker</>}
              </button></>
      }>
      <div className="space-y-4">
        <div className="flex items-center gap-1 p-1 bg-slate-800 rounded-lg w-fit">
          {([['computer', 'From computer'], ['server', 'From server path']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} disabled={busy}
              className={clsx('px-3 py-1.5 rounded-md text-sm font-medium transition-all', tab === id ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200')}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'computer' ? (
          <div className="space-y-3">
            <button onClick={() => fileRef.current?.click()} disabled={busy}
              className="w-full border-2 border-dashed border-slate-700 hover:border-slate-600 rounded-xl py-8 flex flex-col items-center gap-2 transition-colors">
              <FileArchive className="w-8 h-8 text-slate-500" />
              {file ? (
                <div className="text-center">
                  <p className="text-sm text-slate-200 font-medium">{file.name}</p>
                  <p className="text-xs text-slate-500">{formatBytes(file.size)}</p>
                </div>
              ) : (
                <div className="text-center">
                  <p className="text-sm text-slate-300">Click to choose a <span className="font-mono">.tar</span> image</p>
                  <p className="text-xs text-slate-500">Streamed to the server, then <code>docker load</code></p>
                </div>
              )}
            </button>
            <input ref={fileRef} type="file" accept=".tar" className="hidden" onChange={e => { setFile(e.target.files?.[0] ?? null); setPhase('idle') }} />

            {phase === 'uploading' && (
              <div>
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1"><span>Uploading…</span><span className="tabular-nums">{progress}%</span></div>
                <div className="h-2 bg-slate-800 rounded-full overflow-hidden"><div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${progress}%` }} /></div>
              </div>
            )}
            {phase === 'loading' && <p className="text-xs text-amber-400 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running docker load…</p>}
            {phase === 'done' && <p className="text-xs text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> Done</p>}
          </div>
        ) : (
          <div className="space-y-2">
            <label className="block text-xs text-slate-500">Absolute path to a .tar on the server</label>
            <input className="input font-mono text-xs" value={serverPath} onChange={e => setServerPath(e.target.value)} placeholder="/var/offdock/uploads/myimage.tar" />
            <p className="text-xs text-slate-600">Runs <code>docker load -i &lt;path&gt;</code> and registers any new images.</p>
          </div>
        )}
      </div>
    </Modal>
  )
}

export default function ImagesPage() {
  const toast = useToast()
  const { can } = usePermissions()
  const [images, setImages] = useState<DockerImage[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [pruning, setPruning] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<DockerImage | null>(null)
  const [diskRows, setDiskRows] = useState<DiskUsageRow[]>([])

  const reload = () => api.listImages().then(d => setImages(d ?? [])).catch(() => {}).finally(() => setLoading(false))
  useEffect(() => {
    reload()
    api.getSystemDf().then(d => setDiskRows(d.rows ?? [])).catch(() => {})
  }, [])

  const handleSync = async () => {
    setSyncing(true)
    try { const res = await api.syncImages(); toast.success(`Synced ${res.synced} new image${res.synced !== 1 ? 's' : ''} from Docker`); reload() }
    catch (e) { toast.error('Sync failed: ' + (e instanceof Error ? e.message : 'unknown')) } finally { setSyncing(false) }
  }
  const handlePrune = async (all: boolean) => {
    setPruning(true)
    try {
      const res = await api.pruneImages(all)
      toast.success(`Pruned. ${res.output || 'No space reclaimed.'}`)
      reload()
      api.getSystemDf().then(d => setDiskRows(d.rows ?? [])).catch(() => {})
    }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Prune failed') } finally { setPruning(false) }
  }
  const handleDelete = async (img: DockerImage) => {
    try { await api.deleteImage(img.id); toast.success('Image deleted'); reload() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed') } finally { setConfirmDelete(null) }
  }

  return (
    <Page>
      {!can(PERMS.manageImages) && <ReadOnlyBanner message="You don't have permission to manage images. Viewing in read-only mode." />}
      <PageHeader title="Images" subtitle={`${images.length} tracked image${images.length !== 1 ? 's' : ''}`} icon={Boxes}
        actions={<>
          {can(PERMS.manageImages) && <button onClick={() => handlePrune(false)} disabled={pruning} title="Remove dangling (unused) images" className="btn-secondary">
            {pruning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Prune
          </button>}
          <button onClick={handleSync} disabled={syncing} className="btn-secondary">
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />} Sync from Docker
          </button>
          {can(PERMS.manageImages) && <button onClick={() => setShowUpload(true)} className="btn-primary"><Upload className="w-4 h-4" /> Add Image (.tar)</button>}
        </>} />

      {/* Docker disk usage summary */}
      {diskRows.length > 0 && (
        <div className="mx-4 mb-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {diskRows.map(row => (
            <div key={row.type} className="bg-slate-900/60 border border-slate-800 rounded-lg p-3">
              <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">{row.type}</div>
              <div className="text-sm font-semibold text-slate-200">{row.size}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">{row.total} total · {row.reclaimable && <span className="text-amber-400/80">{row.reclaimable} reclaimable</span>}</div>
            </div>
          ))}
        </div>
      )}

      {showUpload && <UploadModal onDone={reload} onClose={() => setShowUpload(false)} />}
      {confirmDelete && (
        <ConfirmModal title="Delete image?" danger confirmLabel="Delete"
          message={`Remove ${confirmDelete.image_name}:${confirmDelete.image_tag} from Docker and the registry?`}
          onConfirm={() => handleDelete(confirmDelete)} onCancel={() => setConfirmDelete(null)} />
      )}

      <Panel title="Docker Images" icon={Boxes} actions={<button onClick={reload} className="text-slate-400 hover:text-slate-200"><RefreshCw className="w-4 h-4" /></button>}>
        {loading ? (
          <div className="p-4 space-y-2">{[0,1,2].map(i => <div key={i} className="h-12 skeleton rounded-lg" />)}</div>
        ) : images.length === 0 ? (
          <EmptyState icon={FileArchive} title="No images tracked"
            description="Upload a .tar image from your computer, or sync images already loaded on the host."
            action={<div className="flex gap-2">
              <button onClick={() => setShowUpload(true)} className="btn-primary"><Upload className="w-4 h-4" /> Add Image</button>
              <button onClick={handleSync} className="btn-secondary"><RotateCw className="w-4 h-4" /> Sync from Docker</button>
            </div>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px]">
              <thead><tr className="border-b border-slate-800">
                <th className="th text-left">Image</th><th className="th text-left">Tag</th>
                <th className="th text-left">Docker ID</th><th className="th text-left">Size</th>
                <th className="th text-left">Loaded</th><th className="th text-right"></th>
              </tr></thead>
              <tbody>
                {images.map(img => (
                  <tr key={img.id} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30">
                    <td className="px-4 py-3 font-mono text-xs text-slate-200">{img.image_name}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">{img.image_tag}</td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-500">{(img.docker_image_id ?? '').replace('sha256:', '').slice(0, 12)}</td>
                    <td className="px-4 py-3 text-xs text-slate-400 tabular-nums">{img.size_bytes ? formatBytes(img.size_bytes) : '—'}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{formatDateTime(img.loaded_at)}</td>
                    <td className="px-4 py-3 text-right"><IconButton icon={Trash2} tone="danger" title={can(PERMS.manageImages) ? "Delete" : "Delete (no permission)"} disabled={!can(PERMS.manageImages)} onClick={() => can(PERMS.manageImages) && setConfirmDelete(img)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </Page>
  )
}
