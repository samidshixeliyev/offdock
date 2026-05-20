import { useEffect, useState } from 'react'
import { api, UsbDrive, FileEntry } from '../api/client'

function humanBytes(b: number) {
  if (b < 1e9) return (b / 1e6).toFixed(0) + ' MB'
  return (b / 1e9).toFixed(1) + ' GB'
}

type Mode = 'usb' | 'disk'

export default function USBPage() {
  const [mode, setMode] = useState<Mode>('usb')
  const [drives, setDrives] = useState<UsbDrive[]>([])
  const [selectedDrive, setSelectedDrive] = useState<UsbDrive | null>(null)
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'ok' | 'err'>('ok')

  // Disk-mode: manual path input
  const [diskMount, setDiskMount] = useState('/')
  const [diskPath, setDiskPath] = useState('/')

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

  const browseDisk = async () => {
    try {
      const files = await api.browseDrive(diskMount, diskPath)
      setEntries(files ?? [])
      setPath(diskPath)
    } catch (e) {
      notify('Browse error: ' + (e instanceof Error ? e.message : String(e)), 'err')
    }
  }

  const loadTar = async (entry: FileEntry) => {
    notify('Loading ' + entry.name + '…')
    try {
      const img = await api.loadImage({ tar_file_path: entry.path })
      notify(`Loaded: ${img.image_name}:${img.image_tag}`)
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

  const mountPoint = mode === 'usb' ? (selectedDrive?.mount_point ?? '') : diskMount

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h1 className="text-xl font-semibold text-white">Import Files</h1>
        <div className="flex items-center gap-3">
          {msg && (
            <span className={`text-sm max-w-xs truncate ${msgType === 'err' ? 'text-red-400' : 'text-gray-400'}`}>
              {msg}
            </span>
          )}
        </div>
      </div>

      {/* Mode switcher */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setMode('usb')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'usb' ? 'bg-blue-600 text-white' : 'text-gray-400 bg-gray-800 hover:text-white'}`}
        >
          💾 USB Drive
        </button>
        <button
          onClick={() => setMode('disk')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'disk' ? 'bg-blue-600 text-white' : 'text-gray-400 bg-gray-800 hover:text-white'}`}
        >
          🗄️ Server Disk
        </button>
      </div>

      {/* USB mode */}
      {mode === 'usb' && (
        <section className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Detected Drives</h2>
            <button onClick={refreshDrives} className="btn-ghost text-xs">↻ Refresh</button>
          </div>
          {drives.length === 0 ? (
            <div className="card text-gray-500 text-sm text-center py-6">
              No drives detected at /media or /mnt
              <p className="text-xs text-gray-600 mt-1">Switch to "Server Disk" to browse files on this machine</p>
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
              <label className="block text-xs text-gray-400 mb-1.5">Base directory (security boundary)</label>
              <input
                className="input font-mono text-xs"
                value={diskMount}
                onChange={e => setDiskMount(e.target.value)}
                placeholder="/home/ubuntu"
              />
              <p className="text-xs text-gray-600 mt-1">Files must stay within this directory</p>
            </div>
            <div className="flex gap-2">
              <input
                className="input font-mono text-xs flex-1"
                value={diskPath}
                onChange={e => setDiskPath(e.target.value)}
                placeholder="/home/ubuntu/images"
                onKeyDown={e => e.key === 'Enter' && browseDisk()}
              />
              <button onClick={browseDisk} className="btn-primary">Browse</button>
            </div>
          </div>
        </section>
      )}

      {/* File browser — shared between modes */}
      {entries.length > 0 || (path && path !== mountPoint) ? (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Files</h2>
            <span className="text-xs text-gray-600 font-mono truncate">{path}</span>
          </div>
          <div className="card overflow-hidden p-0">
            {path !== mountPoint && (
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
                  className="flex items-center gap-2 text-sm text-left min-w-0 flex-1"
                  onClick={() => e.is_dir && browse(mode === 'usb' ? selectedDrive : null, e.path)}
                >
                  <span>{e.is_dir ? '📁' : '📄'}</span>
                  <span className="font-mono text-xs text-gray-300 truncate">{e.name}</span>
                  {!e.is_dir && <span className="text-xs text-gray-600 shrink-0">{humanBytes(e.size)}</span>}
                </button>
                {!e.is_dir && e.name.endsWith('.tar') && (
                  <button onClick={() => loadTar(e)} className="btn-primary text-xs py-1 shrink-0 ml-3">
                    Load Image
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
