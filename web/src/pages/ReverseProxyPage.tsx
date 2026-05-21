import { useEffect, useRef, useState } from 'react'
import { api, NginxContainerStatus, Networks, NetworkContainer } from '../api/client'

function useContainerStatus() {
  const [status, setStatus] = useState<NginxContainerStatus | null>(null)
  const load = async () => {
    try { setStatus(await api.nginxContainerStatus()) } catch {}
  }
  useEffect(() => { load() }, [])
  return { status, reload: load }
}

// ─── Network panel ────────────────────────────────────────────────────────────
function NetworkPanel() {
  const [nets, setNets] = useState<Networks | null>(null)
  const [allContainers, setAllContainers] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [msgErr, setMsgErr] = useState(false)
  const [addingTo, setAddingTo] = useState<'external' | 'internal' | null>(null)
  const [addInput, setAddInput] = useState('')

  const load = async () => {
    try {
      const [n, ps] = await Promise.all([api.listNetworks(), api.listProjects()])
      setNets(n)
      // Build list of running containers from projects for suggestions
      const names = ps.map(p => p.name.toLowerCase())
      setAllContainers(names)
    } catch {}
  }

  useEffect(() => { load() }, [])

  const connect = async (network: string, container: string) => {
    if (!container.trim()) return
    setBusy(`connect-${network}`); setMsg('')
    try {
      await api.networkConnect(network, container.trim())
      setMsg(`Connected ${container} to ${network}`)
      setMsgErr(false)
      setAddingTo(null); setAddInput('')
      load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed')
      setMsgErr(true)
    } finally { setBusy('') }
  }

  const disconnect = async (network: string, container: string) => {
    setBusy(`disconnect-${network}-${container}`); setMsg('')
    try {
      await api.networkDisconnect(network, container)
      setMsg(`Disconnected ${container}`)
      setMsgErr(false)
      load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed')
      setMsgErr(true)
    } finally { setBusy('') }
  }

  const NetworkSection = ({
    title, subtitle, networkKey, color, info,
  }: {
    title: string
    subtitle: string
    networkKey: 'external' | 'internal'
    color: string
    info: { name: string; exists: boolean; containers: NetworkContainer[] } | undefined
  }) => {
    const isAdding = addingTo === networkKey
    const containers = info?.containers ?? []

    return (
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />
          <span className="text-xs font-semibold text-gray-300">{title}</span>
          {info && (
            <span className={`text-xs px-1.5 py-0.5 rounded border ${
              info.exists ? 'bg-gray-800 text-gray-400 border-gray-700' : 'bg-red-950 text-red-400 border-red-900/40'
            }`}>
              {info.exists ? info.name : 'not created'}
            </span>
          )}
          <span className="text-xs text-gray-700 ml-auto">{subtitle}</span>
        </div>

        <div className="space-y-1">
          {containers.length === 0 && (
            <p className="text-xs text-gray-700 pl-1 py-1">No containers</p>
          )}
          {containers.map(c => (
            <div key={c.id} className="flex items-center gap-2 text-xs group">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-600 shrink-0" />
              <span className="font-mono text-gray-300 flex-1">{c.name}</span>
              <span className="text-gray-700 font-mono">{c.id}</span>
              <button
                onClick={() => disconnect(info!.name, c.name)}
                disabled={busy === `disconnect-${info!.name}-${c.name}`}
                className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-all px-1"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {isAdding ? (
          <div className="flex items-center gap-2 mt-2">
            <input
              autoFocus
              value={addInput}
              onChange={e => setAddInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') connect(info!.name, addInput); if (e.key === 'Escape') { setAddingTo(null); setAddInput('') } }}
              placeholder="container name…"
              list={`containers-${networkKey}`}
              className="input text-xs flex-1"
            />
            <datalist id={`containers-${networkKey}`}>
              {allContainers.map(n => <option key={n} value={n} />)}
            </datalist>
            <button onClick={() => connect(info!.name, addInput)} disabled={!!busy} className="btn-primary text-xs">Add</button>
            <button onClick={() => { setAddingTo(null); setAddInput('') }} className="btn-ghost text-xs">Cancel</button>
          </div>
        ) : (
          <button
            onClick={() => { setAddingTo(networkKey); setAddInput('') }}
            className="mt-2 text-xs text-gray-600 hover:text-gray-300 transition-colors"
          >
            + Add container
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="shrink-0 border-b border-gray-800 px-5 py-3 bg-gray-950">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Docker Networks</span>
        <div className="flex items-center gap-3">
          {msg && <span className={`text-xs ${msgErr ? 'text-red-400' : 'text-green-400'}`}>{msg}</span>}
          <button onClick={load} className="text-xs text-gray-600 hover:text-gray-400">↻</button>
        </div>
      </div>
      <div className="flex gap-6">
        <NetworkSection
          title="External"
          subtitle="nginx proxy targets"
          networkKey="external"
          color="bg-blue-400"
          info={nets?.external}
        />
        <div className="w-px bg-gray-800 shrink-0" />
        <NetworkSection
          title="Internal"
          subtitle="isolated (DB, cache…)"
          networkKey="internal"
          color="bg-gray-500"
          info={nets?.internal}
        />
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function ReverseProxyPage() {
  const { status, reload } = useContainerStatus()
  const [uiURL, setUiURL] = useState<string | null>(null)
  const [installSecret, setInstallSecret] = useState<string | null>(null)
  const [secretCopied, setSecretCopied] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [msgErr, setMsgErr] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const running = status?.running ?? false

  useEffect(() => {
    if (running) {
      api.nginxUIURL().then(r => setUiURL(r.url)).catch(() => {})
      api.nginxInstallSecret().then(r => { if (r.secret) setInstallSecret(r.secret) }).catch(() => {})
    }
  }, [running])

  const act = async (action: 'start' | 'stop' | 'reload') => {
    setBusy(action); setMsg('')
    try {
      if (action === 'start') await api.nginxContainerStart()
      else if (action === 'stop') await api.nginxContainerStop()
      else await api.nginxContainerReload()
      setMsg(action === 'start' ? 'Container started' : action === 'stop' ? 'Container stopped' : 'Nginx reloaded')
      setMsgErr(false)
      setTimeout(reload, 1200)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Action failed')
      setMsgErr(true)
    } finally { setBusy('') }
  }

  const copySecret = () => {
    if (!installSecret) return
    const copy = (text: string) => {
      const ta = document.createElement('textarea')
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(ta); ta.focus(); ta.select()
      document.execCommand('copy'); document.body.removeChild(ta)
      setSecretCopied(true); setTimeout(() => setSecretCopied(false), 2000)
    }
    navigator.clipboard ? navigator.clipboard.writeText(installSecret).catch(() => copy(installSecret)) : copy(installSecret)
  }

  const state = status?.state ?? 'unknown'

  return (
    <div className="flex flex-col h-full">

      {/* ── Header strip ─────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-gray-800 bg-gray-950">
        <span className={`w-2 h-2 rounded-full shrink-0 ${running ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`} />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-semibold text-gray-100">nginx-ui</span>
          <span className="ml-2 text-xs text-gray-600">offdock-nginx</span>
          {status && (
            <span className={`ml-2 text-xs px-1.5 py-0.5 rounded border ${
              running ? 'bg-green-950 text-green-300 border-green-900/40'
              : state === 'not_found' ? 'bg-gray-800 text-gray-500 border-gray-700'
              : 'bg-red-950 text-red-300 border-red-900/40'
            }`}>
              {running ? 'Running' : state === 'not_found' ? 'Not created' : status.status_text}
            </span>
          )}
          {running && uiURL && (
            <a href={uiURL} target="_blank" rel="noopener noreferrer"
              className="ml-3 text-xs text-blue-400 hover:text-blue-300 font-mono">
              {uiURL} ↗
            </a>
          )}
        </div>
        {msg && <span className={`text-xs ${msgErr ? 'text-red-400' : 'text-green-400'}`}>{msg}</span>}
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={reload} className="btn-ghost text-xs px-2">↻</button>
          {running ? (
            <>
              <button onClick={() => iframeRef.current && (iframeRef.current.src = iframeRef.current.src)} className="btn-ghost text-xs">Reload frame</button>
              <button onClick={() => act('reload')} disabled={!!busy} className="btn-ghost text-xs">{busy === 'reload' ? 'Reloading…' : 'Reload nginx'}</button>
              <button onClick={() => act('stop')} disabled={!!busy} className="text-xs text-gray-600 hover:text-red-400 transition-colors px-2">{busy === 'stop' ? 'Stopping…' : 'Stop'}</button>
            </>
          ) : (
            <button onClick={() => act('start')} disabled={busy === 'start'} className="btn-primary text-xs">{busy === 'start' ? 'Starting…' : 'Start nginx-ui'}</button>
          )}
        </div>
      </div>

      {/* ── Install secret banner ─────────────────────────────────────────── */}
      {running && installSecret && (
        <div className="shrink-0 flex items-center gap-3 px-5 py-2 bg-yellow-950/60 border-b border-yellow-900/40 text-xs">
          <span className="text-yellow-400 font-medium shrink-0">First-run secret</span>
          <code className="flex-1 font-mono text-yellow-200 truncate">{installSecret}</code>
          <button onClick={copySecret} className="shrink-0 text-yellow-400 hover:text-yellow-200 transition-colors px-2 py-0.5 rounded border border-yellow-900/50 hover:border-yellow-700">
            {secretCopied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      )}

      {/* ── Networks panel ───────────────────────────────────────────────── */}
      <NetworkPanel />

      {/* ── Main area ────────────────────────────────────────────────────── */}
      {running && uiURL ? (
        <iframe ref={iframeRef} src={uiURL} className="flex-1 w-full border-0" title="nginx-ui" allow="same-origin" />
      ) : (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md w-full space-y-5">
            <div className={`card border ${state === 'not_found' ? 'border-gray-700 border-dashed' : 'border-red-900/40'}`}>
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-gray-800 flex items-center justify-center shrink-0">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-gray-500">
                    <path fillRule="evenodd" d="M2 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm3.293 1.293a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 01-1.414-1.414L7.586 10 5.293 7.707a1 1 0 010-1.414zM11 12a1 1 0 100 2h3a1 1 0 100-2h-3z" clipRule="evenodd" />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-gray-100 mb-1">nginx-ui not running</p>
                  {state === 'not_found' ? (
                    <p className="text-xs text-gray-500 leading-relaxed">
                      Import <code className="text-gray-400">uozi-lab/nginx-ui:latest</code> via the <strong className="text-gray-300">Import</strong> page, then click <strong className="text-gray-300">Start nginx-ui</strong> above.
                    </p>
                  ) : (
                    <p className="text-xs text-gray-500">Container is {state}. Click <strong className="text-gray-300">Start nginx-ui</strong> above.</p>
                  )}
                </div>
              </div>
            </div>
            <div className="card-sm text-xs text-gray-500 space-y-2">
              <p className="font-semibold text-gray-400 uppercase tracking-wider text-xs">Ports</p>
              <p><code className="text-gray-400">80</code> HTTP · <code className="text-gray-400">443</code> HTTPS · <code className="text-gray-400">9000</code> Web UI</p>
              <p className="font-semibold text-gray-400 uppercase tracking-wider text-xs pt-1">Networks</p>
              <p><code className="text-gray-400">offdock-external</code> — nginx + proxy targets</p>
              <p><code className="text-gray-400">offdock-internal</code> — isolated backend containers</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
