import { useEffect, useState } from 'react'
import { api, DockerImage } from '../api/client'

export default function ImagesPage() {
  const [images, setImages] = useState<DockerImage[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'ok' | 'err'>('ok')

  const reload = () => api.listImages().then(d => setImages(d ?? [])).catch(() => {}).finally(() => setLoading(false))
  useEffect(() => { reload() }, [])

  const handleDelete = async (img: DockerImage) => {
    if (!confirm(`Remove image ${img.image_name}:${img.image_tag}?`)) return
    try {
      await api.deleteImage(img.id)
      setMsg('Deleted')
      setMsgType('ok')
      reload()
    } catch (e: unknown) {
      setMsg('Error: ' + (e instanceof Error ? e.message : 'unknown'))
      setMsgType('err')
    }
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white">Docker Images</h1>
        {msg && <span className={`text-sm ${msgType === 'err' ? 'text-red-400' : 'text-gray-400'}`}>{msg}</span>}
      </div>

      {loading ? (
        <div className="text-gray-500">Loading…</div>
      ) : images.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-gray-500 mb-2">No images loaded.</p>
          <p className="text-xs text-gray-600">Use the Import page to load .tar images.</p>
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
                  <td className="px-4 py-2.5 text-gray-600 text-xs font-mono">{(img.docker_image_id ?? '').slice(0, 16)}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{new Date(img.loaded_at).toLocaleString()}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => handleDelete(img)} className="text-xs text-red-500 hover:text-red-400">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
