import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, NginxConfig } from '../api/client'

type Form = Omit<NginxConfig, 'id' | 'project_id' | 'generated_config' | 'active' | 'created_at'>

const defaultForm: Form = {
  domain: '',
  ssl_enabled: false,
  ssl_cert_path: '',
  ssl_key_path: '',
  upstream_host: 'localhost',
  upstream_port: 3000,
  client_max_body_size: '1m',
  proxy_read_timeout: 60,
  gzip_enabled: false,
  custom_directives: '',
}

export default function NginxPage() {
  const { id } = useParams<{ id: string }>()
  const [form, setForm] = useState<Form>(defaultForm)
  const [preview, setPreview] = useState('')
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (!id) return
    api.getNginx(id).then(cfg => { if (cfg) setForm(cfg) })
    api.previewNginx(id).then(r => setPreview(r.config))
  }, [id])

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm(f => ({ ...f, [key]: value }))

  const handleSave = async () => {
    if (!id) return
    setSaving(true)
    setMsg('')
    try {
      await api.saveNginx(id, form)
      const r = await api.previewNginx(id)
      setPreview(r.config)
      setMsg('Saved')
    } catch (e: unknown) {
      setMsg('Error: ' + (e instanceof Error ? e.message : 'unknown'))
    } finally {
      setSaving(false)
    }
  }

  const handleApply = async () => {
    if (!id) return
    setApplying(true)
    setMsg('')
    try {
      const r = await api.applyNginx(id)
      setMsg('Applied — nginx reloaded. Test output: ' + r.nginx_test_output.trim())
    } catch (e: unknown) {
      setMsg('Error: ' + (e instanceof Error ? e.message : 'unknown'))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white">Nginx Config</h1>
        <div className="flex items-center gap-2">
          {msg && <span className="text-sm text-gray-400 max-w-xs truncate">{msg}</span>}
          <button onClick={handleSave} disabled={saving} className="btn-ghost">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={handleApply} disabled={applying} className="btn-primary">
            {applying ? 'Applying…' : 'Apply to Host'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Domain</label>
            <input className="input" value={form.domain} onChange={e => set('domain', e.target.value)} placeholder="app.example.com" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Upstream Host</label>
              <input className="input" value={form.upstream_host} onChange={e => set('upstream_host', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Upstream Port</label>
              <input className="input" type="number" value={form.upstream_port} onChange={e => set('upstream_port', Number(e.target.value))} />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.ssl_enabled} onChange={e => set('ssl_enabled', e.target.checked)} />
            <span className="text-sm text-gray-300">Enable SSL</span>
          </label>
          {form.ssl_enabled && (
            <>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Certificate Path</label>
                <input className="input font-mono text-xs" value={form.ssl_cert_path} onChange={e => set('ssl_cert_path', e.target.value)} placeholder="/var/offdock/certs/cert.pem" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Key Path</label>
                <input className="input font-mono text-xs" value={form.ssl_key_path} onChange={e => set('ssl_key_path', e.target.value)} placeholder="/var/offdock/certs/key.pem" />
              </div>
            </>
          )}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Custom Directives</label>
            <textarea className="input font-mono text-xs h-24 resize-none" value={form.custom_directives} onChange={e => set('custom_directives', e.target.value)} placeholder="client_max_body_size 50m;" />
          </div>
        </div>

        <div>
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Preview</h2>
          <pre className="card font-mono text-xs text-green-400 overflow-auto h-[calc(100%-2rem)] min-h-48 whitespace-pre-wrap">
            {preview || '# Save config to see preview'}
          </pre>
        </div>
      </div>
    </div>
  )
}
