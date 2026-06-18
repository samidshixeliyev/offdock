import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import Editor from '@monaco-editor/react'
import { api, ComposeConfig } from '../api/client'
import { usePermissions, PERMS } from '../hooks/usePermissions'
import { ReadOnlyBanner } from '../components/ReadOnlyBanner'

export default function ComposePage() {
  const { id } = useParams<{ id: string }>()
  const { can } = usePermissions()
  const [yaml, setYaml] = useState('')
  const [history, setHistory] = useState<ComposeConfig[]>([])
  const [selected, setSelected] = useState<ComposeConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState<'ok' | 'err'>('ok')

  useEffect(() => {
    if (!id) return
    api.getCompose(id).then(c => { if (c) { setYaml(c.raw_yaml); setSelected(c) } }).catch(() => {})
    api.composeHistory(id).then(d => setHistory(d ?? [])).catch(() => {})
  }, [id])

  const save = async () => {
    if (!id) return
    setSaving(true)
    setMsg('')
    try {
      const { config: cfg, unchanged } = await api.saveCompose(id, yaml)
      setSelected(cfg)
      const hist = await api.composeHistory(id)
      setHistory(hist ?? [])
      setMsg(unchanged ? 'No changes — still on version ' + cfg.version : 'Saved as version ' + cfg.version)
      setMsgType('ok')
    } catch (e: unknown) {
      setMsg('Error: ' + (e instanceof Error ? e.message : 'unknown'))
      setMsgType('err')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
    {!can(PERMS.editCompose) && <ReadOnlyBanner message="You don't have permission to edit compose configs. Viewing in read-only mode." />}
    <div className="p-6 max-w-6xl flex-1 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white">docker-compose.yml</h1>
        <div className="flex items-center gap-3">
          {msg && <span className={`text-sm ${msgType === 'err' ? 'text-red-400' : 'text-slate-400'}`}>{msg}</span>}
          <button onClick={save} disabled={saving || !can(PERMS.editCompose)} title={!can(PERMS.editCompose) ? 'No permission to edit compose' : undefined} className="btn-primary">
            {saving ? 'Saving…' : 'Save Version'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-3 rounded-xl overflow-hidden border border-slate-800">
          <Editor
            height="70vh"
            language="yaml"
            theme="vs-dark"
            value={yaml}
            onChange={v => setYaml(v ?? '')}
            options={{ minimap: { enabled: false }, fontSize: 13, lineHeight: 20 }}
          />
        </div>

        <div>
          <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Version History</h2>
          {history.length === 0 && <p className="text-xs text-slate-600 px-1">No versions yet</p>}
          <div className="space-y-1.5">
            {history.map(cfg => (
              <button
                key={cfg.id}
                onClick={() => { setYaml(cfg.raw_yaml); setSelected(cfg) }}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${selected?.id === cfg.id ? 'bg-blue-600/20 text-blue-400' : 'text-slate-400 hover:bg-slate-800'}`}
              >
                <div className="font-medium">v{cfg.version}</div>
                <div className="text-slate-600 mt-0.5">{new Date(cfg.created_at).toLocaleString()}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
    </div>
  )
}
