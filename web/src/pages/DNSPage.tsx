import { useEffect, useState } from 'react'
import { api, DNSTicket, DNSTicketStatus, SMTPSettings } from '../api/client'
import {
  MapPin, Plus, Trash2, Send, Check, Settings,
  RefreshCw, ChevronDown, ChevronUp, AlertCircle, Eye, EyeOff, Loader2,
  TestTube,
} from 'lucide-react'
import clsx from 'clsx'

const STATUS_COLORS: Record<DNSTicketStatus, string> = {
  pending:  'bg-amber-500/10 text-amber-400 border-amber-500/20',
  sent:     'bg-blue-500/10 text-blue-400 border-blue-500/20',
  approved: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  rejected: 'bg-red-500/10 text-red-400 border-red-500/20',
}

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'PTR', 'CAA']

export default function DNSPage() {
  const [tickets, setTickets] = useState<DNSTicket[]>([])
  const [smtp, setSMTP] = useState<SMTPSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'tickets' | 'settings'>('tickets')
  const [showCreate, setShowCreate] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [showSmtpPass, setShowSmtpPass] = useState(false)
  const [testingEmail, setTestingEmail] = useState('')
  const [testingSmtp, setTestingSmtp] = useState(false)
  const [savingSmtp, setSavingSmtp] = useState(false)

  // Create form
  const [form, setForm] = useState({ record_type: 'A', hostname: '', value: '', ttl: 0, priority: 0, notes: '' })

  // SMTP form
  const [smtpForm, setSmtpForm] = useState<Partial<SMTPSettings> & { password?: string }>({})

  const notify = (msg: string, type: 'ok' | 'err' = 'ok') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const load = async () => {
    setLoading(true)
    try {
      const [t, s] = await Promise.all([api.listDNSTickets(), api.getSMTPSettings()])
      setTickets(t.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()))
      setSMTP(s)
      setSmtpForm({
        host: s.host, port: s.port, username: s.username,
        from: s.from, starttls: s.starttls,
        insecure_skip_verify: s.insecure_skip_verify,
        dns_admin_email: s.dns_admin_email,
      })
    } catch { }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const handleCreate = async () => {
    if (!form.hostname || !form.value) { notify('Hostname and value are required', 'err'); return }
    try {
      const t = await api.createDNSTicket(form)
      setTickets(ts => [t, ...ts])
      setShowCreate(false)
      setForm({ record_type: 'A', hostname: '', value: '', ttl: 0, priority: 0, notes: '' })
      notify('Ticket created')
    } catch (e: any) { notify(e.message || 'Create failed', 'err') }
  }

  const handleSend = async (id: string) => {
    setSendingId(id)
    try {
      const res = await api.sendDNSTicket(id)
      setTickets(ts => ts.map(t => t.id === id ? res.ticket : t))
      notify(`Sent to ${res.sent_to}`)
    } catch (e: any) { notify(e.message || 'Send failed', 'err') }
    setSendingId(null)
  }

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    try {
      await api.deleteDNSTicket(id)
      setTickets(ts => ts.filter(t => t.id !== id))
      notify('Ticket deleted')
    } catch (e: any) { notify(e.message || 'Delete failed', 'err') }
    setDeletingId(null)
  }

  const handleStatusChange = async (id: string, status: DNSTicketStatus) => {
    try {
      const t = await api.updateDNSTicket(id, { status })
      setTickets(ts => ts.map(x => x.id === id ? t : x))
    } catch (e: any) { notify(e.message || 'Update failed', 'err') }
  }

  const handleSaveSmtp = async () => {
    setSavingSmtp(true)
    try {
      await api.saveSMTPSettings(smtpForm)
      notify('SMTP settings saved')
      load()
    } catch (e: any) { notify(e.message || 'Save failed', 'err') }
    setSavingSmtp(false)
  }

  const handleTestSmtp = async () => {
    if (!testingEmail) { notify('Enter a test email address', 'err'); return }
    setTestingSmtp(true)
    try {
      await api.testSMTPSettings(testingEmail)
      notify(`Test email sent to ${testingEmail}`)
    } catch (e: any) { notify(e.message || 'Test failed', 'err') }
    setTestingSmtp(false)
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Toast */}
      {toast && (
        <div className={clsx('fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-xl text-sm font-medium border',
          toast.type === 'ok' ? 'bg-emerald-900/80 text-emerald-300 border-emerald-700/40' : 'bg-red-900/80 text-red-300 border-red-700/40')}>
          {toast.type === 'ok' ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-blue-500/10 border border-blue-500/20">
            <MapPin className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-100">DNS Management</h1>
            <p className="text-xs text-slate-500">Request DNS record creation via email ticket</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={() => setTab(t => t === 'tickets' ? 'settings' : 'tickets')}
            className={clsx('inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors',
              tab === 'settings' ? 'bg-slate-700 border-slate-600 text-slate-100' : 'border-slate-700 text-slate-400 hover:text-slate-200')}>
            <Settings className="w-4 h-4" /> SMTP Settings
          </button>
          {tab === 'tickets' && (
            <button onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors">
              <Plus className="w-4 h-4" /> New Ticket
            </button>
          )}
        </div>
      </div>

      {smtp && !smtp.configured && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm text-amber-300">
          <AlertCircle className="w-4 h-4 shrink-0" />
          SMTP not configured — email sending is disabled. Go to SMTP Settings to configure.
        </div>
      )}

      {/* Create form */}
      {showCreate && tab === 'tickets' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <h3 className="text-sm font-semibold text-slate-200">New DNS Record Request</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Record Type</label>
              <select value={form.record_type} onChange={e => setForm(f => ({ ...f, record_type: e.target.value }))}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500">
                {RECORD_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">TTL (seconds, 0 = default)</label>
              <input type="number" value={form.ttl} onChange={e => setForm(f => ({ ...f, ttl: parseInt(e.target.value) || 0 }))}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Hostname *</label>
              <input value={form.hostname} onChange={e => setForm(f => ({ ...f, hostname: e.target.value }))}
                placeholder="app.example.com"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Value *</label>
              <input value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                placeholder="IP address or target hostname"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
            </div>
            {(form.record_type === 'MX' || form.record_type === 'SRV') && (
              <div>
                <label className="block text-xs text-slate-500 mb-1">Priority</label>
                <input type="number" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: parseInt(e.target.value) || 0 }))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
              </div>
            )}
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1">Notes (optional)</label>
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                rows={2} placeholder="Purpose, justification, related service…"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500 resize-none" />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200">Cancel</button>
            <button onClick={handleCreate} className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium">Create Ticket</button>
          </div>
        </div>
      )}

      {/* Tickets list */}
      {tab === 'tickets' && (
        <div className="space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-slate-600">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
            </div>
          ) : tickets.length === 0 ? (
            <div className="text-center py-12 text-slate-600 text-sm">
              No DNS tickets yet. Click "New Ticket" to create one.
            </div>
          ) : tickets.map(t => (
            <div key={t.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="font-mono text-xs bg-slate-800 px-2 py-0.5 rounded text-slate-300">{t.record_type}</span>
                <span className="font-mono text-sm text-slate-200 font-medium">{t.hostname}</span>
                <span className="text-slate-600 text-xs">→</span>
                <span className="font-mono text-sm text-slate-400 truncate max-w-xs">{t.value}</span>
                <span className={clsx('ml-auto shrink-0 px-2 py-0.5 rounded-full text-xs border', STATUS_COLORS[t.status])}>
                  {t.status}
                </span>
                <button onClick={() => setExpandedId(id => id === t.id ? null : t.id)}
                  className="p-1 text-slate-500 hover:text-slate-300">
                  {expandedId === t.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
              </div>
              {expandedId === t.id && (
                <div className="border-t border-slate-800 px-4 py-4 space-y-3">
                  <div className="grid grid-cols-3 gap-4 text-xs">
                    <div><span className="text-slate-500">TTL</span><br /><span className="text-slate-300">{t.ttl || 'default'}</span></div>
                    {t.priority > 0 && <div><span className="text-slate-500">Priority</span><br /><span className="text-slate-300">{t.priority}</span></div>}
                    <div><span className="text-slate-500">Requested by</span><br /><span className="text-slate-300">{t.requested_by || '—'}</span></div>
                    <div><span className="text-slate-500">Created</span><br /><span className="text-slate-300">{new Date(t.created_at).toLocaleString()}</span></div>
                    {t.email_sent_to && <div><span className="text-slate-500">Sent to</span><br /><span className="text-slate-300 font-mono">{t.email_sent_to}</span></div>}
                  </div>
                  {t.notes && (
                    <div className="text-xs">
                      <span className="text-slate-500">Notes</span>
                      <p className="mt-1 text-slate-300 whitespace-pre-wrap">{t.notes}</p>
                    </div>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    <select value={t.status} onChange={e => handleStatusChange(t.id, e.target.value as DNSTicketStatus)}
                      className="text-xs bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-slate-300 focus:outline-none focus:border-blue-500">
                      {(['pending','sent','approved','rejected'] as DNSTicketStatus[]).map(s =>
                        <option key={s} value={s}>{s}</option>
                      )}
                    </select>
                    <button onClick={() => handleSend(t.id)} disabled={sendingId === t.id || !smtp?.configured}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-blue-600/20 border border-blue-600/30 text-blue-400 text-xs hover:bg-blue-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                      {sendingId === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      Send Email
                    </button>
                    <button onClick={() => handleDelete(t.id)} disabled={deletingId === t.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs hover:bg-red-500/20 disabled:opacity-40 transition-colors ml-auto">
                      {deletingId === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* SMTP Settings */}
      {tab === 'settings' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
          <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <Settings className="w-4 h-4 text-slate-400" /> SMTP Configuration
          </h3>
          <p className="text-xs text-slate-500">
            Configure your Exchange / Outlook SMTP server for OTP emails and DNS ticket notifications.
            Settings are saved to <code className="text-slate-400">/etc/offdock/config.yaml</code>.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-500 mb-1">SMTP Host *</label>
              <input value={smtpForm.host ?? ''} onChange={e => setSmtpForm(f => ({ ...f, host: e.target.value }))}
                placeholder="mail.corp.local"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Port</label>
              <input type="number" value={smtpForm.port ?? 587} onChange={e => setSmtpForm(f => ({ ...f, port: parseInt(e.target.value) || 587 }))}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Username</label>
              <input value={smtpForm.username ?? ''} onChange={e => setSmtpForm(f => ({ ...f, username: e.target.value }))}
                placeholder="user@corp.local"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Password</label>
              <div className="relative">
                <input type={showSmtpPass ? 'text' : 'password'}
                  value={smtpForm.password ?? ''} onChange={e => setSmtpForm(f => ({ ...f, password: e.target.value }))}
                  placeholder={smtp?.password_set ? '(unchanged)' : 'Enter password'}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 pr-9 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
                <button type="button" onClick={() => setShowSmtpPass(s => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                  {showSmtpPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">From Address</label>
              <input value={smtpForm.from ?? ''} onChange={e => setSmtpForm(f => ({ ...f, from: e.target.value }))}
                placeholder="offdock@corp.local"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">DNS Admin Email</label>
              <input value={smtpForm.dns_admin_email ?? ''} onChange={e => setSmtpForm(f => ({ ...f, dns_admin_email: e.target.value }))}
                placeholder="dns-admin@corp.local"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500" />
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={smtpForm.starttls ?? true}
                  onChange={e => setSmtpForm(f => ({ ...f, starttls: e.target.checked }))}
                  className="rounded border-slate-600 bg-slate-800" />
                Use STARTTLS
              </label>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={smtpForm.insecure_skip_verify ?? false}
                  onChange={e => setSmtpForm(f => ({ ...f, insecure_skip_verify: e.target.checked }))}
                  className="rounded border-slate-600 bg-slate-800" />
                Skip TLS verification (self-signed cert)
              </label>
            </div>
          </div>
          <div className="flex items-center gap-3 pt-2">
            <button onClick={handleSaveSmtp} disabled={savingSmtp}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50 transition-colors">
              {savingSmtp ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Save Settings
            </button>
            <div className="flex items-center gap-2 ml-4">
              <input value={testingEmail} onChange={e => setTestingEmail(e.target.value)}
                placeholder="test@example.com"
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500 w-52" />
              <button onClick={handleTestSmtp} disabled={testingSmtp}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-700 text-slate-300 hover:text-slate-100 text-sm disabled:opacity-50 transition-colors">
                {testingSmtp ? <Loader2 className="w-4 h-4 animate-spin" /> : <TestTube className="w-4 h-4" />}
                Test
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
