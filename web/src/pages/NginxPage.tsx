import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, NginxConfig } from '../api/client'
import CertGenerateModal from '../components/CertGenerateModal'

type Form = Omit<NginxConfig, 'id' | 'project_id' | 'generated_config' | 'active' | 'applied' | 'applied_at' | 'created_at'>

const defaultForm: Form = {
  domain: '',
  ssl_enabled: false,
  ssl_pem_path: '',
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
  const [showCertModal, setShowCertModal] = useState(false)

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
      {showCertModal && id && (
        <CertGenerateModal
          projectId={id}
          defaultDomain={form.domain}
          onSuccess={pemPath => { set('ssl_pem_path', pemPath); set('ssl_enabled', true) }}
          onClose={() => setShowCertModal(false)}
        />
      )}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white">Nginx Config</h1>
        <div className="flex items-center gap-2">
          {msg && <span className="text-sm text-slate-400 max-w-xs truncate">{msg}</span>}
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
            <label className="block text-xs text-slate-400 mb-1.5">Domain</label>
            <input className="input" value={form.domain} onChange={e => set('domain', e.target.value)} placeholder="app.example.com" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Upstream Host</label>
              <input className="input" value={form.upstream_host} onChange={e => set('upstream_host', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Upstream Port</label>
              <input className="input" type="number" value={form.upstream_port} onChange={e => set('upstream_port', Number(e.target.value))} />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.ssl_enabled} onChange={e => set('ssl_enabled', e.target.checked)} />
            <span className="text-sm text-slate-300">Enable SSL</span>
          </label>
          {form.ssl_enabled && (
            <div className="space-y-2">
              <label className="block text-xs text-slate-400 mb-1.5">PEM path <span className="text-slate-600">(combined cert chain + private key)</span></label>
              <input className="input font-mono text-xs" value={form.ssl_pem_path} onChange={e => set('ssl_pem_path', e.target.value)} placeholder="/var/offdock/certs/wildcard.pem" />
              <p className="text-xs text-slate-700">Absolute path on the server. A wildcard cert (*.ao.az) works for all subdomains.</p>
              <button onClick={() => setShowCertModal(true)} className="btn-ghost text-xs">
                ⊕ Generate self-signed cert
              </button>
            </div>
          )}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Custom Directives</label>
            <textarea className="input font-mono text-xs h-24 resize-none" value={form.custom_directives} onChange={e => set('custom_directives', e.target.value)} placeholder="client_max_body_size 50m;" />
          </div>
        </div>

        <div>
          <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Preview</h2>
          <pre className="card font-mono text-xs text-green-400 overflow-auto h-[calc(100%-2rem)] min-h-48 whitespace-pre-wrap">
            {preview || '# Save config to see preview'}
          </pre>
        </div>
      </div>
    </div>
  )
}
