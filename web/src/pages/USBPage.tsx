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
  const [uploadPct, setUploadPct] = useState(0)
  const [uploadLoaded, setUploadLoaded] = useState(0)
  const [uploadTotal, setUploadTotal] = useState(0)

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

  const MAX_BYTES = 5 * 1024 * 1024 * 1024 // 5 GB

  const handleUpload = async (file: File) => {
    if (file.size > MAX_BYTES) {
      notify('File too large: ' + humanBytes(file.size) + ' (max 5 GB)', 'err')
      return
    }
    setUploading(true)
    setUploadPct(0)
    setUploadLoaded(0)
    setUploadTotal(file.size)
    setUploadedPath('')
    notify('')

    let uploadedFilePath = ''
    try {
      const result = await api.uploadFile(file, (loaded, total, pct) => {
        setUploadLoaded(loaded)
        setUploadTotal(total)
        setUploadPct(pct)
      })
      uploadedFilePath = result.path
      setUploadedPath(result.path)
      setUploadPct(100)

      if (file.name.endsWith('.tar')) {
        notify('Upload complete — loading Docker image...')
        const img = await api.loadImage({ tar_file_path: result.path })
        notify('Image loaded: ' + img.image_name + ':' + img.image_tag)
      } else {
        notify('Upload complete: ' + result.path + ' (' + humanBytes(result.size) + ')')
      }
    } catch (e) {
      // If upload succeeded but docker load failed, still show path
      if (uploadedFilePath) {
        notify('Docker load failed — file saved at ' + uploadedFilePath + '. Try "Load as Docker Image" below.', 'err')
        setUploadedPath(uploadedFilePath)
      } else {
        notify('Upload failed: ' + (e instanceof Error ? e.message : String(e)), 'err')
      }
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
        <section className="mb-6 space-y-4">
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            Upload from your computer
            <span className="ml-2 text-gray-600 normal-case font-normal">· max 5 GB</span>
          </h2>

          {/* ── Progress panel (visible while uploading) ── */}
          {uploading && (
            <div className="card border border-blue-800 bg-blue-900/10 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-blue-300 text-sm font-medium">Uploading…</span>
                <span className="text-blue-400 text-sm font-mono font-bold">{uploadPct}%</span>
              </div>
              {/* thick progress bar */}
              <div className="h-3 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-200"
                  style={{ width: `${uploadPct}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-500 font-mono">
                <span>{humanBytes(uploadLoaded)}</span>
                <span>{humanBytes(uploadTotal)}</span>
              </div>
            </div>
          )}

          {/* ── Success / result panel ── */}
          {uploadedPath && !uploading && (
            <div className={`card border ${msgType === 'err' ? 'border-red-800 bg-red-900/10' : 'border-green-800 bg-green-900/10'}`}>
              <div className="flex items-start gap-3">
                <span className="text-2xl">{msgType === 'err' ? '❌' : '✅'}</span>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${msgType === 'err' ? 'text-red-300' : 'text-green-300'}`}>
                    {msgType === 'err' ? 'Upload issue' : 'Upload complete'}
                  </p>
                  <p className="text-xs text-gray-400 font-mono mt-1 truncate">{uploadedPath}</p>
                  {msg && <p className={`text-xs mt-1 ${msgType === 'err' ? 'text-red-400' : 'text-gray-400'}`}>{msg}</p>}
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                {uploadedPath.endsWith('.tar') && (
                  <button
                    className="btn-primary text-xs"
                    onClick={() => {
                      notify('Loading Docker image...')
                      api.loadImage({ tar_file_path: uploadedPath })
                        .then(img => notify('Loaded: ' + img.image_name + ':' + img.image_tag))
                        .catch(e => notify('Load failed: ' + (e instanceof Error ? e.message : String(e)), 'err'))
                    }}
                  >
                    Load as Docker Image
                  </button>
                )}
                <button
                  className="btn-ghost text-xs"
                  onClick={() => { setUploadedPath(''); setUploadPct(0); notify('') }}
                >
                  Upload another file
                </button>
              </div>
            </div>
          )}

          {/* ── Drop zone (only shown when not uploading/done) ── */}
          {!uploading && !uploadedPath && (
            <div
              className={`card border-2 border-dashed text-center py-12 transition-colors cursor-pointer ${dragOver ? 'border-blue-500 bg-blue-900/10' : 'border-gray-700 hover:border-gray-600'}`}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleUpload(f) }}
              onClick={() => fileRef.current?.click()}
            >
              <p className="text-4xl mb-3">📂</p>
              <p className="text-gray-300 text-sm font-medium">Drag &amp; drop a file here</p>
              <p className="text-gray-500 text-xs mt-1">or click to select</p>
              <p className="text-gray-600 text-xs mt-2">.tar .yml .yaml .env .pem .crt .key · max 5 GB</p>
            </div>
          )}

          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".tar,.yml,.yaml,.env,.pem,.crt,.key"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = '' }}
          />
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
