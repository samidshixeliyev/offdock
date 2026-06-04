import { useEffect, useState } from 'react'
import { api, OAuthSettings } from '../api/client'
import { useAuth } from '../hooks/useAuth'
import { Settings, ShieldCheck, Save, Eye, EyeOff, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import clsx from 'clsx'

export default function SettingsPage() {
  const { user } = useAuth()
  const isSuperAdmin = user?.role === 'superadmin'

  const [oauth, setOauth] = useState<OAuthSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null)

  // OAuth form state
  const [enabled, setEnabled] = useState(false)
  const [issuer, setIssuer] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [redirectUri, setRedirectUri] = useState('')
  const [scope, setScope] = useState('openid profile email')
  const [showSecret, setShowSecret] = useState(false)
  const [claimSub, setClaimSub] = useState('sub')
  const [claimEmail, setClaimEmail] = useState('email')
  const [claimUsername, setClaimUsername] = useState('ldap_username')
  const [claimName, setClaimName] = useState('display_name')

  const notify = (msg: string, type: 'ok' | 'err' = 'ok') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  useEffect(() => {
    api.getOAuthSettings()
      .then(s => {
        setOauth(s)
        setEnabled(s.enabled)
        setIssuer(s.issuer)
        setClientId(s.client_id)
        setRedirectUri(s.redirect_uri)
        setScope(s.scope || 'openid profile email')
        setClaimSub(s.claim_sub || 'sub')
        setClaimEmail(s.claim_email || 'email')
        setClaimUsername(s.claim_username || 'ldap_username')
        setClaimName(s.claim_name || 'display_name')
      })
      .catch(() => notify('Could not load OAuth settings', 'err'))
      .finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    if (!isSuperAdmin) return
    setSaving(true)
    try {
      await api.saveOAuthSettings({
        enabled,
        issuer,
        client_id: clientId,
        client_secret: clientSecret || undefined,
        redirect_uri: redirectUri,
        scope,
        claim_sub: claimSub || undefined,
        claim_email: claimEmail || undefined,
        claim_username: claimUsername || undefined,
        claim_name: claimName || undefined,
      })
      setClientSecret('')
      setOauth(prev => prev ? { ...prev, enabled, issuer, client_id: clientId, redirect_uri: redirectUri, scope, secret_set: prev.secret_set || clientSecret !== '' } : prev)
      notify('OAuth settings saved')
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : 'Save failed', 'err')
    } finally {
      setSaving(false)
    }
  }

  const suggestRedirectUri = () => {
    const base = window.location.origin
    setRedirectUri(base + '/api/v1/auth/oauth/callback')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Toast */}
      {toast && (
        <div className={clsx(
          'fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-xl border shadow-xl text-sm animate-fadeIn',
          toast.type === 'ok'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            : 'bg-red-500/10 border-red-500/30 text-red-400',
        )}>
          {toast.type === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-blue-500/10 flex items-center justify-center">
          <Settings className="w-4.5 h-4.5 text-blue-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Settings</h1>
          <p className="text-xs text-slate-500">System configuration</p>
        </div>
      </div>

      {/* OAuth2 / SSO Card */}
      <div className="card">
        <div className="flex items-start gap-3 mb-5">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center shrink-0 mt-0.5">
            <ShieldCheck className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-200">AO ID OAuth2 / SSO</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Allow users to sign in with their AO ID identity provider account.
              {!isSuperAdmin && ' (read-only — superadmin only)'}
            </p>
          </div>
          {oauth && (
            <span className={clsx(
              'ml-auto shrink-0 px-2 py-0.5 rounded text-[10px] font-medium uppercase border',
              oauth.enabled
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-slate-800 text-slate-500 border-slate-700',
            )}>
              {oauth.enabled ? 'Enabled' : 'Disabled'}
            </span>
          )}
        </div>

        <div className="space-y-4">
          {/* Enabled toggle */}
          <label className="flex items-center justify-between p-3 rounded-lg bg-slate-800/60 border border-slate-700 cursor-pointer">
            <span className="text-sm text-slate-300">Enable AO ID login</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              disabled={!isSuperAdmin}
              onClick={() => isSuperAdmin && setEnabled(v => !v)}
              className={clsx(
                'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none',
                enabled ? 'bg-blue-600' : 'bg-slate-600',
                !isSuperAdmin && 'opacity-50 cursor-not-allowed',
              )}
            >
              <span className={clsx(
                'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform',
                enabled ? 'translate-x-4' : 'translate-x-0',
              )} />
            </button>
          </label>

          {/* Issuer URL */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Issuer URL <span className="text-slate-600">(IdP base URL, e.g. https://auth.ao.az)</span>
            </label>
            <input
              className="input"
              value={issuer}
              onChange={e => setIssuer(e.target.value)}
              disabled={!isSuperAdmin}
              placeholder="https://auth.ao.az"
            />
          </div>

          {/* Client ID */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Client ID</label>
            <input
              className="input"
              value={clientId}
              onChange={e => setClientId(e.target.value)}
              disabled={!isSuperAdmin}
              placeholder="offdock"
            />
          </div>

          {/* Client Secret */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Client Secret{' '}
              <span className="text-slate-600">
                (leave blank for PKCE public client{oauth?.secret_set ? ' — currently set' : ''})
              </span>
            </label>
            <div className="relative">
              <input
                className="input pr-9"
                type={showSecret ? 'text' : 'password'}
                value={clientSecret}
                onChange={e => setClientSecret(e.target.value)}
                disabled={!isSuperAdmin}
                placeholder={oauth?.secret_set ? '(unchanged)' : 'optional'}
              />
              <button
                type="button"
                onClick={() => setShowSecret(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Redirect URI */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Redirect URI <span className="text-slate-600">(must match registration in AO ID)</span>
            </label>
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
                  onClick={suggestRedirectUri}
                  className="btn-secondary shrink-0 text-xs px-3"
                  title="Use current origin"
                >
                  Auto-fill
                </button>
              )}
            </div>
          </div>

          {/* Scope */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Scope <span className="text-slate-600">(space-separated)</span>
            </label>
            <input
              className="input"
              value={scope}
              onChange={e => setScope(e.target.value)}
              disabled={!isSuperAdmin}
              placeholder="openid profile email"
            />
          </div>

          {/* Claim mappings */}
          <div className="border border-slate-800 rounded-xl p-4 space-y-3">
            <div>
              <p className="text-xs font-medium text-slate-300 mb-0.5">JWT / UserInfo Claim Mappings</p>
              <p className="text-xs text-slate-600">Configure which claim names to read from the IdP's token. Defaults match AO ID out-of-the-box.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Subject (unique ID) claim</label>
                <input className="input font-mono text-xs" value={claimSub} onChange={e => setClaimSub(e.target.value)} disabled={!isSuperAdmin} placeholder="sub" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Email claim</label>
                <input className="input font-mono text-xs" value={claimEmail} onChange={e => setClaimEmail(e.target.value)} disabled={!isSuperAdmin} placeholder="email" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Username claim</label>
                <input className="input font-mono text-xs" value={claimUsername} onChange={e => setClaimUsername(e.target.value)} disabled={!isSuperAdmin} placeholder="ldap_username" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1.5">Display name claim</label>
                <input className="input font-mono text-xs" value={claimName} onChange={e => setClaimName(e.target.value)} disabled={!isSuperAdmin} placeholder="display_name" />
              </div>
            </div>
          </div>

          {/* Info box */}
          <div className="px-3 py-3 rounded-lg bg-blue-500/5 border border-blue-500/20 text-blue-300 text-xs space-y-1">
            <p className="font-medium">Setup checklist</p>
            <ul className="list-disc list-inside space-y-0.5 text-blue-300/80">
              <li>Register Offdock as an application in AO ID admin panel</li>
              <li>Add the Redirect URI above to the application's allowed URIs</li>
              <li>Grant users app access in AO ID before they can log in</li>
              <li>OAuth-provisioned users get <strong>viewer</strong> role by default — elevate in Users page</li>
            </ul>
          </div>

          {isSuperAdmin && (
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="btn-primary gap-2"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {saving ? 'Saving…' : 'Save OAuth Settings'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
