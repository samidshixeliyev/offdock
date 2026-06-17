import { useEffect, useState } from 'react'
import { api, DockerNetwork, ContainerInfo } from '../api/client'
import { Page, PageHeader, Panel, Alert } from '../components/ui'
import { Modal } from '../components/Modal'
import ConfirmModal from '../components/ConfirmModal'
import { useToast } from '../components/Toast'
import clsx from 'clsx'
import {
  Network, Plus, RefreshCw, Trash2, Plug, Unplug, ChevronDown, Info,
} from 'lucide-react'

const OFFDOCK_NETWORKS = new Set(['offdock-external', 'offdock-internal'])
const SYSTEM_NETWORKS = new Set(['bridge', 'host', 'none'])

// ─── Collapsible networking guide ─────────────────────────────────────────────
function NetworkingGuide() {
  const [open, setOpen] = useState(false)
  return (
    <Panel className="mb-5">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800/30 transition-colors rounded-t-xl">
        <div className="flex items-center gap-2">
          <Info className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-medium text-slate-200">How OffDock routing works</span>
        </div>
        <ChevronDown className={clsx('w-4 h-4 text-slate-500 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-4 text-xs text-slate-400 leading-relaxed border-t border-slate-800 pt-4">
          <div className="bg-slate-950 rounded-lg border border-slate-800 p-3 font-mono text-[11px] space-y-1.5">
            <p className="text-slate-500 mb-2">Request flow:</p>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-blue-400">Browser</span><span className="text-slate-600">— grafana.ao.az →</span>
              <span className="text-amber-400">nginx:80</span><span className="text-slate-600">→</span>
              <span className="text-emerald-400">offdock-external</span><span className="text-slate-600">→</span>
              <span className="text-violet-400">grafana:3000</span>
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-3 space-y-1.5">
              <p className="font-semibold text-blue-300 flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-blue-400" /> offdock-external</p>
              <p>Connect web apps, APIs and dashboards that nginx must reach. nginx resolves the container name in your upstream field via this network's DNS.</p>
            </div>
            <div className="bg-slate-800/30 border border-slate-700/40 rounded-lg p-3 space-y-1.5">
              <p className="font-semibold text-slate-300 flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-slate-400" /> offdock-internal</p>
              <p>Connect backend services (databases, caches) that must NOT be reachable from nginx. Apps can join both networks.</p>
            </div>
          </div>
        </div>
      )}
    </Panel>
  )
}

// ─── Network card ─────────────────────────────────────────────────────────────
function NetworkCard({ net, allContainers, onConnect, onDisconnect, onDelete, busy }: {
  net: DockerNetwork; allContainers: ContainerInfo[]
  onConnect: (n: string, c: string) => void; onDisconnect: (n: string, c: string) => void
  onDelete: (n: string) => void; busy: string
}) {
  const [selected, setSelected] = useState('')
  const isOffdock = OFFDOCK_NETWORKS.has(net.Name)
  const isSystem = SYSTEM_NETWORKS.has(net.Name)
  const containers = Object.entries(net.Containers ?? {}).map(([id, c]) => ({ id: id.slice(0, 12), name: c.Name, ip: c.IPv4 }))
  const connectedNames = new Set(containers.map(c => c.name))
  const available = allContainers.filter(c => !connectedNames.has(c.Names))
  const isBusy = busy === net.Name
  const subnet = net.IPAM?.Config?.[0]?.Subnet ?? ''
  const accent = net.Name === 'offdock-external' ? 'bg-blue-400' : isOffdock ? 'bg-slate-400' : isSystem ? 'bg-slate-700' : 'bg-emerald-400'

  return (
    <div className="border border-slate-800 rounded-xl bg-slate-900 overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-slate-800">
        <div className="flex items-center gap-2 min-w-0">
          <span className={clsx('w-2 h-2 rounded-full shrink-0', accent)} />
          <span className="font-mono text-sm font-semibold text-slate-200 truncate">{net.Name}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-500 shrink-0">{net.Driver}</span>
          {isOffdock && <span className="text-[10px] px-1.5 py-0.5 rounded border border-blue-500/30 text-blue-400 bg-blue-500/10 shrink-0">offdock</span>}
          {isSystem && <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-600 shrink-0">system</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {subnet && <span className="font-mono text-[10px] text-slate-600 hidden lg:inline">{subnet}</span>}
          {!isSystem && (
            <button onClick={() => onDelete(net.Name)} disabled={isBusy || containers.length > 0}
              title={containers.length > 0 ? 'Disconnect all containers first' : 'Delete network'}
              className="text-slate-600 hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      <div className="divide-y divide-slate-800/50">
        {containers.length === 0 ? (
          <div className="px-4 py-3 text-xs text-slate-600 italic">No containers connected</div>
        ) : containers.map(c => (
          <div key={c.id} className="flex items-center gap-2.5 px-4 py-2.5 group">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
            <span className="font-mono text-xs text-slate-200 flex-1 truncate">{c.name}</span>
            <span className="font-mono text-[10px] text-slate-600 hidden sm:inline">{c.ip || c.id}</span>
            <button onClick={() => onDisconnect(net.Name, c.name)} disabled={busy === `${net.Name}:${c.name}`} title="Disconnect"
              className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 transition-all disabled:opacity-30">
              <Unplug className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
      {!isSystem && (
        <div className="px-4 py-3 border-t border-slate-800 flex items-center gap-2">
          <div className="relative flex-1">
            <select value={selected} onChange={e => setSelected(e.target.value)}
              className="w-full appearance-none bg-slate-800 border border-slate-700 rounded-lg pl-3 pr-8 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-blue-500">
              <option value="">{available.length === 0 ? 'All containers connected' : 'Connect container…'}</option>
              {available.map(c => <option key={c.Names} value={c.Names}>{c.Names}</option>)}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
          </div>
          <button onClick={() => { if (selected) { onConnect(net.Name, selected); setSelected('') } }} disabled={!selected || isBusy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-blue-500/40 text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 transition-colors disabled:opacity-40">
            <Plug className="w-3.5 h-3.5" /> Connect
          </button>
        </div>
      )}
    </div>
  )
}

function CreateNetworkModal({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [driver, setDriver] = useState('bridge')
  const [subnet, setSubnet] = useState('')
  const [gateway, setGateway] = useState('')
  const [ipRange, setIpRange] = useState('')
  const [internal, setInternal] = useState(false)
  const [attachable, setAttachable] = useState(false)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await api.createDockerNetworkIPAM({
        name: name.trim(), driver,
        subnet: subnet.trim() || undefined,
        gateway: gateway.trim() || undefined,
        ip_range: ipRange.trim() || undefined,
        internal, attachable,
      })
      toast.success(`Created ${name.trim()}`); onCreated(); onClose()
    }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
    finally { setBusy(false) }
  }

  return (
    <Modal open onClose={onClose} title="Create Network" icon={Network} size="sm"
      footer={<>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button onClick={create} disabled={!name.trim() || busy} className="btn-primary">{busy ? 'Creating…' : 'Create'}</button>
      </>}>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-slate-500 mb-1.5">Network name</label>
          <input className="input" placeholder="my-network" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} autoFocus />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1.5">Driver</label>
          <select value={driver} onChange={e => setDriver(e.target.value)} className="select">
            <option value="bridge">bridge (default)</option>
            <option value="overlay">overlay</option>
            <option value="macvlan">macvlan</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Subnet (optional)</label>
            <input className="input" placeholder="172.28.0.0/16" value={subnet} onChange={e => setSubnet(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Gateway (optional)</label>
            <input className="input" placeholder="172.28.0.1" value={gateway} onChange={e => setGateway(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1.5">IP range (optional)</label>
          <input className="input" placeholder="172.28.5.0/24" value={ipRange} onChange={e => setIpRange(e.target.value)} />
        </div>
        <div className="flex items-center gap-4">
          <label className="inline-flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} />Internal (no external access)</label>
          <label className="inline-flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={attachable} onChange={e => setAttachable(e.target.checked)} />Attachable</label>
        </div>
      </div>
    </Modal>
  )
}

export default function NetworksPage() {
  const toast = useToast()
  const [nets, setNets] = useState<DockerNetwork[]>([])
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [n, cs] = await Promise.all([api.listAllDockerNetworks(), api.listAllContainers()])
      setNets(n ?? []); setContainers(cs ?? [])
    } catch {}
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const connect = async (network: string, container: string) => {
    setBusy(network)
    try { await api.dockerNetworkConnect(network, container); toast.success(`${container} → ${network}`); load() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') } finally { setBusy('') }
  }
  const disconnect = async (network: string, container: string) => {
    setBusy(`${network}:${container}`)
    try { await api.dockerNetworkDisconnect(network, container); toast.success(`Disconnected ${container}`); load() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') } finally { setBusy('') }
  }
  const deleteNetwork = async (name: string) => {
    setBusy(name)
    try { await api.deleteDockerNetwork(name); toast.success(`Deleted ${name}`); setDeleteTarget(null); load() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') } finally { setBusy('') }
  }

  const offdockNets = nets.filter(n => OFFDOCK_NETWORKS.has(n.Name))
  const userNets = nets.filter(n => !OFFDOCK_NETWORKS.has(n.Name) && !SYSTEM_NETWORKS.has(n.Name))
  const systemNets = nets.filter(n => SYSTEM_NETWORKS.has(n.Name))

  const Section = ({ title, hint, list, cols = 2 }: { title: string; hint?: string; list: DockerNetwork[]; cols?: number }) => (
    <div className="space-y-3">
      <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
        {title}{hint && <span className="text-slate-600 font-normal normal-case">{hint}</span>}
      </h2>
      <div className={clsx('grid grid-cols-1 gap-3', cols === 3 ? 'xl:grid-cols-3' : 'xl:grid-cols-2')}>
        {list.map(n => (
          <NetworkCard key={n.Id} net={n} allContainers={containers} onConnect={connect} onDisconnect={disconnect} onDelete={setDeleteTarget} busy={busy} />
        ))}
      </div>
    </div>
  )

  return (
    <Page>
      <PageHeader title="Networks" subtitle="Connect containers to Docker networks" icon={Network}
        actions={<>
          <button onClick={load} className="btn-secondary"><RefreshCw className="w-4 h-4" /> Refresh</button>
          <button onClick={() => setShowCreate(true)} className="btn-primary"><Plus className="w-4 h-4" /> Create Network</button>
        </>} />

      {showCreate && <CreateNetworkModal onCreated={load} onClose={() => setShowCreate(false)} />}
      {deleteTarget && (
        <ConfirmModal title="Delete network?" danger confirmLabel="Delete"
          message={`Permanently remove the network "${deleteTarget}".`}
          onConfirm={() => deleteNetwork(deleteTarget)} onCancel={() => setDeleteTarget(null)} />
      )}

      <NetworkingGuide />

      {loading ? (
        <div className="grid xl:grid-cols-2 gap-3">{[0,1,2,3].map(i => <div key={i} className="h-40 skeleton rounded-xl" />)}</div>
      ) : (
        <div className="space-y-6">
          {offdockNets.length > 0
            ? <Section title="OffDock Networks" hint="(auto-created)" list={offdockNets} />
            : <Alert tone="info">OffDock networks not created yet — start nginx to auto-create <code>offdock-external</code> and <code>offdock-internal</code>.</Alert>}
          {userNets.length > 0 && <Section title="Custom Networks" list={userNets} />}
          {systemNets.length > 0 && <Section title="System Networks" hint="(read-only)" list={systemNets} cols={3} />}
        </div>
      )}
    </Page>
  )
}
