import { useEffect, useState } from 'react'
import { api, OAuthSettings } from '../api/client'
import { useAuth } from '../hooks/useAuth'
import { Page, PageHeader, Panel, Alert } from '../components/ui'
import { useToast } from '../components/Toast'
import {
  Settings, ShieldCheck, Save, Eye, EyeOff, Loader2,
  CheckCircle2, Link2, KeyRound, Tag, Info,
} from 'lucide-react'
import clsx from 'clsx'

// ─── Toggle switch ────────────────────────────────────────────────────────────
function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none',
        checked ? 'bg-blue-600' : 'bg-slate-700',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span className={clsx(
        'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transform transition-transform duration-200',
        checked ? 'translate-x-5' : 'translate-x-0',
      )} />
    </button>
  )
}

// ─── Field row ────────────────────────────────────────────────────────────────
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[200px_1fr] items-start gap-x-6 gap-y-1 py-4 border-b border-slate-800/60 last:border-0">
      <div className="pt-2">
        <p className="text-sm font-medium text-slate-300">{label}</p>
        {hint && <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">{hint}</p>}
      </div>
      <div>{children}</div>
    </div>
  )
}

// ─── Section header ───────────────────────────────────────────────────────────
function SectionHeader({ icon: Icon, title, description, badge }: {
  icon: React.ElementType; title: string; description: string; badge?: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3 px-5 py-4 border-b border-slate-800">
      <div className="w-9 h-9 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="w-4 h-4 text-indigo-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
          {badge}
        </div>
        <p className="text-xs text-slate-500 mt-0.5">{description}</p>
      </div>
    </div>
  )
}

// ─── Status pill ──────────────────────────────────────────────────────────────
function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span className={clsx(
      'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border',
      enabled
        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
        : 'bg-slate-800 text-slate-500 border-slate-700',
    )}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', enabled ? 'bg-emerald-400' : 'bg-slate-600')} />
      {enabled ? 'Active' : 'Disabled'}
    </span>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const { user } = useAuth()
  const toast = useToast()
  const isSuperAdmin = user?.role === 'superadmin'

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [oauth, setOauth] = useState<OAuthSettings | null>(null)

  // Form state
  const [enabled, setEnabled] = useState(false)
  const [issuer, setIssuer] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [redirectUri, setRedirectUri] = useState('')
  const [scope, setScope] = useState('openid profile email')
  const [claimSub, setClaimSub] = useState('sub')
  const [claimEmail, setClaimEmail] = useState('mail')
  const [claimUsername, setClaimUsername] = useState('uid')
  const [claimName, setClaimName] = useState('cn')
  const [claimFirst, setClaimFirst] = useState('givenName')
  const [claimLast, setClaimLast] = useState('sn')
  const [caCertFile, setCaCertFile] = useState('')
  const [tlsSkipVerify, setTlsSkipVerify] = useState(false)

  useEffect(() => {
    api.getOAuthSettings()
      .then(s => {
        setOauth(s)
        setEnabled(s.enabled)
        setIssuer(s.issuer ?? '')
        setClientId(s.client_id ?? '')
        setRedirectUri(s.redirect_uri ?? '')
        setScope(s.scope || 'openid profile email')
        setClaimSub(s.claim_sub || 'sub')
        setClaimEmail(s.claim_email || 'mail')
        setClaimUsername(s.claim_username || 'uid')
        setClaimName(s.claim_name || 'cn')
        setClaimFirst(s.claim_first || 'givenName')
        setClaimLast(s.claim_last || 'sn')
        setCaCertFile(s.ca_cert_file || '')
        setTlsSkipVerify(s.tls_skip_verify || false)
      })
      .catch(() => toast.error('Could not load settings'))
      .finally(() => setLoading(false))
  }, []) // eslint-disable-line

  const handleSave = async () => {
    if (!isSuperAdmin) return
    setSaving(true)
    try {
      await api.saveOAuthSettings({
        enabled, issuer, client_id: clientId,
        client_secret: clientSecret || undefined,
        redirect_uri: redirectUri, scope,
        claim_sub: claimSub || undefined,
        claim_email: claimEmail || undefined,
        claim_username: claimUsername || undefined,
        claim_name: claimName || undefined,
        claim_first: claimFirst || undefined,
        claim_last: claimLast || undefined,
        ca_cert_file: caCertFile || undefined,
        tls_skip_verify: tlsSkipVerify,
      })
      setClientSecret('')
      setOauth(prev => prev ? {
        ...prev, enabled, issuer, client_id: clientId,
        redirect_uri: redirectUri, scope,
        secret_set: prev.secret_set || clientSecret !== '',
        claim_sub: claimSub, claim_email: claimEmail,
        claim_username: claimUsername, claim_name: claimName,
        claim_first: claimFirst, claim_last: claimLast,
      } : prev)
      toast.success('Settings saved')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Page>
        <div className="flex items-center justify-center h-64 text-slate-500 gap-2">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Loading settings…</span>
        </div>
      </Page>
    )
  }

  return (
    <Page>
      <PageHeader
        title="Settings"
        subtitle="System and integration configuration"
        icon={Settings}
        actions={isSuperAdmin ? (
          <button onClick={handleSave} disabled={saving} className="btn-primary gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        ) : undefined}
      />

      <div className="max-w-3xl space-y-6">

        {/* Read-only notice for non-superadmins */}
        {!isSuperAdmin && (
          <Alert tone="info">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 shrink-0" />
              <span>Settings are read-only. Superadmin access is required to make changes.</span>
            </div>
          </Alert>
        )}

        {/* ── AO ID OAuth2 section ── */}
        <Panel>
          <SectionHeader
            icon={ShieldCheck}
            title="AO ID OAuth2 / SSO"
            description="Allow users to sign in with their AO ID identity provider account using PKCE authorization code flow."
            badge={oauth && <StatusPill enabled={oauth.enabled} />}
          />

          <div className="px-5">
            {/* Enable toggle */}
            <Field label="Enable SSO login" hint="Shows the AO ID sign-in button on the login page. Issuer URL and Client ID must also be set.">
              <div className="flex items-center gap-3 pt-2">
                <Toggle checked={enabled} onChange={setEnabled} disabled={!isSuperAdmin} />
                <span className="text-sm text-slate-400">{enabled ? 'Enabled' : 'Disabled'}</span>
              </div>
              {enabled && (!issuer.trim() || !clientId.trim()) && (
                <p className="mt-2 text-xs text-amber-400 flex items-center gap-1.5">
                  <span>⚠</span>
                  {!issuer.trim() && !clientId.trim()
                    ? 'Issuer URL and Client ID are required for the login button to appear.'
                    : !issuer.trim()
                    ? 'Issuer URL is required for the login button to appear.'
                    : 'Client ID is required for the login button to appear.'}
                </p>
              )}
            </Field>
          </div>

          {/* Connection settings */}
          <div className="px-5 pb-1">
            <div className="flex items-center gap-2 pt-2 pb-1">
              <Link2 className="w-3.5 h-3.5 text-slate-600" />
              <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-widest">Connection</span>
            </div>

            <Field label="Issuer URL" hint="Base URL of the AO ID server, e.g. https://auth.ao.az">
              <input
                className="input w-full"
                value={issuer}
                onChange={e => setIssuer(e.target.value)}
                disabled={!isSuperAdmin}
                placeholder="https://auth.ao.az"
              />
            </Field>

            <Field label="Client ID" hint="Application identifier registered in AO ID.">
              <input
                className="input w-full"
                value={clientId}
                onChange={e => setClientId(e.target.value)}
                disabled={!isSuperAdmin}
                placeholder="offdock"
              />
            </Field>

            <Field
              label="Client Secret"
              hint={oauth?.secret_set ? 'Currently set. Leave blank to keep existing.' : 'Optional — leave blank for public PKCE client.'}
            >
              <div className="relative">
                <input
                  className="input w-full pr-9"
                  type={showSecret ? 'text' : 'password'}
                  value={clientSecret}
                  onChange={e => setClientSecret(e.target.value)}
                  disabled={!isSuperAdmin}
                  placeholder={oauth?.secret_set ? '(unchanged)' : 'optional'}
                />
                <button
                  type="button"
                  onClick={() => setShowSecret(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                >
                  {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </Field>

            <Field label="Redirect URI" hint="Must exactly match the URI registered in AO ID.">
              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  value={redirectUri}
                  onChange={e => setRedirectUri(e.target.value)}
                  disabled={!isSuperAdmin}
                  placeholder="https://offdock.host/api/v1/auth/oauth/callback"
                />
                {isSuperAdmin && (
                  <button
                    type="button"
                    onClick={() => setRedirectUri(window.location.origin + '/api/v1/auth/oauth/callback')}
                    className="btn-secondary shrink-0 text-xs whitespace-nowrap"
                  >
                    Auto-fill
                  </button>
                )}
              </div>
            </Field>

            <Field label="Scopes" hint="Space-separated OAuth2 scopes to request.">
              <input
                className="input w-full"
                value={scope}
                onChange={e => setScope(e.target.value)}
                disabled={!isSuperAdmin}
                placeholder="openid profile email"
              />
            </Field>
          </div>

          {/* TLS / Certificate settings */}
          <div className="px-5 pb-2">
            <div className="flex items-center gap-2 pt-1 pb-1">
              <KeyRound className="w-3.5 h-3.5 text-slate-600" />
              <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-widest">TLS / Certificate</span>
            </div>
            <p className="text-xs text-slate-600 mb-3">
              If your AO ID server uses a self-signed or internal CA certificate, provide the path here.
              Accepts <code className="font-mono text-slate-500">.pem</code>, <code className="font-mono text-slate-500">.crt</code>, <code className="font-mono text-slate-500">.cer</code>, or <code className="font-mono text-slate-500">.der</code> files.
            </p>
            <Field
              label="CA Certificate File"
              hint="Path on the server to a PEM/CRT/CER/DER file. Leave blank to use system CAs."
            >
              <input
                className="input w-full font-mono text-xs"
                value={caCertFile}
                onChange={e => setCaCertFile(e.target.value)}
                disabled={!isSuperAdmin}
                placeholder="/etc/offdock/certs/ao-id-ca.pem"
              />
            </Field>
            <Field
              label="Skip TLS Verification"
              hint="Disable certificate validation entirely. Use CA cert instead when possible."
            >
              <div className="flex items-center gap-3 pt-2">
                <Toggle checked={tlsSkipVerify} onChange={setTlsSkipVerify} disabled={!isSuperAdmin} />
                <span className={clsx('text-xs', tlsSkipVerify ? 'text-amber-400' : 'text-slate-500')}>
                  {tlsSkipVerify ? '⚠ Verification disabled' : 'Enabled (recommended)'}
                </span>
              </div>
            </Field>
          </div>

          {/* Claim mappings */}
          <div className="px-5 pb-4">
            <div className="flex items-center gap-2 pt-3 pb-1">
              <Tag className="w-3.5 h-3.5 text-slate-600" />
              <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-widest">Claim Mappings</span>
            </div>
            <p className="text-xs text-slate-600 mb-4">
              Map JWT / UserInfo claim names to OffDock user attributes. Defaults match AO ID LDAP claim names (mail, cn, uid, givenName, sn). Changes take effect immediately without restart.
            </p>

            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Subject (unique ID)', placeholder: 'sub', value: claimSub, onChange: setClaimSub },
                { label: 'Email address', placeholder: 'mail', value: claimEmail, onChange: setClaimEmail },
                { label: 'Username', placeholder: 'uid', value: claimUsername, onChange: setClaimUsername },
                { label: 'Full name (cn)', placeholder: 'cn', value: claimName, onChange: setClaimName },
                { label: 'First name', placeholder: 'givenName', value: claimFirst, onChange: setClaimFirst },
                { label: 'Last name', placeholder: 'sn', value: claimLast, onChange: setClaimLast },
              ].map(f => (
                <div key={f.label} className="bg-slate-950/50 border border-slate-800 rounded-lg p-3">
                  <label className="block text-xs text-slate-500 mb-1.5">{f.label}</label>
                  <input
                    className="input w-full font-mono text-xs"
                    value={f.value}
                    onChange={e => f.onChange(e.target.value)}
                    disabled={!isSuperAdmin}
                    placeholder={f.placeholder}
                  />
                </div>
              ))}
            </div>
          </div>
        </Panel>

        {/* ── Setup guide ── */}
        <Panel>
          <SectionHeader
            icon={CheckCircle2}
            title="Setup Guide"
            description="Steps to configure AO ID before enabling SSO login."
          />
          <div className="px-5 py-4">
            <ol className="space-y-3">
              {[
                { n: '1', text: 'In the AO ID admin panel, create a new application for OffDock.' },
                { n: '2', text: 'Copy the Client ID into the field above.' },
                { n: '3', text: <>Set the Redirect URI to <code className="font-mono bg-slate-800 px-1.5 py-0.5 rounded text-blue-300 text-xs">{window.location.origin}/api/v1/auth/oauth/callback</code></> },
                { n: '4', text: 'Grant users app access inside AO ID — they cannot log in without it.' },
                { n: '5', text: 'Enable the toggle above and save. The AO ID button will appear on the login page.' },
                { n: '6', text: 'OAuth-provisioned users start with the Viewer role. Elevate them in the Users page.' },
              ].map(step => (
                <li key={step.n} className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full bg-blue-600/20 border border-blue-500/30 text-blue-400 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                    {step.n}
                  </span>
                  <span className="text-sm text-slate-400 leading-relaxed">{step.text}</span>
                </li>
              ))}
            </ol>

            <div className="mt-5 flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-amber-500/5 border border-amber-500/20">
              <KeyRound className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-300/80">
                For public (PKCE) clients leave Client Secret blank — OffDock uses S256 PKCE by default and does not require a secret.
              </p>
            </div>
          </div>
        </Panel>

      </div>
    </Page>
  )
}
