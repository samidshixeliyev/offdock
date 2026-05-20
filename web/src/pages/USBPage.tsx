import { useEffect, useRef, useState } from 'react'
import { api, UsbDrive, FileEntry } from '../api/client'

function humanBytes(b: number) {
  if (b < 1e9) return (b / 1e6).toFixed(0) + ' MB'
  return (b / 1e9).toFixed(1) + ' GB'
}

type Mode = 'usb' | 'disk' | 'upload'

export default function USBPage() {
  const [mode, setMode] = useState<Mode>('usb')
  const [drives, setDrives] = useState<UsbDrive[]>([])
  const [selectedDrive, setSelectedDrive] = useState<UsbDrive | null>(null)
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'ok' | 'err'>('ok')

  // Disk mode
  const [diskMount, setDiskMount] = useState('/var/offdock')
  const [diskPath, setDiskPath] = useState('/var/offdock')

  // Upload mode
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadedPath, setUploadedPath] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const notify = (text: string, type: 'ok' | 'err' = 'ok') => { setMsg(text); setMsgType(type) }

  const refreshDrives = () =>
    api.listDrives()
      .then(d => setDrives(d ?? []))
      .catch(e => notify('Could not scan drives: ' + (e instanceof Error ? e.message : String(e)), 'err'))

  useEffect(() => { refreshDrives() }, [])

  const browse = async (drive: UsbDrive | null, targetPath: string) => {
    const mount = drive?.mount_point ?? diskMount
    try {
      const files = await api.browseDrive(mount, targetPath)
      setEntries(files ?? [])
      setPath(targetPath)
      if (drive) setSelectedDrive(drive)
    } catch (e) {
      notify('Browse error: ' + (e instanceof Error ? e.message : String(e)), 'err')
    }
  }

  const browseDisk = () => browse(null, diskPath)

  const loadTar = async (entry: FileEntry) => {
    notify('Loading ' + entry.name + '...')
    try {
      const img = await api.loadImage({ tar_file_path: entry.path })
      notify('Loaded: ' + img.image_name + ':' + img.image_tag)
    } catch (e) {
      notify('Load failed: ' + (e instanceof Error ? e.message : String(e)), 'err')
    }
  }

  const navigateUp = () => {
    const mount = selectedDrive?.mount_point ?? diskMount
    const parts = path.split('/').filter(Boolean)
    parts.pop()
    const parent = '/' + parts.join('/')
    if (parent.startsWith(mount.replace(/\/$/, ''))) {
      browse(mode === 'usb' ? selectedDrive : null, parent || mount)
    }
  }

  const handleUpload = async (file: File) => {
    setUploading(true)
    notify('Uploading ' + file.name + '...')
    try {
      const result = await api.uploadFile(file)
      setUploadedPath(result.path)
      notify('Uploaded to ' + result.path + ' (' + humanBytes(result.size) + ')')
      if (file.name.endsWith('.tar')) {
        notify('Loading image from ' + result.path + '...')
        const img = await api.loadImage({ tar_file_path: result.path })
        notify('Image loaded: ' + img.image_name + ':' + img.image_tag)
      }
    } catch (e) {
      notify('Upload failed: ' + (e instanceof Error ? e.message : String(e)), 'err')
    } finally {
      setUploading(false)
    }
  }

  const mountPoint = mode === 'usb' ? (selectedDrive?.mount_point ?? '') : diskMount

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h1 className="text-xl font-semibold text-white">Import Files</h1>
        {msg && (
          <span className={`text-sm max-w-sm truncate ${msgType === 'err' ? 'text-red-400' : 'text-green-400'}`}>
            {msg}
          </span>
        )}
      </div>

      {/* Mode tabs */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {[['usb', '💾 USB Drive'], ['disk', '🗄️ Server Disk'], ['upload', '⬆️ Upload from PC']] .map(([m, label]) => (
          <button
            key={m}
            onClick={() => setMode(m as Mode)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === m ? 'bg-blue-600 text-white' : 'text-gray-400 bg-gray-800 hover:text-white'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* USB mode */}
      {mode === 'usb' && (
        <section className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Detected Drives</h2>
            <button onClick={refreshDrives} className="btn-ghost text-xs">Refresh</button>
          </div>
          {drives.length === 0 ? (
            <div className="card text-gray-500 text-sm text-center py-6">
              No drives detected at /media or /mnt
              <p className="text-xs text-gray-600 mt-1">Switch to "Server Disk" or "Upload from PC" instead</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {drives.map(d => (
                <button
                  key={d.mount_point}
                  onClick={() => browse(d, d.mount_point)}
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
      )}

      {/* Disk mode */}
      {mode === 'disk' && (
        <section className="mb-6">
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Browse Server Filesystem</h2>
          <div className="card space-y-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Security boundary (files must stay within this directory)</label>
              <input className="input font-mono text-xs" value={diskMount} onChange={e => setDiskMount(e.target.value)} placeholder="/var/offdock" />
            </div>
            <div className="flex gap-2">
              <input
                className="input font-mono text-xs flex-1"
                value={diskPath}
                onChange={e => setDiskPath(e.target.value)}
                placeholder="/var/offdock/uploads"
                onKeyDown={e => e.key === 'Enter' && browseDisk()}
              />
              <button onClick={browseDisk} className="btn-primary">Browse</button>
            </div>
          </div>
        </section>
      )}

      {/* Upload mode */}
      {mode === 'upload' && (
        <section className="mb-6">
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Upload from your computer</h2>
          <div
            className={`card border-2 border-dashed text-center py-12 transition-colors cursor-pointer ${dragOver ? 'border-blue-500 bg-blue-900/10' : 'border-gray-700 hover:border-gray-500'}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleUpload(f) }}
            onClick={() => fileRef.current?.click()}
          >
            <p className="text-gray-400 text-sm">Drag & drop a file here, or click to select</p>
            <p className="text-gray-600 text-xs mt-1">Supported: .tar .yml .yaml .env .pem .crt .key</p>
            {uploading && <p className="text-blue-400 text-xs mt-3 animate-pulse">Uploading...</p>}
            {uploadedPath && !uploading && (
              <div className="mt-3">
                <p className="text-green-400 text-xs">Saved to: {uploadedPath}</p>
                {uploadedPath.endsWith('.tar') && (
                  <button
                    className="btn-primary text-xs mt-2"
                    onClick={e => { e.stopPropagation(); api.loadImage({ tar_file_path: uploadedPath }).then(img => notify('Loaded: ' + img.image_name + ':' + img.image_tag)).catch(err => notify(String(err), 'err')) }}
                  >
                    Load as Docker Image
                  </button>
                )}
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" className="hidden" accept=".tar,.yml,.yaml,.env,.pem,.crt,.key" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = '' }} />
        </section>
      )}

      {/* File browser — shared between USB and disk modes */}
      {(mode === 'usb' || mode === 'disk') && (entries.length > 0 || (path && path !== mountPoint)) && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Files</h2>
            <span className="text-xs text-gray-600 font-mono truncate">{path}</span>
          </div>
          <div className="card overflow-hidden p-0">
            {path !== mountPoint && (
              <button onClick={navigateUp} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-400 hover:bg-gray-800 border-b border-gray-800">
                &larr; ..
              </button>
            )}
            {entries.length === 0 && (
              <p className="px-4 py-6 text-gray-500 text-sm text-center">Empty directory or no supported files</p>
            )}
            {entries.map(e => (
              <div key={e.path} className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800/50 hover:bg-gray-800/30">
                <button className="flex items-center gap-2 text-sm text-left min-w-0 flex-1" onClick={() => e.is_dir && browse(mode === 'usb' ? selectedDrive : null, e.path)}>
                  <span>{e.is_dir ? '📁' : '📄'}</span>
                  <span className="font-mono text-xs text-gray-300 truncate">{e.name}</span>
                  {!e.is_dir && <span className="text-xs text-gray-600 shrink-0">{humanBytes(e.size)}</span>}
                </button>
                {!e.is_dir && e.name.endsWith('.tar') && (
                  <button onClick={() => loadTar(e)} className="btn-primary text-xs py-1 shrink-0 ml-3">Load Image</button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
