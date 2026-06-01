import { useEffect, useState } from 'react'
import {
  api,
  ProxyHost, ProxyHostInput, ProxyLocation,
} from '../api/client'
import CertGenerateModal from '../components/CertGenerateModal'

// ─── helpers ──────────────────────────────────────────────────────────────────
function useNginxStatus() {
  const [available, setAvailable] = useState(false)
  const [status, setStatus] = useState('')
  const load = async () => {
    try {
      const s = await api.getNginxSystemStatus()
      setAvailable(s.available)
      setStatus(s.status)
    } catch {}
  }
  useEffect(() => { load() }, [])
  return { available, status, reload: load }
}


// ─── Host form modal ──────────────────────────────────────────────────────────
const emptyForm: ProxyHostInput = {
  domain: '', aliases: [], upstream_host: '', upstream_port: 80,
  ssl_enabled: false, ssl_pem_path: '',
  client_max_body_size: '10m', proxy_read_timeout: 60,
  gzip_enabled: true, custom_directives: '',
  locations: [], access_log: false,
}

const emptyLocation: ProxyLocation = {
  path: '', upstream_host: '', upstream_port: 80,
  strip_prefix: false, ws_enabled: false,
}

function HostModal({ host, onSave, onClose }: {
  host: ProxyHost | null
  onSave: (h: ProxyHost) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<ProxyHostInput>(
    host ? { ...host, aliases: host.aliases ?? [], locations: host.locations ?? [] } : { ...emptyForm }
  )
  const [aliasInput, setAliasInput] = useState((host?.aliases ?? []).join(', '))
  const [preview, setPreview] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showCertModal, setShowCertModal] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgErr, setMsgErr] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  const set = <K extends keyof ProxyHostInput>(k: K, v: ProxyHostInput[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  const updateAliases = (raw: string) => {
    setAliasInput(raw)
    const parsed = raw.split(',').map(s => s.trim()).filter(Boolean)
    set('aliases', parsed)
  }

  const addLocation = () => set('locations', [...(form.locations ?? []), { ...emptyLocation }])
  const removeLocation = (i: number) => set('locations', (form.locations ?? []).filter((_, idx) => idx !== i))
  const updateLocation = <K extends keyof ProxyLocation>(i: number, k: K, v: ProxyLocation[K]) =>
    set('locations', (form.locations ?? []).map((loc, idx) => idx === i ? { ...loc, [k]: v } : loc))

  const loadPreview = async () => {
    setPreviewLoading(true)
    try { setPreview((await api.previewProxyHost(form)).config) }
    catch (e) { setPreview('Error: ' + (e instanceof Error ? e.message : 'unknown')) }
    finally { setPreviewLoading(false) }
  }

  const onCertGenerated = (pemPath: string) => {
    set('ssl_pem_path', pemPath)
    set('ssl_enabled', true)
    setMsg('Self-signed cert generated'); setMsgErr(false)
  }

  const save = async () => {
    setSaving(true); setMsg('')
    try {
      const result = host
        ? await api.updateProxyHost(host.id, form)
        : await api.createProxyHost(form)
      onSave(result)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Save failed'); setMsgErr(true)
    } finally { setSaving(false) }
  }

  const safeDomain = form.domain.replace(/[^a-z0-9.-]/gi, '-').toLowerCase()
  const certProjectId = 'proxy-' + (safeDomain || 'host')

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      {showCertModal && (
        <CertGenerateModal
          projectId={certProjectId}
          defaultDomain={form.domain}
          onSuccess={onCertGenerated}
          onClose={() => setShowCertModal(false)}
        />
      )}
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[92vh] flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 shrink-0">
          <h3 className="text-sm font-semibold text-white">{host ? 'Edit Proxy Host' : 'Add Proxy Host'}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0 p-5 space-y-4">

          {/* ── Primary domain + upstream ── */}
          <div className="space-y-1">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Virtual Host</p>
            <div className="grid grid-cols-5 gap-3">
              <div className="col-span-3">
                <label className="block text-xs text-slate-500 mb-1.5">Primary domain</label>
                <input className="input w-full" placeholder="grafana.ao.az"
                  value={form.domain} onChange={e => set('domain', e.target.value)} />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-slate-500 mb-1.5">Aliases <span className="text-slate-700">(comma-separated)</span></label>
                <input className="input w-full text-xs" placeholder="www.grafana.ao.az, grafana.local"
                  value={aliasInput} onChange={e => updateAliases(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-slate-700">All domains in server_name share this upstream. nginx matches by Host header.</p>
          </div>

          {/* ── Default upstream (location /) ── */}
          <div className="space-y-1">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Default Upstream <span className="text-slate-600 font-normal normal-case">(location /)</span></p>
            <div className="grid grid-cols-5 gap-3">
              <div className="col-span-3">
                <label className="block text-xs text-slate-500 mb-1.5">Upstream host</label>
                <input className="input w-full font-mono text-xs" placeholder="container-name or IP"
                  value={form.upstream_host} onChange={e => set('upstream_host', e.target.value)} />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-slate-500 mb-1.5">Port</label>
                <input className="input w-full" type="number" placeholder="3000"
                  value={form.upstream_port || ''} onChange={e => set('upstream_port', Number(e.target.value))} />
              </div>
            </div>
          </div>

          {/* ── Extra location blocks ── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Extra Locations <span className="text-slate-600 font-normal normal-case">(path routing)</span></p>
              <button onClick={addLocation}
                className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-blue-400 hover:border-blue-700 transition-colors">
                + Add location
              </button>
            </div>
            {(form.locations ?? []).length === 0 ? (
              <p className="text-xs text-slate-700 italic">No extra locations — all traffic goes to the default upstream above.</p>
            ) : (
              <div className="space-y-2">
                {(form.locations ?? []).map((loc, i) => (
                  <div key={i} className="border border-slate-800 rounded-lg p-3 space-y-2 bg-slate-950/40">
                    <div className="grid grid-cols-5 gap-2 items-end">
                      <div className="col-span-2">
                        <label className="block text-xs text-slate-600 mb-1">Path prefix</label>
                        <input className="input w-full font-mono text-xs" placeholder="/api/"
                          value={loc.path} onChange={e => updateLocation(i, 'path', e.target.value)} />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs text-slate-600 mb-1">Upstream</label>
                        <input className="input w-full font-mono text-xs" placeholder="backend:8080"
                          value={`${loc.upstream_host}${loc.upstream_port ? ':'+loc.upstream_port : ''}`}
                          onChange={e => {
                            const parts = e.target.value.split(':')
                            updateLocation(i, 'upstream_host', parts[0])
                            if (parts[1]) updateLocation(i, 'upstream_port', Number(parts[1]))
                          }} />
                      </div>
                      <div className="flex items-end justify-end pb-0.5">
                        <button onClick={() => removeLocation(i)} className="text-slate-700 hover:text-red-400 transition-colors text-sm">✕</button>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={loc.strip_prefix}
                          onChange={e => updateLocation(i, 'strip_prefix', e.target.checked)} />
                        <span className="text-xs text-slate-400">Strip prefix</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={loc.ws_enabled}
                          onChange={e => updateLocation(i, 'ws_enabled', e.target.checked)} />
                        <span className="text-xs text-slate-400">WebSocket</span>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── SSL ── */}
          <div className="border border-slate-800 rounded-xl p-4 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.ssl_enabled}
                onChange={e => set('ssl_enabled', e.target.checked)} />
              <span className="text-sm text-slate-300 font-medium">Enable HTTPS (SSL)</span>
            </label>
            {form.ssl_enabled && (
              <>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">PEM path <span className="text-slate-700">(combined cert chain + private key)</span></label>
                  <input className="input w-full font-mono text-xs" placeholder="/var/offdock/certs/wildcard.pem"
                    value={form.ssl_pem_path} onChange={e => set('ssl_pem_path', e.target.value)} />
                  <p className="text-xs text-slate-700 mt-1">Absolute path on server. A wildcard cert (*.ao.az) covers all subdomains.</p>
                </div>
                <button onClick={() => setShowCertModal(true)} className="btn-ghost text-xs">
                  ⊕ Generate self-signed cert
                </button>
              </>
            )}
          </div>

          {/* ── Options strip ── */}
          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.gzip_enabled}
                onChange={e => set('gzip_enabled', e.target.checked)} />
              <span className="text-xs text-slate-300">Gzip compression</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.access_log}
                onChange={e => set('access_log', e.target.checked)} />
              <span className="text-xs text-slate-300">Access log</span>
              <span className="text-xs text-slate-700">(absolute path on server)</span>
            </label>
          </div>

          {/* ── Advanced ── */}
          <button onClick={() => setAdvanced(a => !a)}
            className="text-xs text-slate-600 hover:text-slate-300 transition-colors">
            {advanced ? '▲' : '▼'} Advanced settings
          </button>
          {advanced && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Max body size</label>
                  <input className="input w-full font-mono text-xs" placeholder="10m"
                    value={form.client_max_body_size} onChange={e => set('client_max_body_size', e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Read timeout (s)</label>
                  <input className="input w-full" type="number"
                    value={form.proxy_read_timeout} onChange={e => set('proxy_read_timeout', Number(e.target.value))} />
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Custom nginx directives <span className="text-slate-700">(inside location /)</span></label>
                <textarea className="input w-full font-mono text-xs resize-none" rows={4}
                  placeholder={'add_header X-Frame-Options DENY;\nproxy_connect_timeout 30s;'}
                  value={form.custom_directives} onChange={e => set('custom_directives', e.target.value)} />
              </div>
            </div>
          )}

          {/* ── Config preview ── */}
          <button onClick={() => { if (!showPreview) loadPreview(); setShowPreview(p => !p) }}
            className="text-xs text-slate-600 hover:text-slate-300 transition-colors">
            {showPreview ? '▲' : '▼'} {previewLoading ? 'Loading preview…' : 'Show generated nginx config'}
          </button>
          {showPreview && (
            <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs font-mono text-green-400 leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto">
              {previewLoading ? 'Loading…' : (preview || '# fill in domain + upstream to generate')}
            </pre>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3.5 border-t border-slate-800 shrink-0">
          <div>{msg && <span className={`text-xs ${msgErr ? 'text-red-400' : 'text-green-400'}`}>{msg}</span>}</div>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
            <button onClick={save} disabled={saving || !form.domain || !form.upstream_host || !form.upstream_port}
              className="btn-primary disabled:opacity-40">
              {saving ? (
                <><svg className="animate-spin w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> Saving…</>
              ) : (host ? 'Update Host' : 'Add Host')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Hosts table ──────────────────────────────────────────────────────────────
interface TestResult {
  ok: boolean
  status_code?: number
  status?: string
  dns_resolved: boolean
  dns_addrs?: string[]
  dns_points_here: boolean
  server_ip: string
  nginx_ok: boolean
  nginx_error?: string
  hints: string[]
}

// ─── Diagnostic modal ─────────────────────────────────────────────────────────
function DiagModal({ host, result, onClose }: { host: ProxyHost; result: TestResult; onClose: () => void }) {
  const Check = ({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) => (
    <div className="flex items-start gap-3 py-2.5 border-b border-slate-800 last:border-0">
      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0 mt-0.5 ${ok ? 'bg-green-950 text-green-400' : 'bg-red-950 text-red-400'}`}>
        {ok ? '✓' : '✗'}
      </span>
      <div className="min-w-0">
        <p className={`text-sm font-medium ${ok ? 'text-slate-200' : 'text-slate-300'}`}>{label}</p>
        {detail && <p className="text-xs text-slate-500 mt-0.5 font-mono break-all">{detail}</p>}
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div>
            <p className="text-sm font-semibold text-white">Host Diagnostics</p>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{host.domain}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2.5 py-1 rounded-full border ${result.ok ? 'bg-green-950 text-green-300 border-green-900/50' : 'bg-red-950 text-red-300 border-red-900/50'}`}>
              {result.ok ? 'All checks passed' : 'Issues found'}
            </span>
            <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none ml-1">×</button>
          </div>
        </div>

        <div className="px-5 py-2">
          <Check
            ok={result.dns_resolved}
            label="DNS A record exists"
            detail={result.dns_resolved
              ? `${host.domain} → ${result.dns_addrs?.join(', ')}`
              : `${host.domain} has no A record — add one in your DNS provider`}
          />
          <Check
            ok={result.dns_points_here}
            label="DNS points to this server"
            detail={result.dns_points_here
              ? `${host.domain} → ${result.server_ip} ✓`
              : `Resolves to ${result.dns_addrs?.join(', ')} but this server is ${result.server_ip}`}
          />
          <Check
            ok={result.nginx_ok}
            label="nginx → upstream reachable"
            detail={result.nginx_ok
              ? `${result.status} from ${host.upstream_host}:${host.upstream_port}`
              : result.nginx_error ?? 'nginx could not reach the upstream container'}
          />
        </div>

        {result.hints.length > 0 && (
          <div className="mx-5 mb-4 mt-1 rounded-lg bg-slate-950 border border-slate-800 divide-y divide-slate-800">
            {result.hints.map((h, i) => (
              <p key={i} className={`text-xs px-4 py-3 leading-relaxed ${result.ok ? 'text-green-400' : 'text-yellow-300'}`}>
                {!result.ok && <span className="mr-1.5">→</span>}{h}
              </p>
            ))}
          </div>
        )}

        {/* Self-signed cert instructions */}
        {result.nginx_ok && result.dns_resolved && result.dns_points_here && host.ssl_enabled && (
          <div className="mx-5 mb-4 bg-yellow-950/30 rounded-lg border border-yellow-900/40 p-4 space-y-2">
            <p className="text-xs font-semibold text-yellow-300">Self-signed certificate — browser will block this</p>
            <p className="text-xs text-slate-400">The proxy works, but browsers reject self-signed certs by default. To bypass:</p>
            <div className="space-y-1 text-xs text-slate-400">
              <p><span className="text-slate-300 font-medium">Chrome/Edge:</span> click <span className="bg-slate-800 px-1.5 py-0.5 rounded font-mono text-slate-200">Advanced</span> → <span className="bg-slate-800 px-1.5 py-0.5 rounded font-mono text-slate-200">Proceed to {host.domain} (unsafe)</span></p>
              <p><span className="text-slate-300 font-medium">Firefox:</span> click <span className="bg-slate-800 px-1.5 py-0.5 rounded font-mono text-slate-200">Advanced</span> → <span className="bg-slate-800 px-1.5 py-0.5 rounded font-mono text-slate-200">Accept the Risk and Continue</span></p>
              <p className="pt-1 text-slate-500">Or: edit the host and <span className="text-slate-300">disable SSL</span> to use HTTP — no warnings, works for internal/VPN use.</p>
            </div>
          </div>
        )}

        {!result.dns_resolved && (
          <div className="mx-5 mb-4 bg-slate-950 rounded-lg border border-slate-800 p-4 space-y-2">
            <p className="text-xs font-semibold text-slate-400">DNS Setup</p>
            <p className="text-xs text-slate-500">Add this A record in your domain registrar:</p>
            <div className="font-mono text-xs bg-slate-900 rounded p-3 space-y-1">
              <div className="flex gap-4">
                <span className="text-slate-600 w-16">Type</span>
                <span className="text-blue-400">A</span>
              </div>
              <div className="flex gap-4">
                <span className="text-slate-600 w-16">Name</span>
                <span className="text-green-400">{host.domain.split('.').slice(0, -2).join('.') || '@'}</span>
              </div>
              <div className="flex gap-4">
                <span className="text-slate-600 w-16">Value</span>
                <span className="text-green-400">{result.server_ip}</span>
              </div>
              <div className="flex gap-4">
                <span className="text-slate-600 w-16">TTL</span>
                <span className="text-slate-400">300</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function HostsSection() {
  const [hosts, setHosts] = useState<ProxyHost[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [testBusy, setTestBusy] = useState('')
  const [diagHost, setDiagHost] = useState<{ host: ProxyHost; result: TestResult } | null>(null)
  const [serverIP, setServerIP] = useState('')
  const [msg, setMsg] = useState('')
  const [msgErr, setMsgErr] = useState(false)

  const load = async () => {
    setLoading(true)
    try { setHosts(await api.listProxyHosts()) } catch {}
    setLoading(false)
  }

  useEffect(() => {
    load()
    api.serverIP().then(r => setServerIP(r.ip)).catch(() => {})
  }, [])

  // Start with modal hidden
  const [showModal, setShowModal] = useState(false)
  const [editHost, setEditHost] = useState<ProxyHost | null>(null)

  const openAdd = () => { setEditHost(null); setShowModal(true) }
  const openEdit = (h: ProxyHost) => { setEditHost(h); setShowModal(true) }
  const closeModal = () => setShowModal(false)

  const onSaved = (h: ProxyHost) => {
    setHosts(prev => {
      const idx = prev.findIndex(x => x.id === h.id)
      return idx >= 0 ? prev.map(x => x.id === h.id ? h : x) : [...prev, h]
    })
    closeModal()
    setMsg(`Host ${h.domain} ${editHost ? 'updated' : 'added'}`); setMsgErr(false)
  }

  const toggle = async (h: ProxyHost) => {
    setBusy(h.id)
    try {
      const updated = await api.toggleProxyHost(h.id)
      setHosts(prev => prev.map(x => x.id === h.id ? updated : x))
      setMsg(`${updated.domain} ${updated.enabled ? 'enabled' : 'disabled'}`); setMsgErr(false)
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); setMsgErr(true) }
    setBusy('')
  }

  const remove = async (id: string) => {
    setBusy(id)
    try {
      await api.deleteProxyHost(id)
      setHosts(prev => prev.filter(x => x.id !== id))
      setMsg('Host deleted'); setMsgErr(false)
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); setMsgErr(true) }
    setDeleteId(null); setBusy('')
  }

  const testHost = async (h: ProxyHost) => {
    setTestBusy(h.id)
    try {
      const r = await api.testProxyHost(h.id)
      setTestResults(prev => ({ ...prev, [h.id]: r }))
      setDiagHost({ host: h, result: r })
    } catch (e) {
      const r: TestResult = {
        ok: false, dns_resolved: false, dns_points_here: false,
        server_ip: '', nginx_ok: false, nginx_error: e instanceof Error ? e.message : 'Failed',
        hints: ['Could not reach the OffDock server'],
      }
      setTestResults(prev => ({ ...prev, [h.id]: r }))
      setDiagHost({ host: h, result: r })
    }
    setTestBusy('')
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {diagHost && (
        <DiagModal host={diagHost.host} result={diagHost.result} onClose={() => setDiagHost(null)} />
      )}
      {showModal && (
        <HostModal host={editHost} onSave={onSaved} onClose={closeModal} />
      )}
      {deleteId && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setDeleteId(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-80 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-semibold text-white">Delete host?</p>
            <p className="text-xs text-slate-500">The nginx config file will be removed and nginx reloaded.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteId(null)} className="btn-ghost text-sm">Cancel</button>
              <button onClick={() => remove(deleteId)} disabled={!!busy}
                className="text-sm px-4 py-2 rounded-lg bg-red-600/20 text-red-300 border border-red-900/50 hover:bg-red-600/30 transition-colors">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-white">Proxy Hosts</h2>
        <div className="flex items-center gap-3">
          {msg && <span className={`text-xs ${msgErr ? 'text-red-400' : 'text-green-400'}`}>{msg}</span>}
          <button onClick={load} className="btn-ghost text-xs">↻</button>
          <button onClick={openAdd} className="btn-primary text-sm">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z"/></svg>
            Add Host
          </button>
        </div>
      </div>

      {loading ? (
        <div className="card text-center py-10 text-slate-600 text-sm">Loading…</div>
      ) : hosts.length === 0 ? (
        <div className="card text-center py-12 border-dashed space-y-3">
          <p className="text-slate-500 text-sm">No proxy hosts yet</p>
          <p className="text-xs text-slate-700 max-w-sm mx-auto">
            Add a host to map a domain to any upstream — a running container, a local port, or any IP:port.
          </p>
          <button onClick={openAdd} className="btn-primary text-sm mx-auto">Add first host</button>
        </div>
      ) : (
        <div className="card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">Domain</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">Upstream</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">SSL</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">Test</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">On</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {hosts.map(h => {
                const tr = testResults[h.id]
                return (
                  <tr key={h.id} className="border-b border-slate-800/40 hover:bg-slate-800/20">
                    <td className="px-4 py-3">
                      <a href={`http${h.ssl_enabled ? 's' : ''}://${h.domain}`} target="_blank" rel="noopener noreferrer"
                        className="font-mono text-sm text-blue-400 hover:text-blue-300 transition-colors">
                        {h.domain} ↗
                      </a>
                      {(h.aliases ?? []).length > 0 && (
                        <div className="text-xs text-slate-600 font-mono mt-0.5 truncate max-w-[200px]" title={(h.aliases ?? []).join(', ')}>
                          + {(h.aliases ?? []).join(', ')}
                        </div>
                      )}
                      {(h.locations ?? []).length > 0 && (
                        <div className="text-xs text-slate-700 mt-0.5">
                          {(h.locations ?? []).length} extra location{(h.locations ?? []).length > 1 ? 's' : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">
                      {h.upstream_host}:{h.upstream_port}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {h.ssl_enabled
                          ? <span className="text-xs px-2 py-0.5 rounded-full border bg-green-950 text-green-300 border-green-900/50">HTTPS</span>
                          : <span className="text-xs text-slate-700">HTTP</span>}
                        {h.ssl_enabled && h.ssl_pem_path.startsWith('/var/offdock/certs/') && (
                          <span title="Self-signed certificate — browser will show a security warning. Click Advanced → Proceed to bypass."
                            className="text-xs text-yellow-500 cursor-help">⚠</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button onClick={() => testHost(h)} disabled={testBusy === h.id}
                          className="text-xs px-2 py-0.5 rounded border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors disabled:opacity-40">
                          {testBusy === h.id ? (
                            <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                          ) : 'Test'}
                        </button>
                        {tr && (
                          <button onClick={() => setDiagHost({ host: h, result: tr })}
                            className={`flex items-center gap-1 text-xs transition-colors ${tr.ok ? 'text-green-400 hover:text-green-300' : 'text-red-400 hover:text-red-300'}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${tr.ok ? 'bg-green-400' : 'bg-red-400'}`} />
                            {tr.ok ? 'OK' : !tr.dns_resolved ? 'DNS missing' : !tr.dns_points_here ? 'DNS mismatch' : 'Proxy error'}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <button onClick={() => toggle(h)} disabled={busy === h.id}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${h.enabled ? 'bg-blue-600' : 'bg-slate-700'}`}>
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${h.enabled ? 'translate-x-4' : 'translate-x-1'}`} />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3 justify-end">
                        <button onClick={() => openEdit(h)} className="text-xs text-slate-500 hover:text-slate-200 transition-colors">Edit</button>
                        <button onClick={() => setDeleteId(h.id)} className="text-xs text-slate-600 hover:text-red-400 transition-colors">Delete</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* DNS hint footer */}
          {serverIP && (
            <div className="px-4 py-3 border-t border-slate-800 bg-slate-950/60">
              <p className="text-xs text-slate-600">
                Point your domain's <span className="text-slate-400">A record</span> to{' '}
                <code className="text-blue-400 font-mono">{serverIP}</code>
                {' '}· or test locally:{' '}
                <code className="text-slate-400 font-mono">curl -H "Host: your-domain.com" http://{serverIP}/</code>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function ReverseProxyPage() {
  const { available, status, reload } = useNginxStatus()

  return (
    <div className="flex flex-col h-full">

      {/* ── nginx status bar ──────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-slate-800 bg-slate-950">
        <span className={`w-2 h-2 rounded-full shrink-0 ${available && status === 'active' ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`} />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-semibold text-slate-100">nginx</span>
          <span className="ml-2 text-xs text-slate-600">system · native</span>
          <span className={`ml-2 text-xs px-1.5 py-0.5 rounded border ${
            available && status === 'active'
              ? 'bg-green-950 text-green-300 border-green-900/40'
              : 'bg-red-950 text-red-300 border-red-900/40'
          }`}>
            {available ? (status || 'unknown') : 'not installed'}
          </span>
          {!available && (
            <span className="ml-2 text-xs text-slate-600">Install nginx: sudo apt-get install -y nginx</span>
          )}
        </div>
        <button onClick={reload} className="btn-ghost text-xs px-2 shrink-0">↻</button>
      </div>

      {/* ── Proxy hosts ───────────────────────────────────────────────────── */}
      <HostsSection />
    </div>
  )
}
