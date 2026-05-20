import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, EnvVar } from '../api/client'

interface EditableVar extends EnvVar {
  revealed: boolean
}

export default function EnvPage() {
  const { id } = useParams<{ id: string }>()
  const [vars, setVars] = useState<EditableVar[]>([])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (!id) return
    api.getEnv(id).then(s => {
      if (s) setVars(s.vars.map(v => ({ ...v, revealed: false })))
    })
  }, [id])

  const addVar = () => setVars(v => [...v, { key: '', value: '', is_secret: false, revealed: false }])
  const removeVar = (i: number) => setVars(v => v.filter((_, idx) => idx !== i))
  const updateVar = (i: number, field: keyof EnvVar, value: string | boolean) =>
    setVars(v => v.map((env, idx) => idx === i ? { ...env, [field]: value } : env))
  const toggleReveal = (i: number) =>
    setVars(v => v.map((env, idx) => idx === i ? { ...env, revealed: !env.revealed } : env))

  const save = async () => {
    if (!id) return
    setSaving(true)
    setMsg('')
    try {
      const payload = vars.map(({ key, value, is_secret }) => ({ key, value, is_secret }))
      const set = await api.saveEnv(id, payload)
      setVars(set.vars.map(v => ({ ...v, revealed: false })))
      setMsg('Saved as version ' + set.version)
    } catch (e: unknown) {
      setMsg('Error: ' + (e instanceof Error ? e.message : 'unknown'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white">Environment Variables</h1>
        <div className="flex items-center gap-3">
          {msg && <span className="text-sm text-gray-400">{msg}</span>}
          <button onClick={addVar} className="btn-ghost">+ Add</button>
          <button onClick={save} disabled={saving} className="btn-primary">
            {saving ? 'Saving…' : 'Save Version'}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {vars.length === 0 && (
          <div className="card text-center text-gray-500 py-8">
            No variables. Click "+ Add" to create one.
          </div>
        )}
        {vars.map((v, i) => (
          <div key={i} className="card flex items-center gap-3 py-3">
            <input
              className="input font-mono text-xs w-40 shrink-0"
              placeholder="KEY"
              value={v.key}
              onChange={e => updateVar(i, 'key', e.target.value)}
            />
            <div className="flex-1 relative">
              <input
                className="input font-mono text-xs w-full pr-10"
                placeholder="value"
                type={v.is_secret && !v.revealed ? 'password' : 'text'}
                value={v.value}
                onChange={e => updateVar(i, 'value', e.target.value)}
              />
              {v.is_secret && (
                <button
                  type="button"
                  onClick={() => toggleReveal(i)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs"
                >
                  {v.revealed ? 'hide' : 'show'}
                </button>
              )}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-gray-400 shrink-0 cursor-pointer">
              <input
                type="checkbox"
                checked={v.is_secret}
                onChange={e => updateVar(i, 'is_secret', e.target.checked)}
                className="rounded"
              />
              Secret
            </label>
            <button onClick={() => removeVar(i)} className="text-gray-600 hover:text-red-400 text-sm transition-colors shrink-0">✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}
