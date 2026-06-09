import { useEffect, useState } from 'react'
import { api, DockerVolume } from '../api/client'
import { usePermissions, PERMS } from '../hooks/usePermissions'
import { ReadOnlyBanner } from '../components/ReadOnlyBanner'

function fmtDate(s: string) {
  if (!s) return '—'
  try { return new Date(s).toLocaleString() } catch { return s }
}

function VolumeRow({ vol, onDelete, busy }: {
  vol: DockerVolume
  onDelete: (name: string) => void
  busy: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const labelEntries = Object.entries(vol.Labels ?? {})

  return (
    <>
      <tr className="border-b border-slate-800/40 hover:bg-slate-800/20 cursor-pointer" onClick={() => setExpanded(e => !e)}>
        <td className="px-4 py-3 font-mono text-sm text-slate-200">{vol.Name}</td>
        <td className="px-4 py-3 text-xs text-slate-500">{vol.Driver}</td>
        <td className="px-4 py-3 text-xs text-slate-500">{vol.Scope}</td>
        <td className="px-4 py-3 text-xs text-slate-600 font-mono truncate max-w-[220px]" title={vol.Mountpoint}>
          {vol.Mountpoint}
        </td>
        <td className="px-4 py-3 text-xs text-slate-600">{fmtDate(vol.CreatedAt)}</td>
        <td className="px-4 py-3 text-right">
          <button
            onClick={e => { e.stopPropagation(); onDelete(vol.Name) }}
            disabled={busy}
            className="text-xs text-slate-600 hover:text-red-400 transition-colors disabled:opacity-30">
            Delete
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-950/60 border-b border-slate-800/40">
          <td colSpan={6} className="px-4 py-3">
            <div className="space-y-1.5 text-xs font-mono">
              <div className="flex gap-3">
                <span className="text-slate-600 w-24">Mountpoint</span>
                <span className="text-slate-300">{vol.Mountpoint}</span>
              </div>
              {labelEntries.length > 0 && (
                <div className="flex gap-3">
                  <span className="text-slate-600 w-24">Labels</span>
                  <div className="space-y-0.5">
                    {labelEntries.map(([k, v]) => (
                      <p key={k} className="text-slate-400"><span className="text-slate-600">{k}=</span>{v}</p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function CreateVolumeModal({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
  const [name, setName] = useState('')
  const [driver, setDriver] = useState('local')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const create = async () => {
    if (!name.trim()) return
    setBusy(true); setErr('')
    try {
      await api.createVolume(name.trim(), driver)
      onCreated()
      onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-80 shadow-2xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-white">Create Volume</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Volume name</label>
            <input className="input w-full" placeholder="my-data"
              value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && create()} autoFocus />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Driver</label>
            <select value={driver} onChange={e => setDriver(e.target.value)} className="input w-full">
              <option value="local">local (default)</option>
            </select>
          </div>
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button onClick={create} disabled={!name.trim() || busy} className="btn-primary disabled:opacity-40">
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function VolumesPage() {
  const { can } = usePermissions()
  const [volumes, setVolumes] = useState<DockerVolume[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [msgErr, setMsgErr] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [pruning, setPruning] = useState(false)

  const load = async () => {
    setLoading(true)
    try { setVolumes(await api.listVolumes() ?? []) } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const flash = (text: string, err = false) => {
    setMsg(text); setMsgErr(err)
    setTimeout(() => setMsg(''), 3500)
  }

  const deleteVol = async (name: string) => {
    setBusy(name)
    try {
      await api.deleteVolume(name)
      flash(`Volume ${name} deleted`)
      setDeleteTarget(null)
      load()
    } catch (e) { flash(e instanceof Error ? e.message : 'Failed', true) }
    finally { setBusy('') }
  }

  const prune = async () => {
    setPruning(true)
    try {
      const r = await api.pruneVolumes()
      const count = (r.pruned ?? []).length
      flash(count === 0 ? 'No unused volumes found' : `Removed ${count} volume${count > 1 ? 's' : ''}${r.space_reclaimed ? ' · ' + r.space_reclaimed + ' freed' : ''}`)
      load()
    } catch (e) { flash(e instanceof Error ? e.message : 'Prune failed', true) }
    finally { setPruning(false) }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {!can(PERMS.manageNetwork) && <ReadOnlyBanner message="You don't have permission to manage volumes. Viewing in read-only mode." />}

      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-slate-800 bg-slate-950">
        <h1 className="text-sm font-semibold text-slate-100 flex-1">Docker Volumes</h1>
        {msg && (
          <span className={`text-xs px-2 py-0.5 rounded border ${msgErr ? 'text-red-300 bg-red-950/50 border-red-900/40' : 'text-green-300 bg-green-950/50 border-green-900/40'}`}>
            {msg}
          </span>
        )}
        <button onClick={load} className="btn-ghost text-xs px-2">↻</button>
        {can(PERMS.manageNetwork) && <button onClick={prune} disabled={pruning} className="btn-ghost text-xs">
          {pruning ? 'Pruning…' : 'Prune unused'}
        </button>}
        {can(PERMS.manageNetwork) && <button onClick={() => setShowCreate(true)} className="btn-primary text-xs">+ Create</button>}
      </div>

      {showCreate && <CreateVolumeModal onCreated={load} onClose={() => setShowCreate(false)} />}

      {deleteTarget && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setDeleteTarget(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-80 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-semibold text-white">Delete volume?</p>
            <p className="text-xs text-slate-500 font-mono">{deleteTarget}</p>
            <p className="text-xs text-yellow-600">This permanently deletes all data in the volume.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteTarget(null)} className="btn-ghost text-sm">Cancel</button>
              <button onClick={() => deleteVol(deleteTarget)}
                className="text-sm px-4 py-2 rounded-lg bg-red-600/20 text-red-300 border border-red-900/50 hover:bg-red-600/30 transition-colors">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Usage guide */}
      <div className="shrink-0 px-5 py-3 border-b border-slate-800 bg-slate-950/40 text-xs text-slate-600">
        Volumes persist data across container restarts. Mount them in your docker-compose.yml with{' '}
        <code className="text-slate-400 bg-slate-800/60 px-1 rounded">volumes: [my-data:/app/data]</code>.
        Click a row to expand details.
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto p-5">
        {loading ? (
          <div className="text-center py-12 text-slate-600 text-sm">Loading volumes…</div>
        ) : volumes.length === 0 ? (
          <div className="card text-center py-12 border-dashed space-y-3">
            <p className="text-slate-500 text-sm">No volumes yet</p>
            <p className="text-xs text-slate-700">Volumes are created automatically when containers use them, or you can create one here.</p>
            <button onClick={() => setShowCreate(true)} className="btn-primary text-sm mx-auto">Create first volume</button>
          </div>
        ) : (
          <div className="card p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">Driver</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">Scope</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">Mountpoint</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">Created</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {volumes.map(v => (
                  <VolumeRow key={v.Name} vol={v} onDelete={name => setDeleteTarget(name)} busy={busy === v.Name} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
