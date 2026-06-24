import { useEffect, useRef, useState } from 'react'
import { api, DiskUsageRow, ImageUsage } from '../api/client'
import { Page, PageHeader, Panel, EmptyState } from '../components/ui'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { formatBytes } from '../lib/format'
import clsx from 'clsx'
import {
  Boxes, Upload, RefreshCw, RotateCw, Trash2, FileArchive, HardDriveUpload,
  Loader2, CheckCircle2, AlertTriangle, Link2,
} from 'lucide-react'
import { usePermissions, PERMS } from '../hooks/usePermissions'
import { ReadOnlyBanner } from '../components/ReadOnlyBanner'

type UploadTab = 'computer' | 'server'

// docker load auto-detects gzip/bzip2/xz, so accept any compressed tar archive.
const IMAGE_ARCHIVE_SUFFIXES = ['.tar', '.tar.gz', '.tgz', '.gz', '.tar.bz2', '.tbz', '.tbz2', '.tar.xz', '.txz']
function isImageArchive(name: string): boolean {
  const n = name.trim().toLowerCase()
  return IMAGE_ARCHIVE_SUFFIXES.some(s => n.endsWith(s))
}

// ─── Type-to-confirm delete modal (GitHub-style) ─────────────────────────────
function DeleteImageModal({ image, onDone, onClose }: { image: ImageUsage; onDone: () => void; onClose: () => void }) {
  const toast = useToast()
  const ref = `${image.repository}:${image.tag}`
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [force, setForce] = useState(false)
  const matches = typed.trim() === ref

  const del = async () => {
    if (!matches) return
    setBusy(true)
    try {
      await api.removeImageByRef({ ref, image_id: image.image_id, force: image.in_use ? force : false })
      toast.success(`Deleted ${ref}`)
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={busy ? () => {} : onClose} size="md" icon={Trash2} title="Delete image"
      subtitle="This permanently removes the image from Docker."
      footer={<>
        <button onClick={onClose} disabled={busy} className="btn-secondary">Cancel</button>
        <button onClick={del} disabled={!matches || busy || (image.in_use && !force)} className="btn-danger">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Delete image
        </button>
      </>}>
      <div className="space-y-4">
        {image.in_use && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">This image is in use by {image.used_by.length} container{image.used_by.length !== 1 ? 's' : ''}.</p>
              <p className="mt-0.5 text-amber-300/80 font-mono">{image.used_by.join(', ')}</p>
              <label className="mt-2 flex items-center gap-2 text-amber-200 cursor-pointer">
                <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} />
                Force delete anyway (may break those containers)
              </label>
            </div>
          </div>
        )}
        <p className="text-sm text-slate-400">
          Type <code className="px-1 py-0.5 rounded bg-slate-800 text-slate-200 font-mono">{ref}</code> to confirm.
        </p>
        <input autoFocus className="input font-mono text-sm" value={typed} placeholder={ref}
          onChange={e => setTyped(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') del() }} />
      </div>
    </Modal>
  )
}

// ─── Upload + load modal ────────────────────────────────────────────────────
function UploadModal({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const toast = useToast()
  const [tab, setTab] = useState<UploadTab>('computer')
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'loading' | 'done'>('idle')
  const [serverPath, setServerPath] = useState('/var/offdock/uploads/')
  const [customName, setCustomName] = useState('')
  const [customTag, setCustomTag] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const loadIntoDocker = async (path: string, label: string) => {
    setPhase('loading')
    const res = await api.loadImage({
      tar_file_path: path,
      image_name: customName.trim() || undefined,
      image_tag: customTag.trim() || undefined,
    })
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
    if (!isImageArchive(serverPath.trim())) { toast.error('Path must point to a .tar / .tar.gz / .tgz image archive'); return }
    try { await loadIntoDocker(serverPath.trim(), serverPath.split('/').pop() || serverPath) }
    catch (e) { setPhase('idle'); toast.error(e instanceof Error ? e.message : 'Load failed') }
  }

  const busy = phase === 'uploading' || phase === 'loading'

  return (
    <Modal open onClose={busy ? () => {} : onClose} size="md" icon={HardDriveUpload} title="Add Docker Image"
      subtitle="Upload a .tar / .tar.gz from your computer or load one already on the server"
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

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Image name <span className="text-slate-600">(optional override)</span></label>
            <input className="input font-mono text-xs" value={customName} disabled={busy}
              onChange={e => setCustomName(e.target.value)} placeholder="e.g. myregistry/app" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Tag <span className="text-slate-600">(optional)</span></label>
            <input className="input font-mono text-xs" value={customTag} disabled={busy}
              onChange={e => setCustomTag(e.target.value)} placeholder="e.g. v1.2.3" />
          </div>
          <p className="sm:col-span-2 text-[10px] text-slate-600">
            When set, OffDock applies <code>docker tag</code> to the loaded image so it can be referenced by this name:tag (image rollback, compose overrides, and backup export).
          </p>
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
                  <p className="text-sm text-slate-300">Click to choose a <span className="font-mono">.tar</span> / <span className="font-mono">.tar.gz</span> image</p>
                  <p className="text-xs text-slate-500">Streamed to the server, then <code>docker load</code> (gzip/bzip2/xz auto-detected)</p>
                </div>
              )}
            </button>
            <input ref={fileRef} type="file" accept=".tar,.tar.gz,.tgz,.gz,.tar.bz2,.tbz,.tbz2,.tar.xz,.txz" className="hidden" onChange={e => { setFile(e.target.files?.[0] ?? null); setPhase('idle') }} />

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
            <label className="block text-xs text-slate-500">Absolute path to a .tar / .tar.gz on the server</label>
            <input className="input font-mono text-xs" value={serverPath} onChange={e => setServerPath(e.target.value)} placeholder="/var/offdock/uploads/myimage.tar.gz" />
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
  const [usage, setUsage] = useState<ImageUsage[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [pruning, setPruning] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<ImageUsage | null>(null)
  const [diskRows, setDiskRows] = useState<DiskUsageRow[]>([])
  const [unusedOnly, setUnusedOnly] = useState(false)

  const reload = () => api.imageUsage().then(d => setUsage(d.images ?? [])).catch(() => {}).finally(() => setLoading(false))
  useEffect(() => {
    reload()
    api.getSystemDf().then(d => setDiskRows(d.rows ?? [])).catch(() => {})
  }, [])

  const inUseCount = usage.filter(u => u.in_use).length
  const unusedCount = usage.length - inUseCount
  const shown = unusedOnly ? usage.filter(u => !u.in_use) : usage

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

  return (
    <Page>
      {!can(PERMS.manageImages) && <ReadOnlyBanner message="You don't have permission to manage images. Viewing in read-only mode." />}
      <PageHeader title="Images" subtitle={`${usage.length} image${usage.length !== 1 ? 's' : ''} · ${inUseCount} in use · ${unusedCount} unused`} icon={Boxes}
        actions={<>
          {can(PERMS.manageImages) && <button onClick={() => handlePrune(false)} disabled={pruning} title="Remove dangling (unused) images" className="btn-secondary">
            {pruning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Prune dangling
          </button>}
          <button onClick={handleSync} disabled={syncing} className="btn-secondary">
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />} Sync from Docker
          </button>
          {can(PERMS.manageImages) && <button onClick={() => setShowUpload(true)} className="btn-primary"><Upload className="w-4 h-4" /> Add Image</button>}
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
      {confirmDelete && <DeleteImageModal image={confirmDelete} onDone={() => { setConfirmDelete(null); reload() }} onClose={() => setConfirmDelete(null)} />}

      <Panel title="Docker Images" icon={Boxes} actions={
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
            <input type="checkbox" checked={unusedOnly} onChange={e => setUnusedOnly(e.target.checked)} />
            Unused only
          </label>
          <button onClick={reload} className="text-slate-400 hover:text-slate-200"><RefreshCw className="w-4 h-4" /></button>
        </div>
      }>
        {loading ? (
          <div className="p-4 space-y-2">{[0,1,2].map(i => <div key={i} className="h-12 skeleton rounded-lg" />)}</div>
        ) : usage.length === 0 ? (
          <EmptyState icon={FileArchive} title="No images"
            description="Upload a .tar image from your computer, or sync images already loaded on the host."
            action={<div className="flex gap-2">
              <button onClick={() => setShowUpload(true)} className="btn-primary"><Upload className="w-4 h-4" /> Add Image</button>
              <button onClick={handleSync} className="btn-secondary"><RotateCw className="w-4 h-4" /> Sync from Docker</button>
            </div>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead><tr className="border-b border-slate-800">
                <th className="th text-left">Image</th><th className="th text-left">Tag</th>
                <th className="th text-left">Docker ID</th><th className="th text-left">Size</th>
                <th className="th text-left">Status</th><th className="th text-right"></th>
              </tr></thead>
              <tbody>
                {shown.map(img => (
                  <tr key={img.image_id + img.repository + img.tag} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30">
                    <td className="px-4 py-3 font-mono text-xs text-slate-200">{img.repository}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">{img.tag}</td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-500">{(img.image_id ?? '').replace('sha256:', '').slice(0, 12)}</td>
                    <td className="px-4 py-3 text-xs text-slate-400 tabular-nums">{img.size || '—'}</td>
                    <td className="px-4 py-3 text-xs">
                      {img.in_use ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400" title={img.used_by.join(', ')}>
                          <Link2 className="w-3.5 h-3.5" /> in use ({img.used_by.length})
                        </span>
                      ) : (
                        <span className="text-slate-500">unused</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        disabled={!can(PERMS.manageImages)}
                        title={can(PERMS.manageImages) ? 'Delete' : 'Delete (no permission)'}
                        onClick={() => can(PERMS.manageImages) && setConfirmDelete(img)}
                        className={clsx('inline-flex items-center justify-center w-8 h-8 rounded-lg transition-colors',
                          can(PERMS.manageImages) ? 'text-slate-500 hover:text-red-400 hover:bg-red-500/10' : 'text-slate-700 cursor-not-allowed')}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
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
