import { useEffect, useState } from 'react'
import { api, DockerImage } from '../api/client'
import ConfirmModal from '../components/ConfirmModal'

export default function ImagesPage() {
  const [images, setImages] = useState<DockerImage[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'ok' | 'err'>('ok')
  const [syncing, setSyncing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<DockerImage | null>(null)

  const notify = (text: string, type: 'ok' | 'err' = 'ok') => { setMsg(text); setMsgType(type) }

  const reload = () =>
    api.listImages()
      .then(d => setImages(d ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))

  useEffect(() => { reload() }, [])

  const handleSync = async () => {
    setSyncing(true)
    try {
      const res = await api.syncImages()
      notify(`Synced ${res.synced} new image${res.synced !== 1 ? 's' : ''} from Docker`)
      reload()
    } catch (e: unknown) {
      notify('Sync failed: ' + (e instanceof Error ? e.message : 'unknown'), 'err')
    } finally {
      setSyncing(false)
    }
  }

  const handleDelete = async (img: DockerImage) => {
    try {
      await api.deleteImage(img.id)
      notify('Deleted')
      reload()
    } catch (e: unknown) {
      notify('Error: ' + (e instanceof Error ? e.message : 'unknown'), 'err')
    } finally {
      setConfirmDelete(null)
    }
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h1 className="text-xl font-semibold text-white">Docker Images</h1>
        <div className="flex items-center gap-3">
          {msg && <span className={`text-sm ${msgType === 'err' ? 'text-red-400' : 'text-green-400'}`}>{msg}</span>}
          <button onClick={handleSync} disabled={syncing} className="btn-ghost">
            {syncing ? '↻ Syncing…' : '↻ Sync from Docker'}
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-600 mb-4">
        Use "Sync from Docker" to register images already loaded on the host.
        Use the <a href="/usb" className="text-blue-500">Import</a> page to load new .tar files.
      </p>

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : images.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-gray-500 mb-2">No images tracked.</p>
          <div className="flex gap-3 justify-center mt-3">
            <button onClick={handleSync} disabled={syncing} className="btn-primary">
              Sync from Docker
            </button>
          </div>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-xs">
                <th className="text-left px-4 py-2.5">Image</th>
                <th className="text-left px-4 py-2.5">Tag</th>
                <th className="text-left px-4 py-2.5">Docker ID</th>
                <th className="text-left px-4 py-2.5">Loaded</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {images.map(img => (
                <tr key={img.id} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-300">{img.image_name}</td>
                  <td className="px-4 py-2.5 text-gray-400 text-xs">{img.image_tag}</td>
                  <td className="px-4 py-2.5 text-gray-600 text-xs font-mono">
                    {(img.docker_image_id ?? '').replace('sha256:', '').slice(0, 12)}
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">
                    {new Date(img.loaded_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => setConfirmDelete(img)} className="text-xs text-red-500 hover:text-red-400">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete Image"
          message={`Remove ${confirmDelete.image_name}:${confirmDelete.image_tag} from Docker and database?`}
          confirmLabel="Delete"
          danger
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}
