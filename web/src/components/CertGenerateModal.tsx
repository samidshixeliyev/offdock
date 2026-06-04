import { useState } from 'react'
import { api } from '../api/client'

interface Props {
  projectId: string
  defaultDomain?: string
  onSuccess: (pemPath: string) => void
  onClose: () => void
}

const VALIDITY_OPTIONS = [
  { label: '90 days', value: 90 },
  { label: '1 year', value: 365 },
  { label: '2 years', value: 730 },
  { label: '5 years', value: 1825 },
  { label: '10 years', value: 3650 },
]

export default function CertGenerateModal({ projectId, defaultDomain = '', onSuccess, onClose }: Props) {
  const [domain, setDomain] = useState(defaultDomain)
  const [dnsRaw, setDnsRaw] = useState('')
  const [ipRaw, setIpRaw] = useState('')
  const [org, setOrg] = useState('')
  const [country, setCountry] = useState('')
  const [days, setDays] = useState(365)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ pem_path: string; dns_names: string[]; ip_addresses: string[]; valid_until: string } | null>(null)
  const [err, setErr] = useState('')

  const generate = async () => {
    if (!domain.trim()) { setErr('Domain (CN) is required'); return }
    setBusy(true); setErr('')
    const dnsNames = dnsRaw.split('\n').map(s => s.trim()).filter(Boolean)
    const ipAddresses = ipRaw.split('\n').map(s => s.trim()).filter(Boolean)
    try {
      const r = await api.generateCert(projectId, {
        domain: domain.trim(),
        dns_names: dnsNames,
        ip_addresses: ipAddresses,
        organization: org.trim() || undefined,
        country: country.trim() || undefined,
        days,
      })
      setResult(r)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-white">Generate Self-Signed Certificate</h3>
            <p className="text-xs text-slate-500 mt-0.5">ECDSA P-256 · stored at /var/offdock/certs/</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {result ? (
            /* ── Success state ── */
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-green-950 text-green-400 flex items-center justify-center text-xs shrink-0">✓</span>
                <span className="text-sm text-green-300 font-medium">Certificate generated successfully</span>
              </div>
              <div className="bg-slate-950 rounded-lg border border-slate-800 p-4 space-y-2 text-xs font-mono">
                <div className="flex gap-3">
                  <span className="text-slate-600 w-20 shrink-0">PEM path</span>
                  <span className="text-blue-300 break-all">{result.pem_path}</span>
                </div>
                <div className="flex gap-3">
                  <span className="text-slate-600 w-20 shrink-0">Valid until</span>
                  <span className="text-slate-300">{result.valid_until}</span>
                </div>
                <div className="flex gap-3">
                  <span className="text-slate-600 w-20 shrink-0">DNS SANs</span>
                  <span className="text-slate-300">{result.dns_names.join(', ')}</span>
                </div>
                {result.ip_addresses.length > 0 && (
                  <div className="flex gap-3">
                    <span className="text-slate-600 w-20 shrink-0">IP SANs</span>
                    <span className="text-slate-300">{result.ip_addresses.join(', ')}</span>
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-500">
                The PEM path has been copied to the SSL field. Browsers will show a security warning
                for self-signed certs — click Advanced → Proceed to bypass.
              </p>
            </div>
          ) : (
            /* ── Form state ── */
            <>
              {/* CN / Primary domain */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  Common Name (CN) <span className="text-red-500">*</span>
                </label>
                <input className="input w-full font-mono text-xs"
                  placeholder="app.ao.az"
                  value={domain} onChange={e => setDomain(e.target.value)} />
                <p className="text-xs text-slate-700 mt-1">The primary hostname. Always added as first DNS SAN.</p>
              </div>

              {/* DNS SANs */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  DNS Names <span className="text-slate-600 font-normal">(Subject Alternative Names, one per line)</span>
                </label>
                <textarea className="input w-full font-mono text-xs resize-none" rows={4}
                  placeholder={'*.app.ao.az\nwww.app.ao.az\nlocalhost'}
                  value={dnsRaw} onChange={e => setDnsRaw(e.target.value)} />
                <p className="text-xs text-slate-700 mt-1">Wildcards supported. Browsers check SANs, not CN — add all hostnames you'll access the service through.</p>
              </div>

              {/* IP SANs */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  IP Addresses <span className="text-slate-600 font-normal">(SAN IPs, one per line — optional)</span>
                </label>
                <textarea className="input w-full font-mono text-xs resize-none" rows={2}
                  placeholder={'192.168.1.100\n10.0.0.1'}
                  value={ipRaw} onChange={e => setIpRaw(e.target.value)} />
                <p className="text-xs text-slate-700 mt-1">Add the server IP to allow direct HTTPS access by IP without a domain.</p>
              </div>

              {/* Organization + Country */}
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Organization <span className="text-slate-600 font-normal">(optional)</span></label>
                  <input className="input w-full text-xs" placeholder="Acme Corp"
                    value={org} onChange={e => setOrg(e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Country <span className="text-slate-600 font-normal">(2-letter)</span></label>
                  <input className="input w-full text-xs uppercase" placeholder="AZ" maxLength={2}
                    value={country} onChange={e => setCountry(e.target.value.toUpperCase())} />
                </div>
              </div>

              {/* Validity */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Validity period</label>
                <div className="flex gap-2 flex-wrap">
                  {VALIDITY_OPTIONS.map(opt => (
                    <button key={opt.value}
                      onClick={() => setDays(opt.value)}
                      className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                        days === opt.value
                          ? 'bg-blue-600/20 text-blue-300 border-blue-700'
                          : 'text-slate-400 border-slate-700 hover:border-slate-500'
                      }`}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {err && <p className="text-xs text-red-400">{err}</p>}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-800 shrink-0">
          {result ? (
            <>
              <button onClick={onClose} className="btn-ghost text-sm">Close</button>
              <button onClick={() => { onSuccess(result.pem_path); onClose() }} className="btn-primary">
                Use this certificate
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
              <button onClick={generate} disabled={busy || !domain.trim()} className="btn-primary disabled:opacity-40">
                {busy ? (
                  <><svg className="animate-spin w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> Generating…</>
                ) : 'Generate Certificate'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
