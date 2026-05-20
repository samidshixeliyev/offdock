import { useEffect, useState } from 'react'
import { api, UsbDrive, FileEntry } from '../api/client'

function humanBytes(b: number) {
  if (b < 1e9) return (b / 1e6).toFixed(0) + ' MB'
  return (b / 1e9).toFixed(1) + ' GB'
}

export default function USBPage() {
  const [drives, setDrives] = useState<UsbDrive[]>([])
  const [selectedDrive, setSelectedDrive] = useState<UsbDrive | null>(null)
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [msg, setMsg] = useState('')

  const refreshDrives = () => api.listDrives().then(setDrives)
  useEffect(() => { refreshDrives() }, [])

  const browse = async (drive: UsbDrive, p?: string) => {
    setSelectedDrive(drive)
    const targetPath = p ?? drive.mount_point
    setPath(targetPath)
    const files = await api.browseDrive(drive.mount_point, targetPath)
    setEntries(files)
  }

  const loadTar = async (entry: FileEntry) => {
    setMsg('Loading ' + entry.name + '…')
    try {
      const img = await api.loadImage({ tar_file_path: entry.path })
      setMsg(`Loaded: ${img.image_name}:${img.image_tag}`)
    } catch (e: unknown) {
      setMsg('Error: ' + (e instanceof Error ? e.message : 'unknown'))
    }
  }

  const navigateUp = () => {
    if (!selectedDrive) return
    const parts = path.split('/').filter(Boolean)
    parts.pop()
    const parent = '/' + parts.join('/')
    if (parent.startsWith(selectedDrive.mount_point) || parent === selectedDrive.mount_point.replace(/\/$/, '')) {
      browse(selectedDrive, parent)
    }
  }

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white">USB Import</h1>
        <div className="flex items-center gap-3">
          {msg && <span className="text-sm text-gray-400 max-w-xs truncate">{msg}</span>}
          <button onClick={refreshDrives} className="btn-ghost">↻ Refresh drives</button>
        </div>
      </div>

      {/* Drives */}
      <section className="mb-6">
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Detected Drives</h2>
        {drives.length === 0 ? (
          <div className="card text-gray-500 text-sm text-center py-6">No drives detected at /media or /mnt</div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {drives.map(d => (
              <button
                key={d.mount_point}
                onClick={() => browse(d)}
                className={`card text-left hover:border-blue-600 transition-colors ${selectedDrive?.mount_point === d.mount_point ? 'border-blue-600' : ''}`}
              >
                <p className="font-medium text-white text-sm">{d.label}</p>
                <p className="text-xs text-gray-500 mt-0.5 font-mono">{d.mount_point}</p>
                <p className="text-xs text-gray-600 mt-1">{humanBytes(d.free_bytes)} free / {humanBytes(d.total_bytes)}</p>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* File browser */}
      {selectedDrive && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Files</h2>
            <span className="text-xs text-gray-600 font-mono">{path}</span>
          </div>
          <div className="card overflow-hidden p-0">
            {path !== selectedDrive.mount_point && (
              <button
                onClick={navigateUp}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-400 hover:bg-gray-800 border-b border-gray-800"
              >
                ← ..
              </button>
            )}
            {entries.length === 0 && (
              <p className="px-4 py-6 text-gray-500 text-sm text-center">Empty directory or no supported files</p>
            )}
            {entries.map(e => (
              <div key={e.path} className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800/50 hover:bg-gray-800/30">
                <button
                  className="flex items-center gap-2 text-sm text-left min-w-0"
                  onClick={() => e.is_dir && browse(selectedDrive, e.path)}
                >
                  <span>{e.is_dir ? '📁' : '📄'}</span>
                  <span className="font-mono text-xs text-gray-300 truncate">{e.name}</span>
                  {!e.is_dir && <span className="text-xs text-gray-600">{humanBytes(e.size)}</span>}
                </button>
                {!e.is_dir && e.name.endsWith('.tar') && (
                  <button onClick={() => loadTar(e)} className="btn-primary text-xs py-1 shrink-0">
                    Load Image
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
