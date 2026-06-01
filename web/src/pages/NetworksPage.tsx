import { useEffect, useState } from 'react'
import { api, DockerNetwork, ContainerInfo } from '../api/client'

const OFFDOCK_NETWORKS = new Set(['offdock-external', 'offdock-internal'])
const SYSTEM_NETWORKS = new Set(['bridge', 'host', 'none'])

// ─── Guide panel ─────────────────────────────────────────────────────────────
function NetworkingGuide() {
  const [open, setOpen] = useState(false)
  return (
    <div className="shrink-0 border-b border-gray-800 bg-gray-950/60">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-gray-900/40 transition-colors">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-blue-400">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd"/>
          </svg>
          <span className="text-xs font-semibold text-gray-300">Docker Networking Guide — How OffDock Routing Works</span>
        </div>
        <span className="text-gray-600 text-xs">{open ? '▲ hide' : '▼ show'}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-5 text-xs text-gray-400 leading-relaxed">

          {/* Flow diagram */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 font-mono text-xs">
            <p className="text-gray-500 mb-3">Request flow for multiple apps on one server:</p>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-blue-400">Browser</span>
                <span className="text-gray-700">──── Host: grafana.ao.az ───→</span>
                <span className="text-yellow-400">nginx:80</span>
                <span className="text-gray-700">──→</span>
                <span className="text-green-400">offdock-external</span>
                <span className="text-gray-700">──→</span>
                <span className="text-purple-400">grafana:3000</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-blue-400">Browser</span>
                <span className="text-gray-700">──── Host: modtube.local ────→</span>
                <span className="text-yellow-400">nginx:80</span>
                <span className="text-gray-700">──→</span>
                <span className="text-green-400">offdock-external</span>
                <span className="text-gray-700">──→</span>
                <span className="text-purple-400">modtube:8080</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-blue-400">Browser</span>
                <span className="text-gray-700">──── Host: (raw IP) ─────────→</span>
                <span className="text-yellow-400">nginx:80</span>
                <span className="text-gray-700">──→</span>
                <span className="text-red-400">444 (blocked)</span>
              </div>
            </div>
          </div>

          {/* Two networks explained */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-blue-950/20 border border-blue-900/40 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />
                <span className="font-semibold text-blue-300">offdock-external</span>
              </div>
              <p>Connect containers that nginx needs to reach — your <strong className="text-gray-300">web apps, APIs, dashboards</strong>.</p>
              <p className="text-gray-500">nginx uses Docker's embedded DNS to resolve container names to IPs. The container name in your upstream_host field is resolved inside this network.</p>
              <div className="mt-2 bg-gray-900/60 rounded-lg p-2.5 font-mono text-[10px] space-y-1">
                <p className="text-gray-500">Example: upstream is "grafana"</p>
                <p className="text-green-400">nginx → resolves "grafana" → 172.x.x.x → port 3000</p>
              </div>
            </div>

            <div className="bg-gray-800/20 border border-gray-700/40 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-gray-400 shrink-0" />
                <span className="font-semibold text-gray-300">offdock-internal</span>
              </div>
              <p>Connect <strong className="text-gray-300">backend services</strong> (databases, Redis, message queues) that should NOT be directly reachable from nginx or the internet.</p>
              <p className="text-gray-500">Your app containers can be on BOTH networks: external (so nginx can reach them) and internal (so they can reach the database).</p>
              <div className="mt-2 bg-gray-900/60 rounded-lg p-2.5 font-mono text-[10px] space-y-1">
                <p className="text-gray-500">Example: modtube app container</p>
                <p className="text-green-400">external: nginx can reach modtube:8080</p>
                <p className="text-green-400">internal: modtube can reach postgres:5432</p>
              </div>
            </div>
          </div>

          {/* Common recipes */}
          <div className="space-y-2">
            <p className="font-semibold text-gray-300">Common setup recipes:</p>
            <div className="space-y-1.5 font-mono text-[10px]">
              <div className="bg-gray-900 rounded-lg px-3 py-2 border border-gray-800">
                <p className="text-gray-500 mb-1"># Simple web app — connect only to external</p>
                <p className="text-blue-400">docker network connect offdock-external grafana</p>
              </div>
              <div className="bg-gray-900 rounded-lg px-3 py-2 border border-gray-800">
                <p className="text-gray-500 mb-1"># App + database — app on both, db on internal only</p>
                <p className="text-blue-400">docker network connect offdock-external modtube</p>
                <p className="text-blue-400">docker network connect offdock-internal modtube</p>
                <p className="text-blue-400">docker network connect offdock-internal postgres</p>
              </div>
              <div className="bg-gray-900 rounded-lg px-3 py-2 border border-gray-800">
                <p className="text-gray-500 mb-1"># Test routing by Host header (from any machine on the network)</p>
                <p className="text-green-400">curl -H "Host: grafana.ao.az" http://&lt;server-ip&gt;/</p>
                <p className="text-green-400">curl -H "Host: modtube.local" http://&lt;server-ip&gt;/</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Network card ─────────────────────────────────────────────────────────────
function NetworkCard({
  net, allContainers, onConnect, onDisconnect, onDelete, busy,
}: {
  net: DockerNetwork
  allContainers: ContainerInfo[]
  onConnect: (network: string, container: string) => void
  onDisconnect: (network: string, container: string) => void
  onDelete: (network: string) => void
  busy: string
}) {
  const [selected, setSelected] = useState('')
  const isOffdock = OFFDOCK_NETWORKS.has(net.Name)
  const isSystem = SYSTEM_NETWORKS.has(net.Name)
  const containers = Object.entries(net.Containers ?? {}).map(([id, c]) => ({ id: id.slice(0, 12), name: c.Name, ip: c.IPv4 }))
  const connectedNames = new Set(containers.map(c => c.name))
  const available = allContainers.filter(c => !connectedNames.has(c.Names))
  const isBusy = busy === net.Name

  const subnet = net.IPAM?.Config?.[0]?.Subnet ?? ''

  let borderColor = 'border-gray-800'
  let dotColor = 'bg-gray-600'
  let titleColor = 'text-gray-300'
  if (isOffdock && net.Name === 'offdock-external') { borderColor = 'border-blue-900/50'; dotColor = 'bg-blue-400'; titleColor = 'text-blue-300' }
  if (isOffdock && net.Name === 'offdock-internal') { borderColor = 'border-gray-700'; dotColor = 'bg-gray-400'; titleColor = 'text-gray-300' }

  return (
    <div className={`border ${borderColor} rounded-xl bg-gray-900/40 overflow-hidden`}>
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-gray-800/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
          <span className={`font-mono text-sm font-semibold ${titleColor} truncate`}>{net.Name}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-500 bg-gray-800/60 shrink-0">{net.Driver}</span>
          {isOffdock && <span className="text-[10px] px-1.5 py-0.5 rounded border border-blue-900/50 text-blue-400 bg-blue-950/30 shrink-0">offdock</span>}
          {isSystem && <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-600 shrink-0">system</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {subnet && <span className="font-mono text-[10px] text-gray-600 hidden lg:inline">{subnet}</span>}
          {!isSystem && (
            <button
              onClick={() => onDelete(net.Name)}
              disabled={isBusy || containers.length > 0}
              title={containers.length > 0 ? 'Disconnect all containers first' : 'Delete network'}
              className="text-gray-700 hover:text-red-400 transition-colors text-xs disabled:opacity-30 disabled:cursor-not-allowed">✕</button>
          )}
        </div>
      </div>

      {/* Containers list */}
      <div className="divide-y divide-gray-800/40">
        {containers.length === 0 ? (
          <div className="px-4 py-3 text-xs text-gray-700 italic">No containers connected</div>
        ) : (
          containers.map(c => (
            <div key={c.id} className="flex items-center gap-2.5 px-4 py-2.5 group">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
              <span className="font-mono text-xs text-gray-200 flex-1 truncate">{c.name}</span>
              <span className="font-mono text-[10px] text-gray-600 hidden sm:inline">{c.ip || c.id}</span>
              <button
                onClick={() => onDisconnect(net.Name, c.name)}
                disabled={busy === `${net.Name}:${c.name}`}
                title="Disconnect"
                className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-all disabled:opacity-30 text-xs">
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      {/* Connect form */}
      {!isSystem && (
        <div className="px-4 py-3 border-t border-gray-800/60 flex items-center gap-2">
          <select
            value={selected}
            onChange={e => setSelected(e.target.value)}
            className="flex-1 appearance-none bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500/40">
            <option value="">{available.length === 0 ? 'All containers connected' : 'Connect container…'}</option>
            {available.map(c => (
              <option key={c.Names} value={c.Names}>{c.Names}</option>
            ))}
          </select>
          <button
            onClick={() => { if (selected) { onConnect(net.Name, selected); setSelected('') } }}
            disabled={!selected || isBusy}
            className="px-3 py-1.5 text-xs rounded-lg border border-blue-700/50 text-blue-400 bg-blue-600/10 hover:bg-blue-600/20 transition-colors disabled:opacity-40">
            {isBusy ? '…' : 'Connect'}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Create network form ─────────────────────────────────────────────────────
function CreateNetworkModal({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
  const [name, setName] = useState('')
  const [driver, setDriver] = useState('bridge')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const create = async () => {
    if (!name.trim()) return
    setBusy(true); setErr('')
    try {
      await api.createDockerNetwork(name.trim(), driver)
      onCreated()
      onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-80 shadow-2xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-white">Create Network</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Network name</label>
            <input className="input w-full" placeholder="my-network"
              value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && create()} autoFocus />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Driver</label>
            <select value={driver} onChange={e => setDriver(e.target.value)}
              className="input w-full">
              <option value="bridge">bridge (default)</option>
              <option value="overlay">overlay</option>
              <option value="macvlan">macvlan</option>
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

// ─── Main page ────────────────────────────────────────────────────────────────
export default function NetworksPage() {
  const [nets, setNets] = useState<DockerNetwork[]>([])
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [msgErr, setMsgErr] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [n, cs] = await Promise.all([api.listAllDockerNetworks(), api.listAllContainers()])
      setNets(n ?? [])
      setContainers(cs ?? [])
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const flash = (text: string, err = false) => {
    setMsg(text); setMsgErr(err)
    setTimeout(() => setMsg(''), 3500)
  }

  const connect = async (network: string, container: string) => {
    setBusy(network)
    try {
      await api.dockerNetworkConnect(network, container)
      flash(`${container} → ${network}`)
      load()
    } catch (e) { flash(e instanceof Error ? e.message : 'Failed', true) }
    finally { setBusy('') }
  }

  const disconnect = async (network: string, container: string) => {
    setBusy(`${network}:${container}`)
    try {
      await api.dockerNetworkDisconnect(network, container)
      flash(`Disconnected ${container}`)
      load()
    } catch (e) { flash(e instanceof Error ? e.message : 'Failed', true) }
    finally { setBusy('') }
  }

  const deleteNetwork = async (name: string) => {
    setBusy(name)
    try {
      await api.deleteDockerNetwork(name)
      flash(`Network ${name} deleted`)
      setDeleteTarget(null)
      load()
    } catch (e) { flash(e instanceof Error ? e.message : 'Failed', true) }
    finally { setBusy('') }
  }

  // Separate offdock-managed from user and system networks
  const offdockNets = nets.filter(n => OFFDOCK_NETWORKS.has(n.Name))
  const userNets = nets.filter(n => !OFFDOCK_NETWORKS.has(n.Name) && !SYSTEM_NETWORKS.has(n.Name))
  const systemNets = nets.filter(n => SYSTEM_NETWORKS.has(n.Name))

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Header bar */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-gray-800 bg-gray-950">
        <h1 className="text-sm font-semibold text-gray-100 flex-1">Docker Networks</h1>
        {msg && (
          <span className={`text-xs px-2 py-0.5 rounded border ${msgErr ? 'text-red-300 bg-red-950/50 border-red-900/40' : 'text-green-300 bg-green-950/50 border-green-900/40'}`}>
            {msg}
          </span>
        )}
        <button onClick={load} className="btn-ghost text-xs px-2">↻</button>
        <button onClick={() => setShowCreate(true)} className="btn-primary text-xs">
          + Create Network
        </button>
      </div>

      {showCreate && <CreateNetworkModal onCreated={load} onClose={() => setShowCreate(false)} />}

      {deleteTarget && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setDeleteTarget(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-80 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-semibold text-white">Delete network?</p>
            <p className="text-xs text-gray-500 font-mono">{deleteTarget}</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteTarget(null)} className="btn-ghost text-sm">Cancel</button>
              <button onClick={() => deleteNetwork(deleteTarget)}
                className="text-sm px-4 py-2 rounded-lg bg-red-600/20 text-red-300 border border-red-900/50 hover:bg-red-600/30 transition-colors">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Guide */}
      <NetworkingGuide />

      {/* Network cards */}
      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        {loading ? (
          <div className="text-center py-12 text-gray-600 text-sm">Loading networks…</div>
        ) : (
          <>
            {/* OffDock managed */}
            <div className="space-y-3">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                OffDock Networks
                <span className="text-gray-700 font-normal normal-case">(created automatically)</span>
              </h2>
              {offdockNets.length === 0 ? (
                <p className="text-xs text-gray-700 italic">Not created yet — start nginx to auto-create them.</p>
              ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {offdockNets.map(n => (
                    <NetworkCard key={n.Id} net={n} allContainers={containers}
                      onConnect={connect} onDisconnect={disconnect}
                      onDelete={name => setDeleteTarget(name)} busy={busy} />
                  ))}
                </div>
              )}
            </div>

            {/* User-created */}
            {userNets.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                  Custom Networks
                </h2>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {userNets.map(n => (
                    <NetworkCard key={n.Id} net={n} allContainers={containers}
                      onConnect={connect} onDisconnect={disconnect}
                      onDelete={name => setDeleteTarget(name)} busy={busy} />
                  ))}
                </div>
              </div>
            )}

            {/* System */}
            {systemNets.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-700" />
                  System Networks
                  <span className="text-gray-700 font-normal normal-case">(read-only)</span>
                </h2>
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
                  {systemNets.map(n => (
                    <NetworkCard key={n.Id} net={n} allContainers={containers}
                      onConnect={connect} onDisconnect={disconnect}
                      onDelete={name => setDeleteTarget(name)} busy={busy} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
