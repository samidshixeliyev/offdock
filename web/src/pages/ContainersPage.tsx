import { Fragment, useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { api, ContainerInfo, ContainerStats } from '../api/client'
import XTerminal from '../components/XTerminal'
import ConfirmModal from '../components/ConfirmModal'
import { Page, PageHeader, Panel, EmptyState, ContainerBadge, IconButton } from '../components/ui'
import { useToast } from '../components/Toast'
import { parsePercent } from '../lib/format'
import clsx from 'clsx'
import {
  Container as ContainerIcon, RefreshCw, Search, ScrollText, TerminalSquare,
  RotateCw, Square, Play, Trash2, Download, Maximize2, Minimize2, X, ChevronRight, Layers,
} from 'lucide-react'
import { usePermissions, PERMS } from '../hooks/usePermissions'
import { ReadOnlyBanner } from '../components/ReadOnlyBanner'

// ─── Live Logs Modal ──────────────────────────────────────────────────────────
function LogsModal({ name, onClose }: { name: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [showTs, setShowTs] = useState(false)
  const [follow, setFollow] = useState(true)
  const [tail, setTail] = useState(200)
  const [fullscreen, setFullscreen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  const connect = useCallback((tailN: number) => {
    esRef.current?.close()
    setLines([])
    const es = new EventSource(`/api/v1/containers/${encodeURIComponent(name)}/logs?tail=${tailN}`)
    esRef.current = es
    es.onmessage = e => {
      try { const d = JSON.parse(e.data as string) as { line: string }; setLines(prev => [...prev.slice(-4999), d.line]) } catch {}
    }
    es.onerror = () => es.close()
  }, [name])

  useEffect(() => { connect(tail); return () => esRef.current?.close() }, [name]) // eslint-disable-line
  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [lines, follow])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stripTs = (l: string) => showTs ? l : l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s?/, '')
  const filtered = filter ? lines.filter(l => l.toLowerCase().includes(filter.toLowerCase())) : lines
  const lineColor = (l: string) => {
    const lc = l.toLowerCase()
    if (lc.includes('error') || lc.includes('fatal') || lc.includes('panic')) return 'text-red-400'
    if (lc.includes('warn')) return 'text-amber-400'
    if (lc.includes('info')) return 'text-blue-300'
    if (lc.includes('debug')) return 'text-slate-500'
    return 'text-slate-300'
  }
  const download = () => {
    const text = filtered.map(stripTs).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    a.download = `${name}-logs.txt`; a.click()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-fadeIn" onClick={onClose}>
      <div className={clsx('bg-slate-900 border border-slate-800 flex flex-col shadow-2xl animate-scaleIn',
        fullscreen ? 'fixed inset-0 rounded-none' : 'w-full max-w-6xl rounded-2xl')}
        style={fullscreen ? {} : { height: '86vh' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 shrink-0 flex-wrap">
          <ScrollText className="w-4 h-4 text-blue-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-100">Live Logs</p>
            <p className="text-xs text-slate-500 font-mono truncate">{name}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
              <input className="pl-8 pr-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-100 w-36 focus:outline-none focus:border-blue-500"
                placeholder="Filter…" value={filter} onChange={e => setFilter(e.target.value)} />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
              <input type="checkbox" checked={showTs} onChange={e => setShowTs(e.target.checked)} /> Timestamps
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
              <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} /> Follow
            </label>
            <select className="bg-slate-800 border border-slate-700 rounded-lg text-xs py-1.5 px-2 text-slate-200"
              value={tail} onChange={e => { setTail(Number(e.target.value)); connect(Number(e.target.value)) }}>
              <option value={50}>50 lines</option><option value={200}>200 lines</option>
              <option value={500}>500 lines</option><option value={1000}>1000 lines</option><option value={0}>All</option>
            </select>
            <IconButton icon={RefreshCw} title="Reload" onClick={() => connect(tail)} />
            <IconButton icon={Download} title="Download" onClick={download} />
            <IconButton icon={fullscreen ? Minimize2 : Maximize2} title="Fullscreen" onClick={() => setFullscreen(f => !f)} />
          </div>
          <IconButton icon={X} title="Close" onClick={onClose} />
        </div>
        <div ref={ref} className="flex-1 overflow-y-auto min-h-0 p-4 font-mono text-xs leading-relaxed bg-slate-950">
          {lines.length === 0 ? <span className="text-slate-600 animate-pulse">Connecting…</span>
            : filtered.length === 0 ? <span className="text-slate-600">No lines match "{filter}"</span>
            : filtered.map((l, i) => <div key={i} className={lineColor(stripTs(l))}>{stripTs(l) || ' '}</div>)}
        </div>
        <div className="px-4 py-2 border-t border-slate-800 shrink-0 flex items-center justify-between">
          <span className="text-xs text-slate-500">{filtered.length}{filter ? ` of ${lines.length}` : ''} lines</span>
          <span className="text-xs text-slate-600">ESC to close</span>
        </div>
      </div>
    </div>
  )
}

// ─── Exec terminal modal ──────────────────────────────────────────────────────
function ExecModal({ name, onClose }: { name: string; onClose: () => void }) {
  const [shell, setShell] = useState('sh')
  const [key, setKey] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const wsUrl = `/api/v1/terminal/container/ws?container=${encodeURIComponent(name)}&shell=${shell}`

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !fullscreen) onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose, fullscreen])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-fadeIn" onClick={onClose}>
      <div className={clsx('border border-slate-800 flex flex-col shadow-2xl animate-scaleIn bg-[#0d1117]',
        fullscreen ? 'fixed inset-0 rounded-none' : 'w-full max-w-5xl rounded-2xl')}
        style={fullscreen ? {} : { height: '82vh' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-800 shrink-0 bg-slate-900/60">
          <TerminalSquare className="w-4 h-4 text-emerald-400" />
          <span className="text-xs font-mono flex-1 text-slate-500">
            docker exec -it <span className="text-blue-400">{name}</span> {shell}
          </span>
          <div className="flex items-center gap-1">
            {(['sh', 'bash', 'zsh'] as const).map(s => (
              <button key={s} onClick={() => { setShell(s); setKey(k => k + 1) }}
                className={clsx('text-xs px-2 py-0.5 rounded font-mono transition-colors border',
                  shell === s ? 'bg-blue-500/20 text-blue-300 border-blue-500/30' : 'text-slate-500 hover:text-slate-300 border-slate-700')}>
                {s}
              </button>
            ))}
          </div>
          <IconButton icon={RotateCw} title="Restart shell" onClick={() => setKey(k => k + 1)} />
          <IconButton icon={fullscreen ? Minimize2 : Maximize2} title="Fullscreen" onClick={() => setFullscreen(f => !f)} />
          <IconButton icon={X} title="Close" onClick={onClose} />
        </div>
        <div className="flex-1 min-h-0">
          <XTerminal key={`${name}-${shell}-${key}`} wsUrl={wsUrl} className="w-full h-full" style={{ padding: '8px' }} />
        </div>
      </div>
    </div>
  )
}

// ─── Metrics bar ─────────────────────────────────────────────────────────────
// HealthBadge extracts the Docker healthcheck state from the Status string.
// Docker embeds it as "(healthy)", "(unhealthy)", or "(health: starting)".
function HealthBadge({ status }: { status?: string }) {
  if (!status) return null
  const s = status.toLowerCase()
  if (s.includes('(healthy)'))
    return <span className="ml-1.5 inline-flex items-center text-[9px] font-semibold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5">healthy</span>
  if (s.includes('(unhealthy)'))
    return <span className="ml-1.5 inline-flex items-center text-[9px] font-semibold uppercase tracking-wider text-red-400 bg-red-500/10 border border-red-500/20 rounded px-1.5 py-0.5">unhealthy</span>
  if (s.includes('health: starting') || s.includes('(starting)'))
    return <span className="ml-1.5 inline-flex items-center text-[9px] font-semibold uppercase tracking-wider text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">starting</span>
  return null
}

function MetricsBar({ stat }: { stat: ContainerStats }) {
  const cpu = parsePercent(stat.CPUPerc), mem = parsePercent(stat.MemPerc)
  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="text-slate-500 w-7">CPU</span>
        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden w-14">
          <div className={clsx('h-full rounded-full', cpu > 80 ? 'bg-red-500' : cpu > 50 ? 'bg-amber-500' : 'bg-blue-500')} style={{ width: `${Math.min(cpu, 100)}%` }} />
        </div>
        <span className="text-slate-400 tabular-nums w-12 text-right">{stat.CPUPerc}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-slate-500 w-7">MEM</span>
        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden w-14">
          <div className={clsx('h-full rounded-full', mem > 80 ? 'bg-red-500' : mem > 60 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(mem, 100)}%` }} />
        </div>
        <span className="text-slate-400 tabular-nums w-12 text-right">{stat.MemPerc}</span>
      </div>
    </div>
  )
}

type StateFilter = 'all' | 'running' | 'restarting' | 'exited'

// ─── Main page ────────────────────────────────────────────────────────────────
// stackOf returns the compose project ("stack") a container belongs to, parsed
// from its docker labels, or a custom group set by the operator, else '(ungrouped)'.
function stackOf(c: ContainerInfo, manual: Record<string, string>): string {
  if (manual[c.Names]) return manual[c.Names]
  const labels = c.Labels ?? ''
  for (const kv of labels.split(',')) {
    if (kv.startsWith('com.docker.compose.project=')) return kv.slice('com.docker.compose.project='.length)
  }
  return '(ungrouped)'
}

const MANUAL_GROUPS_KEY = 'offdock.container.groups'

export default function ContainersPage() {
  const toast = useToast()
  const { can } = usePermissions()
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [stats, setStats] = useState<Record<string, ContainerStats>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [groupByStack, setGroupByStack] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Manual group assignments (container name → group), persisted in the browser.
  const [manualGroups, setManualGroups] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(MANUAL_GROUPS_KEY) || '{}') } catch { return {} }
  })
  const setManualGroup = (name: string, group: string) => setManualGroups(prev => {
    const next = { ...prev }
    if (group.trim()) next[name] = group.trim(); else delete next[name]
    localStorage.setItem(MANUAL_GROUPS_KEY, JSON.stringify(next))
    return next
  })
  const [actionBusy, setActionBusy] = useState('')
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [execFor, setExecFor] = useState<string | null>(null)
  const [deleteFor, setDeleteFor] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const statsTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = async () => {
    setLoading(true)
    try { setContainers(await api.listAllContainers()) } catch {}
    setLoading(false)
  }
  const loadStats = async () => {
    try {
      const s = await api.containerStats()
      const map: Record<string, ContainerStats> = {}
      for (const st of s) map[st.name] = st
      setStats(map)
    } catch {}
  }

  useEffect(() => {
    load(); loadStats()
    statsTimer.current = setInterval(loadStats, 4000)
    return () => { if (statsTimer.current) clearInterval(statsTimer.current) }
  }, [])

  const doAction = async (name: string, action: 'restart' | 'stop' | 'start') => {
    setActionBusy(name + ':' + action)
    try { await api.globalContainerAction(name, action); toast.success(`${action} → ${name}`); setTimeout(load, 1200) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Action failed') }
    setActionBusy('')
  }
  const doDelete = async (name: string) => {
    setDeleteFor(null); setActionBusy(name + ':delete')
    try { await api.deleteContainer(name); toast.success(`Deleted ${name}`); setSelected(s => { const n = new Set(s); n.delete(name); return n }); await load() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed') }
    setActionBusy('')
  }
  const doBulk = async (action: 'stop' | 'start' | 'restart') => {
    for (const name of selected) { try { await api.globalContainerAction(name, action) } catch {} }
    toast.success(`${action} applied to ${selected.size} container(s)`)
    setSelected(new Set()); setTimeout(load, 1200)
  }

  const toggleSelect = (name: string) => setSelected(s => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n })

  const filtered = useMemo(() => containers.filter(c => {
    const q = search.toLowerCase()
    const matchSearch = !q || c.Names.toLowerCase().includes(q) || c.Image.toLowerCase().includes(q)
    const st = c.State?.toLowerCase()
    const matchState = stateFilter === 'all' || st === stateFilter
    return matchSearch && matchState
  }), [containers, search, stateFilter])

  const counts = useMemo(() => ({
    all: containers.length,
    running: containers.filter(c => c.State?.toLowerCase() === 'running').length,
    restarting: containers.filter(c => c.State?.toLowerCase() === 'restarting').length,
    exited: containers.filter(c => c.State?.toLowerCase() === 'exited').length,
  }), [containers])

  // Group filtered containers into stacks (compose project or manual group).
  const groups = useMemo(() => {
    const m = new Map<string, ContainerInfo[]>()
    for (const c of filtered) {
      const g = stackOf(c, manualGroups)
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(c)
    }
    // Sort: named stacks first (alpha), '(ungrouped)' last.
    return Array.from(m.entries()).sort((a, b) => {
      if (a[0] === '(ungrouped)') return 1
      if (b[0] === '(ungrouped)') return -1
      return a[0].localeCompare(b[0])
    })
  }, [filtered, manualGroups])

  const allSelected = selected.size === filtered.length && filtered.length > 0
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(filtered.map(c => c.Names)))
  const toggleCollapse = (g: string) => setCollapsed(s => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n })
  const stackAction = async (members: ContainerInfo[], action: 'start' | 'stop' | 'restart') => {
    for (const c of members) { await doAction(c.Names, action) }
  }

  const renderRow = (c: ContainerInfo) => {
    const isRunning = c.State?.toLowerCase() === 'running'
    const isBusy = actionBusy.startsWith(c.Names + ':')
    const isSelected = selected.has(c.Names)
    const stat = stats[c.Names]
    return (
      <tr key={c.ID} className={clsx('border-b border-slate-800/50 last:border-0 transition-colors', isSelected ? 'bg-blue-500/5' : 'hover:bg-slate-800/30')}>
        <td className="px-4 py-3"><input type="checkbox" className="rounded border-slate-600 bg-slate-800 cursor-pointer" checked={isSelected} onChange={() => toggleSelect(c.Names)} /></td>
        <td className="px-4 py-3">
          <span className="font-mono text-sm text-slate-200 font-medium">{c.Names}</span>
          <button
            title="Assign this container to a custom group (stored in your browser)"
            onClick={() => { const g = window.prompt('Custom group for ' + c.Names + ' (blank to clear):', manualGroups[c.Names] ?? ''); if (g !== null) setManualGroup(c.Names, g) }}
            className="ml-2 text-[10px] text-slate-600 hover:text-blue-400">⊕ group</button>
        </td>
        <td className="px-4 py-3 text-xs text-slate-500 font-mono max-w-[200px]"><span className="truncate block" title={c.Image}>{c.Image}</span></td>
        <td className="px-4 py-3">
          <ContainerBadge state={c.State} status={c.Status} />
          <HealthBadge status={c.Status} />
        </td>
        <td className="px-4 py-3 text-xs text-slate-500 font-mono max-w-[160px] hidden lg:table-cell"><span className="truncate block" title={c.Ports}>{c.Ports || '—'}</span></td>
        <td className="px-4 py-3 hidden xl:table-cell">{stat ? <MetricsBar stat={stat} /> : <span className="text-xs text-slate-600">{isRunning ? 'collecting…' : '—'}</span>}</td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-0.5 justify-end">
            <IconButton icon={ScrollText} title="Logs" onClick={() => setLogsFor(c.Names)} />
            {isRunning && can(PERMS.terminal) && <IconButton icon={TerminalSquare} title="Exec shell" onClick={() => setExecFor(c.Names)} />}
            <IconButton icon={RotateCw} title={can(PERMS.containerOps) ? 'Restart' : 'Restart (no permission)'} disabled={isBusy || !can(PERMS.containerOps)} onClick={() => can(PERMS.containerOps) && doAction(c.Names, 'restart')} />
            {isRunning
              ? <IconButton icon={Square} title={can(PERMS.containerOps) ? 'Stop' : 'Stop (no permission)'} disabled={isBusy || !can(PERMS.containerOps)} onClick={() => can(PERMS.containerOps) && doAction(c.Names, 'stop')} />
              : <IconButton icon={Play} tone="success" title={can(PERMS.containerOps) ? 'Start' : 'Start (no permission)'} disabled={isBusy || !can(PERMS.containerOps)} onClick={() => can(PERMS.containerOps) && doAction(c.Names, 'start')} />}
            <IconButton icon={Trash2} tone="danger" title={can(PERMS.containerOps) ? 'Delete' : 'Delete (no permission)'} disabled={isBusy || !can(PERMS.containerOps)} onClick={() => can(PERMS.containerOps) && setDeleteFor(c.Names)} />
          </div>
        </td>
      </tr>
    )
  }

  const filterTabs: { id: StateFilter; label: string }[] = [
    { id: 'all', label: 'All' }, { id: 'running', label: 'Running' },
    { id: 'restarting', label: 'Restarting' }, { id: 'exited', label: 'Exited' },
  ]

  return (
    <Page>
      {!can(PERMS.containerOps) && <ReadOnlyBanner message="You don't have permission to manage containers. Viewing in read-only mode." />}
      {logsFor && <LogsModal name={logsFor} onClose={() => setLogsFor(null)} />}
      {execFor && can(PERMS.terminal) && <ExecModal name={execFor} onClose={() => setExecFor(null)} />}
      {deleteFor && (
        <ConfirmModal title="Delete container?" danger confirmLabel="Delete"
          message={`This force-removes ${deleteFor}. Unsaved data inside the container will be lost.`}
          onConfirm={() => doDelete(deleteFor)} onCancel={() => setDeleteFor(null)} />
      )}

      <PageHeader
        title="Containers" icon={ContainerIcon}
        subtitle={`${counts.running} running${counts.restarting ? ` · ${counts.restarting} restarting` : ''}${counts.exited ? ` · ${counts.exited} exited` : ''} · ${counts.all} total`}
        actions={<button onClick={load} className="btn-secondary"><RefreshCw className="w-4 h-4" /> Refresh</button>}
      />

      <Panel>
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input className="pl-9 pr-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 w-56 focus:outline-none focus:border-blue-500"
                placeholder="Search name or image…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div className="flex items-center gap-1 p-1 bg-slate-800 rounded-lg">
              {filterTabs.map(f => (
                <button key={f.id} onClick={() => setStateFilter(f.id)}
                  className={clsx('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all',
                    stateFilter === f.id ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200')}>
                  {f.label}
                  <span className="tabular-nums text-slate-500">{counts[f.id]}</span>
                </button>
              ))}
            </div>
            <button onClick={() => setGroupByStack(g => !g)}
              title="Group containers by their compose project (stack)"
              className={clsx('inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border',
                groupByStack ? 'bg-blue-500/10 border-blue-500/30 text-blue-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200')}>
              <Layers className="w-3.5 h-3.5" /> Stacks
            </button>
          </div>
          {selected.size > 0 && can(PERMS.containerOps) && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">{selected.size} selected</span>
              <button onClick={() => doBulk('start')} className="text-xs px-2 py-1 rounded border border-slate-700 text-emerald-400 hover:bg-emerald-500/10">Start</button>
              <button onClick={() => doBulk('stop')} className="text-xs px-2 py-1 rounded border border-slate-700 text-amber-400 hover:bg-amber-500/10">Stop</button>
              <button onClick={() => doBulk('restart')} className="text-xs px-2 py-1 rounded border border-slate-700 text-blue-400 hover:bg-blue-500/10">Restart</button>
              <IconButton icon={X} title="Clear selection" onClick={() => setSelected(new Set())} />
            </div>
          )}
        </div>

        {loading ? (
          <div className="p-4 space-y-2">{[0,1,2,3,4].map(i => <div key={i} className="h-12 skeleton rounded-lg" />)}</div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={ContainerIcon}
            title={containers.length === 0 ? 'No containers' : 'No matching containers'}
            description={containers.length === 0 ? 'Deploy a project to create containers.' : 'Adjust your search or filter.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px]">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="px-4 py-3 w-8"><input type="checkbox" className="rounded border-slate-600 bg-slate-800 cursor-pointer" checked={allSelected} onChange={toggleAll} /></th>
                  <th className="th text-left">Name</th>
                  <th className="th text-left">Image</th>
                  <th className="th text-left">Status</th>
                  <th className="th text-left hidden lg:table-cell">Ports</th>
                  <th className="th text-left hidden xl:table-cell">Metrics</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {groupByStack
                  ? groups.map(([g, members]) => {
                    const isCollapsed = collapsed.has(g)
                    const runningInStack = members.filter(c => c.State?.toLowerCase() === 'running').length
                    return (
                      <Fragment key={g}>
                        <tr className="bg-slate-900/70 border-b border-slate-800">
                          <td colSpan={7} className="px-4 py-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <button onClick={() => toggleCollapse(g)} className="flex items-center gap-1.5 text-slate-200 hover:text-white">
                                <ChevronRight className={clsx('w-3.5 h-3.5 transition-transform', !isCollapsed && 'rotate-90')} />
                                <span className={clsx('text-xs font-semibold', g === '(ungrouped)' ? 'text-slate-500' : 'text-slate-200')}>{g}</span>
                              </button>
                              <span className="text-[10px] text-slate-500">{runningInStack}/{members.length} running</span>
                              {can(PERMS.containerOps) && g !== '(ungrouped)' && (
                                <div className="flex items-center gap-1 ml-2">
                                  <button onClick={() => stackAction(members, 'start')} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20">Start all</button>
                                  <button onClick={() => stackAction(members, 'restart')} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 hover:bg-slate-700">Restart all</button>
                                  <button onClick={() => stackAction(members, 'stop')} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20">Stop all</button>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                        {!isCollapsed && members.map(c => renderRow(c))}
                      </Fragment>
                    )
                  })
                  : filtered.map(c => renderRow(c))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </Page>
  )
}
