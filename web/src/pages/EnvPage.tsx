import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, EnvVar, EnvVarSet } from '../api/client'
import { Page, PageHeader, Panel, EmptyState, IconButton } from '../components/ui'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { timeAgo } from '../lib/format'
import clsx from 'clsx'
import {
  KeyRound, Plus, Save, Trash2, Eye, EyeOff, Search, FileUp, History,
  RotateCcw, GitCompare, Lock, Loader2,
} from 'lucide-react'

interface EditableVar extends EnvVar { revealed: boolean }

// Parse pasted .env text into key/value pairs.
function parseDotEnv(text: string): EnvVar[] {
  const out: EnvVar[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    let key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) out.push({ key, value, is_secret: /secret|password|token|key|api/i.test(key) })
  }
  return out
}

// ─── Import .env modal ──────────────────────────────────────────────────────────
function ImportModal({ onImport, onClose }: { onImport: (vars: EnvVar[], replace: boolean) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [replace, setReplace] = useState(false)
  const parsed = useMemo(() => parseDotEnv(text), [text])
  return (
    <Modal open onClose={onClose} title="Import .env" subtitle="Paste KEY=VALUE lines" icon={FileUp} size="lg"
      footer={<>
        <label className="flex items-center gap-2 text-xs text-slate-400 mr-auto cursor-pointer">
          <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} /> Replace all existing
        </label>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button onClick={() => onImport(parsed, replace)} disabled={parsed.length === 0} className="btn-primary">Import {parsed.length || ''}</button>
      </>}>
      <textarea value={text} onChange={e => setText(e.target.value)} autoFocus rows={10}
        placeholder={'DATABASE_URL=postgres://...\nAPI_KEY=secret123\n# comments ignored'}
        className="input font-mono text-xs resize-none" />
      {parsed.length > 0 && <p className="text-xs text-slate-500 mt-2">{parsed.length} variable(s) detected · keys matching secret/password/token/key/api auto-flagged as secret.</p>}
    </Modal>
  )
}

// ─── History / diff modal ──────────────────────────────────────────────────────
function HistoryModal({ projectId, current, onRestore, onClose }: {
  projectId: string; current: EnvVar[]; onRestore: (set: EnvVarSet) => void; onClose: () => void
}) {
  const toast = useToast()
  const [history, setHistory] = useState<EnvVarSet[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<EnvVarSet | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => { api.envHistory(projectId).then(h => { setHistory(h ?? []); setSelected((h ?? [])[0] ?? null) }).finally(() => setLoading(false)) }, [projectId])

  const diff = useMemo(() => {
    if (!selected) return []
    const curMap = new Map(current.map(v => [v.key, v.value]))
    const selMap = new Map(selected.vars.map(v => [v.key, v.value]))
    const keys = Array.from(new Set([...curMap.keys(), ...selMap.keys()])).sort()
    return keys.map(k => {
      const inCur = curMap.has(k), inSel = selMap.has(k)
      let state: 'same' | 'added' | 'removed' | 'changed' = 'same'
      if (inCur && !inSel) state = 'added'        // in current editor, not in this version
      else if (!inCur && inSel) state = 'removed' // in this version, not in current
      else if (curMap.get(k) !== selMap.get(k)) state = 'changed'
      return { key: k, state, selVal: selMap.get(k), curVal: curMap.get(k) }
    })
  }, [selected, current])

  const restore = async () => {
    if (!selected) return
    setRestoring(true)
    try { const set = await api.restoreEnv(projectId, selected.version); toast.success(`Restored v${selected.version} as v${set.version}`); onRestore(set) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Restore failed') } finally { setRestoring(false) }
  }

  return (
    <Modal open onClose={onClose} title="Version History" icon={History} size="xl"
      footer={selected && <>
        <span className="text-xs text-slate-500 mr-auto">Diff: this version vs current editor</span>
        <button onClick={onClose} className="btn-secondary">Close</button>
        <button onClick={restore} disabled={restoring} className="btn-primary"><RotateCcw className="w-4 h-4" /> {restoring ? 'Restoring…' : `Restore v${selected.version}`}</button>
      </>}>
      {loading ? <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-slate-500" /></div>
        : history.length === 0 ? <EmptyState icon={History} title="No versions yet" description="Save the env vars to create the first version." />
        : (
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {history.map(s => (
                <button key={s.id} onClick={() => setSelected(s)}
                  className={clsx('w-full text-left px-3 py-2 rounded-lg border transition-colors', selected?.id === s.id ? 'bg-slate-800 border-slate-600' : 'border-slate-800 hover:bg-slate-800/50')}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-200">Version {s.version}</span>
                    <span className="text-xs text-slate-500">{s.vars.length} vars</span>
                  </div>
                  <span className="text-xs text-slate-500">{timeAgo(s.created_at)}</span>
                </button>
              ))}
            </div>
            <div className="col-span-2 max-h-96 overflow-y-auto">
              {selected && (
                <div className="border border-slate-800 rounded-lg divide-y divide-slate-800">
                  {diff.map(d => (
                    <div key={d.key} className={clsx('flex items-center gap-2 px-3 py-1.5 text-xs font-mono',
                      d.state === 'changed' && 'bg-amber-500/5', d.state === 'added' && 'bg-emerald-500/5', d.state === 'removed' && 'bg-red-500/5')}>
                      <GitCompare className={clsx('w-3 h-3 shrink-0',
                        d.state === 'same' ? 'text-slate-700' : d.state === 'changed' ? 'text-amber-400' : d.state === 'added' ? 'text-emerald-400' : 'text-red-400')} />
                      <span className="text-slate-300 w-40 truncate">{d.key}</span>
                      <span className="text-slate-500 truncate flex-1">{d.selVal === '********' ? '••••••' : d.selVal ?? <span className="text-slate-700 italic">absent</span>}</span>
                      {d.state !== 'same' && <span className={clsx('text-[10px] px-1.5 rounded shrink-0',
                        d.state === 'changed' ? 'text-amber-400' : d.state === 'added' ? 'text-emerald-400' : 'text-red-400')}>
                        {d.state === 'added' ? 'not in version' : d.state === 'removed' ? 'only in version' : 'changed'}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
    </Modal>
  )
}

// ─── Main page ──────────────────────────────────────────────────────────────────
export default function EnvPage() {
  const { id } = useParams<{ id: string }>()
  const toast = useToast()
  const [vars, setVars] = useState<EditableVar[]>([])
  const [version, setVersion] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [dirty, setDirty] = useState(false)

  const loadFrom = (s: EnvVarSet | null) => {
    setVars((s?.vars ?? []).map(v => ({ ...v, revealed: false })))
    setVersion(s?.version ?? null)
    setDirty(false)
  }
  useEffect(() => { if (id) api.getEnv(id).then(loadFrom).catch(() => {}) }, [id])

  const mutate = (fn: (v: EditableVar[]) => EditableVar[]) => { setVars(fn); setDirty(true) }
  const addVar = () => mutate(v => [...v, { key: '', value: '', is_secret: false, revealed: true }])
  const removeVar = (i: number) => mutate(v => v.filter((_, idx) => idx !== i))
  const updateVar = (i: number, field: keyof EnvVar, value: string | boolean) => mutate(v => v.map((e, idx) => idx === i ? { ...e, [field]: value } : e))
  const toggleReveal = (i: number) => setVars(v => v.map((e, idx) => idx === i ? { ...e, revealed: !e.revealed } : e))

  const onImport = (imported: EnvVar[], replace: boolean) => {
    mutate(v => {
      const base = replace ? [] : v
      const existing = new Map(base.map(e => [e.key, e]))
      for (const iv of imported) existing.set(iv.key, { ...iv, revealed: false })
      return Array.from(existing.values())
    })
    setShowImport(false)
    toast.success(`Imported ${imported.length} variable(s)`)
  }

  const save = async () => {
    if (!id) return
    setSaving(true)
    try {
      const payload = vars.map(({ key, value, is_secret }) => ({ key, value, is_secret }))
      const set = await api.saveEnv(id, payload)
      loadFrom(set)
      toast.success(`Saved as version ${set.version}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed') } finally { setSaving(false) }
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return vars.map((v, i) => ({ v, i })).filter(({ v }) => !q || v.key.toLowerCase().includes(q))
  }, [vars, search])

  const secretCount = vars.filter(v => v.is_secret).length

  return (
    <Page>
      <PageHeader title="Environment Variables" icon={KeyRound}
        subtitle={`${vars.length} variable${vars.length !== 1 ? 's' : ''}${secretCount ? ` · ${secretCount} secret` : ''}${version ? ` · v${version}` : ''}${dirty ? ' · unsaved changes' : ''}`}
        actions={<>
          <button onClick={() => setShowHistory(true)} className="btn-secondary"><History className="w-4 h-4" /> History</button>
          <button onClick={() => setShowImport(true)} className="btn-secondary"><FileUp className="w-4 h-4" /> Import</button>
          <button onClick={save} disabled={saving || !dirty} className="btn-primary">{saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : <><Save className="w-4 h-4" /> Save Version</>}</button>
        </>} />

      {showImport && <ImportModal onImport={onImport} onClose={() => setShowImport(false)} />}
      {showHistory && id && <HistoryModal projectId={id} current={vars.map(({ key, value, is_secret }) => ({ key, value, is_secret }))} onRestore={(s) => { loadFrom(s); setShowHistory(false) }} onClose={() => setShowHistory(false)} />}

      <Panel
        title="Variables" icon={KeyRound}
        actions={<>
          {vars.length > 0 && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter keys…"
                className="w-40 pl-8 pr-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-100 focus:outline-none focus:border-blue-500" />
            </div>
          )}
          <button onClick={addVar} className="btn-secondary text-xs"><Plus className="w-3.5 h-3.5" /> Add</button>
        </>}>
        {vars.length === 0 ? (
          <EmptyState icon={KeyRound} title="No variables" description="Add variables one by one, or import a .env file."
            action={<div className="flex gap-2"><button onClick={addVar} className="btn-primary"><Plus className="w-4 h-4" /> Add variable</button><button onClick={() => setShowImport(true)} className="btn-secondary"><FileUp className="w-4 h-4" /> Import .env</button></div>} />
        ) : (
          <div className="divide-y divide-slate-800">
            {filtered.map(({ v, i }) => (
              <div key={i} className="flex flex-wrap sm:flex-nowrap items-center gap-3 px-4 py-2.5">
                <input className="input font-mono text-xs w-full sm:w-52 shrink-0" placeholder="KEY" value={v.key} onChange={e => updateVar(i, 'key', e.target.value.toUpperCase())} />
                <div className="flex-1 relative">
                  <input className="input font-mono text-xs pr-9" placeholder="value"
                    type={v.is_secret && !v.revealed ? 'password' : 'text'} value={v.value} onChange={e => updateVar(i, 'value', e.target.value)} />
                  {v.is_secret && (
                    <button type="button" onClick={() => toggleReveal(i)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                      {v.revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  )}
                </div>
                <button onClick={() => updateVar(i, 'is_secret', !v.is_secret)} title={v.is_secret ? 'Secret' : 'Plain'}
                  className={clsx('inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border shrink-0 transition-colors',
                    v.is_secret ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' : 'text-slate-500 border-slate-700 hover:text-slate-300')}>
                  <Lock className="w-3 h-3" /> Secret
                </button>
                <IconButton icon={Trash2} tone="danger" title="Remove" onClick={() => removeVar(i)} />
              </div>
            ))}
            {filtered.length === 0 && <p className="text-center text-sm text-slate-500 py-6">No keys match "{search}"</p>}
          </div>
        )}
      </Panel>
    </Page>
  )
}
