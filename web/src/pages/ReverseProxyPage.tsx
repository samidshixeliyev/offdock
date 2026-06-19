import { useEffect, useState } from 'react'
import { api, ProxyHost, ProxyHostInput, ProxyLocation } from '../api/client'
import CertGenerateModal from '../components/CertGenerateModal'
import { Page, PageHeader, Panel, EmptyState, Alert, StatusBadge, IconButton } from '../components/ui'
import { Modal } from '../components/Modal'
import ConfirmModal from '../components/ConfirmModal'
import { useToast } from '../components/Toast'
import clsx from 'clsx'
import {
  Globe, Plus, RefreshCw, Trash2, Pencil, Activity, ShieldCheck, ShieldAlert,
  ExternalLink, Plus as PlusIcon, X, ChevronDown, CheckCircle2, XCircle, Loader2,
  Server, Network as NetworkIcon, Copy, Check,
} from 'lucide-react'

// ─── nginx status hook ─────────────────────────────────────────────────────────
function useNginxStatus() {
  const [available, setAvailable] = useState(false)
  const [status, setStatus] = useState('')
  const load = async () => {
    try { const s = await api.getNginxSystemStatus(); setAvailable(s.available); setStatus(s.status) } catch {}
  }
  useEffect(() => { load() }, [])
  return { available, status, reload: load }
}

// Module-level so it keeps a stable component identity across renders —
// defining it inside HostModal would remount inputs on every keystroke
// (causing focus loss after one character).
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{title}{hint && <span className="text-slate-600 font-normal normal-case ml-1.5">{hint}</span>}</p>
      {children}
    </div>
  )
}

const emptyForm: ProxyHostInput = {
  domain: '', aliases: [], upstream_host: '', upstream_port: 80,
  ssl_enabled: false, ssl_pem_path: '', client_max_body_size: '10m',
  proxy_read_timeout: 60, gzip_enabled: true, custom_directives: '', locations: [], access_log: true,
}
const emptyLocation: ProxyLocation = { path: '', upstream_host: '', upstream_port: 80, strip_prefix: false, ws_enabled: false }

// ─── Host create/edit modal ────────────────────────────────────────────────────
function HostModal({ host, onSave, onClose }: { host: ProxyHost | null; onSave: (h: ProxyHost) => void; onClose: () => void }) {
  const toast = useToast()
  const [form, setForm] = useState<ProxyHostInput>(host ? { ...host, aliases: host.aliases ?? [], locations: host.locations ?? [] } : { ...emptyForm })
  const [aliasInput, setAliasInput] = useState((host?.aliases ?? []).join(', '))
  const [preview, setPreview] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showCertModal, setShowCertModal] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  const set = <K extends keyof ProxyHostInput>(k: K, v: ProxyHostInput[K]) => setForm(f => ({ ...f, [k]: v }))
  const updateAliases = (raw: string) => { setAliasInput(raw); set('aliases', raw.split(',').map(s => s.trim()).filter(Boolean)) }
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
  const save = async () => {
    setSaving(true)
    try {
      const result = host ? await api.updateProxyHost(host.id, form) : await api.createProxyHost(form)
      onSave(result)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed') } finally { setSaving(false) }
  }

  const safeDomain = form.domain.replace(/[^a-z0-9.-]/gi, '-').toLowerCase()
  const certProjectId = 'proxy-' + (safeDomain || 'host')

  return (
    <Modal open onClose={onClose} size="xl" icon={Globe} title={host ? 'Edit Proxy Host' : 'Add Proxy Host'}
      footer={<>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button onClick={save} disabled={saving || !form.domain || !form.upstream_host || !form.upstream_port} className="btn-primary">
          {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : (host ? 'Update Host' : 'Add Host')}
        </button>
      </>}>
      {showCertModal && (
        <CertGenerateModal projectId={certProjectId} defaultDomain={form.domain}
          onSuccess={(pemPath) => { set('ssl_pem_path', pemPath); set('ssl_enabled', true); toast.success('Self-signed cert generated') }}
          onClose={() => setShowCertModal(false)} />
      )}
      <div className="space-y-5">
        <Section title="Virtual Host">
          <div className="grid grid-cols-5 gap-3">
            <div className="col-span-3">
              <label className="block text-xs text-slate-500 mb-1.5">Primary domain</label>
              <input className="input" placeholder="grafana.example.com" value={form.domain} onChange={e => set('domain', e.target.value)} />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1.5">Aliases <span className="text-slate-600">(comma-separated)</span></label>
              <input className="input text-xs" placeholder="www.grafana.example.com" value={aliasInput} onChange={e => updateAliases(e.target.value)} />
            </div>
          </div>
        </Section>

        <Section title="Default Upstream" hint="(location /)">
          <div className="grid grid-cols-5 gap-3">
            <div className="col-span-3">
              <label className="block text-xs text-slate-500 mb-1.5">Upstream host</label>
              <input className="input font-mono text-xs" placeholder="container-name or IP" value={form.upstream_host} onChange={e => set('upstream_host', e.target.value)} />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1.5">Port</label>
              <input className="input" type="number" placeholder="3000" value={form.upstream_port || ''} onChange={e => set('upstream_port', Number(e.target.value))} />
            </div>
          </div>
        </Section>

        <Section title="Extra Locations" hint="(path routing)">
          <div className="space-y-2">
            {(form.locations ?? []).length === 0
              ? <p className="text-xs text-slate-600 italic">No extra locations — all traffic goes to the default upstream.</p>
              : (form.locations ?? []).map((loc, i) => (
                <div key={i} className="border border-slate-800 rounded-lg p-3 space-y-2 bg-slate-950/40">
                  <div className="grid grid-cols-5 gap-2 items-end">
                    <div className="col-span-2">
                      <label className="block text-xs text-slate-600 mb-1">Path prefix</label>
                      <input className="input font-mono text-xs" placeholder="/api/" value={loc.path} onChange={e => updateLocation(i, 'path', e.target.value)} />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs text-slate-600 mb-1">Upstream</label>
                      <input className="input font-mono text-xs" placeholder="backend:8080"
                        value={`${loc.upstream_host}${loc.upstream_port ? ':' + loc.upstream_port : ''}`}
                        onChange={e => { const parts = e.target.value.split(':'); updateLocation(i, 'upstream_host', parts[0]); if (parts[1]) updateLocation(i, 'upstream_port', Number(parts[1])) }} />
                    </div>
                    <div className="flex items-end justify-end pb-1"><IconButton icon={X} tone="danger" title="Remove" onClick={() => removeLocation(i)} /></div>
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={loc.strip_prefix} onChange={e => updateLocation(i, 'strip_prefix', e.target.checked)} /><span className="text-xs text-slate-400">Strip prefix</span></label>
                    <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={loc.ws_enabled} onChange={e => updateLocation(i, 'ws_enabled', e.target.checked)} /><span className="text-xs text-slate-400">WebSocket</span></label>
                  </div>
                </div>
              ))}
            <button onClick={addLocation} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-blue-400 hover:border-blue-500/40 transition-colors">
              <PlusIcon className="w-3.5 h-3.5" /> Add location
            </button>
          </div>
        </Section>

        <div className="border border-slate-800 rounded-xl p-4 space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.ssl_enabled} onChange={e => set('ssl_enabled', e.target.checked)} />
            <span className="text-sm text-slate-300 font-medium">Enable HTTPS (SSL)</span>
          </label>
          {form.ssl_enabled && (
            <>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">PEM path <span className="text-slate-600">(cert chain + private key)</span></label>
                <input className="input font-mono text-xs" placeholder="/var/offdock/certs/wildcard.pem" value={form.ssl_pem_path} onChange={e => set('ssl_pem_path', e.target.value)} />
              </div>
              <button onClick={() => setShowCertModal(true)} className="btn-secondary text-xs"><ShieldCheck className="w-3.5 h-3.5" /> Generate self-signed cert</button>
            </>
          )}
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.gzip_enabled} onChange={e => set('gzip_enabled', e.target.checked)} /><span className="text-xs text-slate-300">Gzip compression</span></label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.access_log} onChange={e => set('access_log', e.target.checked)} /><span className="text-xs text-slate-300">Access log</span></label>
        </div>

        <div>
          <button onClick={() => setAdvanced(a => !a)} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
            <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', advanced && 'rotate-180')} /> Advanced settings
          </button>
          {advanced && (
            <div className="space-y-3 mt-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-xs text-slate-500 mb-1.5">Max body size</label><input className="input font-mono text-xs" placeholder="10m" value={form.client_max_body_size} onChange={e => set('client_max_body_size', e.target.value)} /></div>
                <div><label className="block text-xs text-slate-500 mb-1.5">Read timeout (s)</label><input className="input" type="number" value={form.proxy_read_timeout} onChange={e => set('proxy_read_timeout', Number(e.target.value))} /></div>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Custom nginx directives <span className="text-slate-600">(inside location /)</span></label>
                <textarea className="input font-mono text-xs resize-none" rows={4} placeholder={'add_header X-Frame-Options DENY;'} value={form.custom_directives} onChange={e => set('custom_directives', e.target.value)} />
              </div>
            </div>
          )}
        </div>

        <div>
          <button onClick={() => { if (!showPreview) loadPreview(); setShowPreview(p => !p) }} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
            <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', showPreview && 'rotate-180')} /> {previewLoading ? 'Loading preview…' : 'Generated nginx config'}
          </button>
          {showPreview && (
            <pre className="mt-2 bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs font-mono text-emerald-400 leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto">
              {previewLoading ? 'Loading…' : (preview || '# fill in domain + upstream to generate')}
            </pre>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ─── Test result type ──────────────────────────────────────────────────────────
interface TestResult {
  ok: boolean; status_code?: number; status?: string
  dns_resolved: boolean; dns_addrs?: string[]; dns_points_here: boolean
  server_ip: string; nginx_ok: boolean; nginx_error?: string; hints: string[]
}

// ─── DNS / connectivity diagnostic modal ───────────────────────────────────────
function DiagModal({ host, result, onClose }: { host: ProxyHost; result: TestResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const recordName = host.domain.split('.').slice(0, -2).join('.') || '@'
  const copyIP = () => { navigator.clipboard?.writeText(result.server_ip).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {}) }

  const Step = ({ ok, icon: Icon, label, detail, pending }: { ok: boolean; icon: any; label: string; detail?: string; pending?: boolean }) => (
    <div className="flex items-start gap-3 py-3 border-b border-slate-800 last:border-0">
      <div className={clsx('w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5', ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400')}>
        {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : ok ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><Icon className="w-3.5 h-3.5 text-slate-500" /><p className="text-sm font-medium text-slate-200">{label}</p></div>
        {detail && <p className="text-xs text-slate-500 mt-1 font-mono break-all">{detail}</p>}
      </div>
    </div>
  )

  return (
    <Modal open onClose={onClose} size="md" icon={Activity} title="Host Diagnostics" subtitle={host.domain}>
      <div className="space-y-4">
        <StatusBadge meta={{ tone: result.ok ? 'running' : 'error', label: result.ok ? 'All checks passed' : 'Issues found' }} />

        <div className="bg-slate-950 border border-slate-800 rounded-xl px-4">
          <Step ok={result.dns_resolved} icon={Globe} label="DNS A record exists"
            detail={result.dns_resolved ? `${host.domain} → ${result.dns_addrs?.join(', ')}` : `${host.domain} has no A record`} />
          <Step ok={result.dns_points_here} icon={NetworkIcon} label="DNS points to this server"
            detail={result.dns_points_here ? `Resolves to this server ✓` : `Resolves to ${result.dns_addrs?.join(', ') || '—'}, expected ${result.server_ip}`} />
          <Step ok={result.nginx_ok} icon={Server} label="nginx → upstream reachable"
            detail={result.nginx_ok ? `${result.status} from ${host.upstream_host}:${host.upstream_port}` : result.nginx_error ?? 'nginx could not reach the upstream'} />
        </div>

        {/* Per-address DNS breakdown */}
        {result.dns_resolved && (result.dns_addrs?.length ?? 0) > 0 && (
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
            <p className="text-xs font-semibold text-slate-400 mb-2">Resolved addresses</p>
            <div className="space-y-1">
              {result.dns_addrs!.map(a => (
                <div key={a} className="flex items-center justify-between text-xs font-mono">
                  <span className="text-slate-300">{a}</span>
                  {result.dns_points_here
                    ? <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> reachable</span>
                    : <span className="text-slate-600">via proxy/CDN</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {result.hints.length > 0 && (
          <div className="rounded-xl bg-slate-950 border border-slate-800 divide-y divide-slate-800">
            {result.hints.map((h, i) => (
              <p key={i} className={clsx('text-xs px-4 py-2.5 leading-relaxed', result.ok ? 'text-emerald-400' : 'text-amber-300')}>
                {!result.ok && <span className="mr-1.5">→</span>}{h}
              </p>
            ))}
          </div>
        )}

        {!result.dns_resolved && (
          <div className="bg-slate-950 rounded-xl border border-slate-800 p-4 space-y-2">
            <p className="text-xs font-semibold text-slate-400">Add this DNS A record</p>
            <div className="font-mono text-xs bg-slate-900 rounded-lg p-3 space-y-1.5">
              <div className="flex gap-4"><span className="text-slate-600 w-14">Type</span><span className="text-blue-400">A</span></div>
              <div className="flex gap-4"><span className="text-slate-600 w-14">Name</span><span className="text-emerald-400">{recordName}</span></div>
              <div className="flex gap-4 items-center"><span className="text-slate-600 w-14">Value</span><span className="text-emerald-400">{result.server_ip}</span>
                <button onClick={copyIP} className="text-slate-500 hover:text-slate-300">{copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}</button>
              </div>
              <div className="flex gap-4"><span className="text-slate-600 w-14">TTL</span><span className="text-slate-400">300</span></div>
            </div>
          </div>
        )}

        {result.nginx_ok && result.dns_resolved && result.dns_points_here && host.ssl_enabled && (
          <Alert tone="warning">
            Self-signed certificate — browsers will warn. Click <b>Advanced → Proceed</b> to bypass, or disable SSL for HTTP-only internal use.
          </Alert>
        )}
      </div>
    </Modal>
  )
}

// ─── Main page ──────────────────────────────────────────────────────────────────
export default function ReverseProxyPage() {
  const toast = useToast()
  const { available, status, reload: reloadNginx } = useNginxStatus()
  const [hosts, setHosts] = useState<ProxyHost[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [testBusy, setTestBusy] = useState('')
  const [nginxBusy, setNginxBusy] = useState<'' | 'start' | 'restart' | 'reload' | 'stop'>('')

  const nginxControl = async (action: 'start' | 'restart' | 'reload' | 'stop') => {
    setNginxBusy(action)
    try {
      const r = await api.nginxSystemControl(action)
      toast.success(`nginx ${action} → ${r.status || 'done'}`)
      reloadNginx()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `nginx ${action} failed`)
    } finally { setNginxBusy('') }
  }
  const [diagHost, setDiagHost] = useState<{ host: ProxyHost; result: TestResult } | null>(null)
  const [serverIP, setServerIP] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editHost, setEditHost] = useState<ProxyHost | null>(null)

  const load = async () => { setLoading(true); try { setHosts(await api.listProxyHosts()) } catch {} setLoading(false) }
  useEffect(() => { load(); api.serverIP().then(r => setServerIP(r.ip)).catch(() => {}) }, [])

  const onSaved = (h: ProxyHost) => {
    setHosts(prev => { const idx = prev.findIndex(x => x.id === h.id); return idx >= 0 ? prev.map(x => x.id === h.id ? h : x) : [...prev, h] })
    setShowModal(false); toast.success(`Host ${h.domain} ${editHost ? 'updated' : 'added'}`)
  }
  const toggle = async (h: ProxyHost) => {
    setBusy(h.id)
    try { const u = await api.toggleProxyHost(h.id); setHosts(prev => prev.map(x => x.id === h.id ? u : x)); toast.success(`${u.domain} ${u.enabled ? 'enabled' : 'disabled'}`) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') } setBusy('')
  }
  const remove = async (id: string) => {
    setBusy(id)
    try { await api.deleteProxyHost(id); setHosts(prev => prev.filter(x => x.id !== id)); toast.success('Host deleted') }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') } setDeleteId(null); setBusy('')
  }
  const testHost = async (h: ProxyHost) => {
    setTestBusy(h.id)
    try { const r = await api.testProxyHost(h.id); setTestResults(prev => ({ ...prev, [h.id]: r })); setDiagHost({ host: h, result: r }) }
    catch (e) {
      const r: TestResult = { ok: false, dns_resolved: false, dns_points_here: false, server_ip: '', nginx_ok: false, nginx_error: e instanceof Error ? e.message : 'Failed', hints: ['Could not reach the OffDock server'] }
      setTestResults(prev => ({ ...prev, [h.id]: r })); setDiagHost({ host: h, result: r })
    }
    setTestBusy('')
  }

  const nginxOk = available && status === 'active'

  return (
    <Page>
      <PageHeader title="Reverse Proxy" subtitle="Map domains to upstreams via nginx" icon={Globe}
        actions={<>
          <button onClick={() => { load(); reloadNginx() }} className="btn-secondary"><RefreshCw className="w-4 h-4" /> Refresh</button>
          <button onClick={() => { setEditHost(null); setShowModal(true) }} className="btn-primary"><Plus className="w-4 h-4" /> Add Host</button>
        </>} />

      {diagHost && <DiagModal host={diagHost.host} result={diagHost.result} onClose={() => setDiagHost(null)} />}
      {showModal && <HostModal host={editHost} onSave={onSaved} onClose={() => setShowModal(false)} />}
      {deleteId && (
        <ConfirmModal title="Delete host?" danger confirmLabel="Delete"
          message="The nginx config file will be removed and nginx reloaded." onConfirm={() => remove(deleteId)} onCancel={() => setDeleteId(null)} />
      )}

      {/* nginx status + service control */}
      <div className={clsx('flex flex-wrap items-center gap-3 px-4 py-2.5 rounded-xl border mb-4', nginxOk ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20')}>
        <span className={clsx('w-2 h-2 rounded-full', nginxOk ? 'bg-emerald-400 animate-pulse' : 'bg-red-500')} />
        <span className="text-sm font-medium text-slate-200">nginx</span>
        <span className="text-xs text-slate-500">system · native</span>
        <StatusBadge meta={{ tone: nginxOk ? 'running' : 'error', label: available ? (status || 'unknown') : 'not installed' }} />
        {available && (
          <div className="ml-auto flex items-center gap-1.5">
            {nginxOk ? (
              <>
                <button onClick={() => nginxControl('reload')} disabled={nginxBusy !== ''} title="Test config and reload (no downtime)"
                  className="px-2.5 py-1 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40">
                  {nginxBusy === 'reload' ? 'Reloading…' : 'Reload'}
                </button>
                <button onClick={() => nginxControl('restart')} disabled={nginxBusy !== ''} title="Full restart"
                  className="px-2.5 py-1 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40">
                  {nginxBusy === 'restart' ? 'Restarting…' : 'Restart'}
                </button>
              </>
            ) : (
              <button onClick={() => nginxControl('start')} disabled={nginxBusy !== ''} title="Start nginx"
                className="px-2.5 py-1 rounded-lg text-xs bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40">
                {nginxBusy === 'start' ? 'Starting…' : 'Start nginx'}
              </button>
            )}
          </div>
        )}
        {!available && <span className="text-xs text-slate-500 ml-auto">Install: <code>sudo apt-get install -y nginx</code></span>}
      </div>

      <Panel title="Proxy Hosts" icon={Globe} actions={serverIP && <span className="text-xs text-slate-500">server <code className="text-blue-400">{serverIP}</code></span>}>
        {loading ? (
          <div className="p-4 space-y-2">{[0,1,2].map(i => <div key={i} className="h-14 skeleton rounded-lg" />)}</div>
        ) : hosts.length === 0 ? (
          <EmptyState icon={Globe} title="No proxy hosts yet" description="Map a domain to any upstream — a container, a local port, or any IP:port."
            action={<button onClick={() => { setEditHost(null); setShowModal(true) }} className="btn-primary"><Plus className="w-4 h-4" /> Add first host</button>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="th text-left">Domain</th>
                  <th className="th text-left">Upstream</th>
                  <th className="th text-left">SSL</th>
                  <th className="th text-left">Test</th>
                  <th className="th text-left">Enabled</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {hosts.map(h => {
                  const tr = testResults[h.id]
                  const selfSigned = h.ssl_enabled && h.ssl_pem_path.startsWith('/var/offdock/certs/')
                  return (
                    <tr key={h.id} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <a href={`http${h.ssl_enabled ? 's' : ''}://${h.domain}`} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-sm text-blue-400 hover:text-blue-300">
                          {h.domain} <ExternalLink className="w-3 h-3" />
                        </a>
                        {(h.aliases ?? []).length > 0 && <div className="text-xs text-slate-600 font-mono mt-0.5 truncate max-w-[220px]">+ {(h.aliases ?? []).join(', ')}</div>}
                        {(h.locations ?? []).length > 0 && <div className="text-xs text-slate-600 mt-0.5">{(h.locations ?? []).length} extra location{(h.locations ?? []).length > 1 ? 's' : ''}</div>}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-400">{h.upstream_host}:{h.upstream_port}</td>
                      <td className="px-4 py-3">
                        {h.ssl_enabled
                          ? <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-emerald-500/10 text-emerald-300 border-emerald-500/20">{selfSigned ? <ShieldAlert className="w-3 h-3" /> : <ShieldCheck className="w-3 h-3" />} HTTPS</span>
                          : <span className="text-xs text-slate-500">HTTP</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button onClick={() => testHost(h)} disabled={testBusy === h.id}
                            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 disabled:opacity-40">
                            {testBusy === h.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />} Test
                          </button>
                          {tr && (
                            <button onClick={() => setDiagHost({ host: h, result: tr })}
                              className={clsx('flex items-center gap-1 text-xs', tr.ok ? 'text-emerald-400' : 'text-red-400')}>
                              <span className={clsx('w-1.5 h-1.5 rounded-full', tr.ok ? 'bg-emerald-400' : 'bg-red-400')} />
                              {tr.ok ? 'OK' : !tr.dns_resolved ? 'DNS missing' : !tr.dns_points_here ? 'DNS mismatch' : 'Proxy error'}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => toggle(h)} disabled={busy === h.id}
                          className={clsx('relative inline-flex h-5 w-9 items-center rounded-full transition-colors', h.enabled ? 'bg-blue-600' : 'bg-slate-700')}>
                          <span className={clsx('inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform', h.enabled ? 'translate-x-4' : 'translate-x-1')} />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-0.5 justify-end">
                          <IconButton icon={Pencil} title="Edit" onClick={() => { setEditHost(h); setShowModal(true) }} />
                          <IconButton icon={Trash2} tone="danger" title="Delete" onClick={() => setDeleteId(h.id)} />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <AdvancedConfigsPanel onReload={reloadNginx} />
    </Page>
  )
}

// ─── Advanced: raw custom nginx configs (http + TCP/UDP stream) ────────────────
const NGINX_TEMPLATES: Record<string, { label: string; kind: 'http' | 'stream'; body: string }> = {
  tcp: {
    label: 'TCP passthrough (e.g. Postgres 5432 → container)',
    kind: 'stream',
    body: `# Expose a raw TCP port on the host, forwarded to an upstream.
server {
    listen 5432;                 # public TCP port on the host
    proxy_pass 127.0.0.1:15432;   # upstream host:port (e.g. a container's published port)
    proxy_timeout 1h;
    proxy_connect_timeout 5s;
}`,
  },
  udp: {
    label: 'UDP proxy (e.g. DNS/game/syslog on 53)',
    kind: 'stream',
    body: `# Forward a UDP port (add "udp" to listen).
server {
    listen 53 udp;
    proxy_pass 127.0.0.1:1053;
    proxy_timeout 30s;
    proxy_responses 1;
}`,
  },
  tcpssl: {
    label: 'TCP with TLS termination',
    kind: 'stream',
    body: `server {
    listen 6443 ssl;
    ssl_certificate     /var/offdock/certs/offdock.pem;
    ssl_certificate_key /var/offdock/certs/offdock.pem;
    proxy_pass 127.0.0.1:6379;     # plaintext upstream behind TLS
}`,
  },
  httpserver: {
    label: 'Custom HTTP server block (full control)',
    kind: 'http',
    body: `server {
    listen 80;
    server_name example.local;

    # static files
    root /var/www/example;
    index index.html;

    location / { try_files $uri $uri/ =404; }

    # api proxy
    location /api/ {
        proxy_pass http://127.0.0.1:9000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}`,
  },
  redirect: {
    label: 'Domain redirect',
    kind: 'http',
    body: `server {
    listen 80;
    server_name old.example.com;
    return 301 https://new.example.com$request_uri;
}`,
  },
  ratelimit: {
    label: 'Rate-limited HTTP proxy',
    kind: 'http',
    body: `# Note: limit_req_zone must live in the http{} context. Put it in a separate
# "http" custom config (it is included before server blocks).
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
server {
    listen 80;
    server_name api.example.local;
    location / {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://127.0.0.1:8080;
    }
}`,
  },
}

function AdvancedConfigsPanel({ onReload }: { onReload: () => void }) {
  const toast = useToast()
  const [configs, setConfigs] = useState<import('../api/client').NginxCustomConfig[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<import('../api/client').NginxCustomConfig | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [allConfigs, setAllConfigs] = useState<import('../api/client').ManagedNginxConfig[]>([])

  const load = () => api.listNginxCustom().then(c => setConfigs(c ?? [])).catch(() => {})
  useEffect(() => { if (open) load() }, [open])

  const del = async (id: string) => {
    try { await api.deleteNginxCustom(id); toast.success('Config removed'); load(); onReload() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed') }
  }
  const viewAll = async () => {
    try { const r = await api.listAllNginxConfigs(); setAllConfigs(r.configs ?? []); setShowAll(true) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not load configs') }
  }

  return (
    <Panel className="mt-5">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800/30 transition-colors rounded-t-xl">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-medium text-slate-200">Advanced — custom nginx configs (HTTP &amp; TCP/UDP streams)</span>
        </div>
        <ChevronDown className={clsx('w-4 h-4 text-slate-500 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-slate-800 pt-4 space-y-3">
          <p className="text-xs text-slate-500">
            Write raw nginx config OffDock can't express in the form above — full <code className="font-mono">server</code> blocks,
            redirects, rate limits, and <strong>TCP/UDP stream proxying</strong> (open a raw port over the host, e.g. expose a
            database or game server). Each config is validated with <code className="font-mono">nginx -t</code> before it's applied —
            a broken config is rolled back automatically.
          </p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => { setEditing(null); setShowEditor(true) }} className="btn-primary text-xs"><Plus className="w-3.5 h-3.5" /> New custom config</button>
            <button onClick={viewAll} className="btn-secondary text-xs">View all nginx configs</button>
          </div>

          {configs.length === 0 ? (
            <p className="text-xs text-slate-600 italic">No custom configs yet.</p>
          ) : (
            <div className="space-y-1.5">
              {configs.map(c => (
                <div key={c.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-900/60 border border-slate-800">
                  <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-mono', c.kind === 'stream' ? 'bg-violet-500/15 text-violet-300' : 'bg-blue-500/15 text-blue-300')}>{c.kind}</span>
                  <span className="font-mono text-xs text-slate-200 flex-1 min-w-0 truncate">{c.name}</span>
                  {!c.enabled && <span className="text-[10px] text-slate-500">disabled</span>}
                  <button onClick={() => { setEditing(c); setShowEditor(true) }} className="text-slate-500 hover:text-slate-200" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                  <button onClick={() => del(c.id)} className="text-slate-500 hover:text-red-400" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showEditor && <CustomConfigEditor config={editing} onSaved={() => { setShowEditor(false); load(); onReload() }} onClose={() => setShowEditor(false)} />}
      {showAll && (
        <Modal open onClose={() => setShowAll(false)} size="lg" icon={Server} title="All OffDock-managed nginx configs"
          subtitle="Every vhost and stream config OffDock writes on this host">
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {allConfigs.length === 0 ? <p className="text-xs text-slate-500">No managed configs found.</p> : allConfigs.map(c => (
              <details key={c.dir + c.file} className="rounded-lg border border-slate-800 bg-slate-950">
                <summary className="cursor-pointer px-3 py-2 text-xs text-slate-300 flex items-center gap-2">
                  <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-mono', c.kind === 'stream' ? 'bg-violet-500/15 text-violet-300' : 'bg-blue-500/15 text-blue-300')}>{c.kind}</span>
                  <span className="font-mono">{c.file}</span>
                  <span className="text-slate-600 ml-auto">{c.dir}</span>
                </summary>
                <pre className="px-3 pb-3 text-[11px] text-slate-400 overflow-x-auto whitespace-pre">{c.content}</pre>
              </details>
            ))}
          </div>
        </Modal>
      )}
    </Panel>
  )
}

function CustomConfigEditor({ config, onSaved, onClose }: {
  config: import('../api/client').NginxCustomConfig | null
  onSaved: () => void; onClose: () => void
}) {
  const toast = useToast()
  const [name, setName] = useState(config?.name ?? '')
  const [kind, setKind] = useState<'http' | 'stream'>(config?.kind ?? 'http')
  const [content, setContent] = useState(config?.content ?? '')
  const [enabled, setEnabled] = useState(config?.enabled ?? true)
  const [busy, setBusy] = useState(false)

  const applyTemplate = (key: string) => {
    const t = NGINX_TEMPLATES[key]
    if (!t) return
    setKind(t.kind); setContent(t.body)
  }

  const save = async () => {
    setBusy(true)
    try {
      await api.saveNginxCustom({ id: config?.id, name: name.trim(), kind, content, enabled })
      toast.success('Config applied (nginx validated & reloaded)')
      onSaved()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Apply failed'); setBusy(false) }
  }

  return (
    <Modal open onClose={busy ? () => {} : onClose} size="lg" icon={Server}
      title={config ? 'Edit custom nginx config' : 'New custom nginx config'}
      subtitle="Validated with nginx -t before applying — a bad config is rolled back"
      footer={<>
        <button onClick={onClose} disabled={busy} className="btn-secondary">Cancel</button>
        <button onClick={save} disabled={busy || !name.trim() || !content.trim()} className="btn-primary">{busy ? 'Applying…' : 'Apply config'}</button>
      </>}>
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-1">
            <label className="block text-xs text-slate-500 mb-1">Name</label>
            <input className="input font-mono" placeholder="my-tcp-proxy" value={name} onChange={e => setName(e.target.value)} disabled={!!config} />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Type</label>
            <select className="select" value={kind} onChange={e => setKind(e.target.value as 'http' | 'stream')}>
              <option value="http">http — server block (web)</option>
              <option value="stream">stream — TCP / UDP port</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Start from template</label>
            <select className="select" defaultValue="" onChange={e => applyTemplate(e.target.value)}>
              <option value="">— pick a template —</option>
              {Object.entries(NGINX_TEMPLATES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">nginx config {kind === 'stream' ? '(written into the stream {} context)' : '(a full server {} block)'}</label>
          <textarea className="input font-mono text-xs h-72 leading-relaxed" spellCheck={false} value={content} onChange={e => setContent(e.target.value)}
            placeholder={kind === 'stream' ? 'server {\n    listen 5432;\n    proxy_pass 127.0.0.1:15432;\n}' : 'server {\n    listen 80;\n    server_name example.local;\n    location / { proxy_pass http://127.0.0.1:9000; }\n}'} />
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enabled (write &amp; load this config)
        </label>
        {kind === 'stream' && (
          <p className="text-[11px] text-amber-400/80">
            Stream configs open a raw port on the host — make sure that port is allowed in your firewall (ufw) and not already in use.
          </p>
        )}
      </div>
    </Modal>
  )
}
