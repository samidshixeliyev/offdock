import { useEffect, useRef, useState } from 'react'
import XTerminal, { XTerminalHandle } from '../components/XTerminal'
import { api, ContainerInfo } from '../api/client'
import clsx from 'clsx'
import {
  Server, Container as ContainerIcon, Copy, Check, ClipboardPaste,
  RotateCw, Minus, Plus, ChevronDown, Shield, Mail, KeyRound, AlertCircle, Loader2,
} from 'lucide-react'

const QUICK_PATHS = [
  { label: '~', path: '/root' }, { label: '/', path: '/' },
  { label: '/var/offdock', path: '/var/offdock' }, { label: '/etc/offdock', path: '/etc/offdock' },
  { label: '/var/log', path: '/var/log' }, { label: '/etc/nginx', path: '/etc/nginx' },
]

function copyText(text: string, onDone?: () => void) {
  const doFallback = () => {
    const ta = document.createElement('textarea')
    ta.value = text
    Object.assign(ta.style, { position: 'fixed', top: '-9999px', opacity: '0' })
    document.body.appendChild(ta); ta.focus(); ta.select()
    try { document.execCommand('copy') } catch {}
    ta.remove(); onDone?.()
  }
  if (window.isSecureContext && navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(onDone).catch(doFallback)
  else doFallback()
}

type Target = { kind: 'host' } | { kind: 'container'; name: string }
type OTPState = 'idle' | 'requesting' | 'enter_code' | 'verifying' | 'ready' | 'error'

export default function TerminalPage() {
  const [target, setTarget] = useState<Target | null>(null)
  const [shell, setShell] = useState<'sh' | 'bash' | 'zsh'>('bash')
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [key, setKey] = useState(0)
  const [fontSize, setFontSize] = useState(13)
  const [copied, setCopied] = useState(false)
  const termRef = useRef<XTerminalHandle>(null)

  // OTP state
  const [otpState, setOtpState] = useState<OTPState>('idle')
  const [otpError, setOtpError] = useState('')
  const [otpChallengeId, setOtpChallengeId] = useState('')
  const [otpEmail, setOtpEmail] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [terminalToken, setTerminalToken] = useState('')
  const codeInputRef = useRef<HTMLInputElement>(null)

  const loadContainers = () =>
    api.listAllContainers().then(cs => setContainers(cs.filter(c => c.State?.toLowerCase() === 'running'))).catch(() => {})
  useEffect(() => { loadContainers() }, [])

  const reconnect = () => {
    if (isHost) {
      // OTP terminal token is single-use — must get a fresh one for every new WS session.
      setTerminalToken('')
      setOtpState('idle')
      setKey(k => k + 1)
      requestOTP()
    } else {
      setKey(k => k + 1)
    }
  }

  const selectTarget = (t: Target) => {
    setPickerOpen(false)
    if (t.kind === 'container') {
      setTarget(t); setKey(k => k + 1)
    } else {
      // Host terminal needs OTP
      setTarget(t)
      requestOTP()
    }
  }

  const requestOTP = () => {
    setOtpState('requesting')
    setOtpError('')
    setOtpCode('')
    api.otpRequest()
      .then(res => {
        setOtpChallengeId(res.challenge_id)
        setOtpEmail(res.email)
        setOtpState('enter_code')
        setTimeout(() => codeInputRef.current?.focus(), 100)
      })
      .catch(err => {
        setOtpError(err.message || 'Failed to send OTP')
        setOtpState('error')
      })
  }

  const verifyOTP = () => {
    if (otpCode.length !== 6) return
    setOtpState('verifying')
    setOtpError('')
    api.otpVerify(otpChallengeId, otpCode)
      .then(res => {
        setTerminalToken(res.terminal_token)
        setOtpState('ready')
        setKey(k => k + 1)
      })
      .catch(err => {
        setOtpError(err.message || 'Invalid OTP code')
        setOtpState('enter_code')
        setOtpCode('')
        setTimeout(() => codeInputRef.current?.focus(), 100)
      })
  }

  const handleCopy = () => {
    const sel = termRef.current?.getSelection() ?? ''
    if (!sel) return
    copyText(sel, () => { setCopied(true); setTimeout(() => setCopied(false), 1500); termRef.current?.focus() })
  }
  const handlePaste = () => {
    if (!window.isSecureContext || !navigator.clipboard?.readText) return
    navigator.clipboard.readText().then(text => { if (text) termRef.current?.send(text); termRef.current?.focus() }).catch(() => {})
  }
  const canPaste = window.isSecureContext && !!navigator.clipboard?.readText

  const isHost = target?.kind === 'host'
  const showTerminal = target !== null && (target.kind === 'container' || (target.kind === 'host' && otpState === 'ready'))

  const wsUrl = isHost
    ? `/api/v1/terminal/shell/ws?otp_token=${encodeURIComponent(terminalToken)}`
    : target?.kind === 'container' ? `/api/v1/terminal/container/ws?container=${encodeURIComponent(target.name)}&shell=${shell}` : ''
  const termKey = isHost ? `host-${key}` : `${(target as any)?.name ?? ''}-${shell}-${key}`
  const title = isHost ? 'root@host — host shell' : target?.kind === 'container' ? `docker exec -it ${target.name} ${shell}` : ''

  return (
    <div className="flex flex-col h-full bg-[#0d1117]">
      {/* Control bar */}
      <div className="flex items-center gap-2 px-4 py-2.5 shrink-0 flex-wrap gap-y-2 bg-slate-900/70 border-b border-slate-800">
        {/* Target picker */}
        <div className="relative">
          <button onClick={() => { setPickerOpen(o => !o); loadContainers() }}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 hover:border-slate-600 transition-colors">
            {isHost ? <Server className="w-4 h-4 text-blue-400" /> : <ContainerIcon className="w-4 h-4 text-emerald-400" />}
            <span className="font-medium max-w-[180px] truncate">
              {target === null ? 'Select target…' : isHost ? 'Host Shell' : (target as any).name}
            </span>
            <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
          </button>
          {pickerOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setPickerOpen(false)} />
              <div className="absolute left-0 top-full mt-1 z-20 w-72 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl py-1 max-h-80 overflow-y-auto">
                <button onClick={() => selectTarget({ kind: 'host' })}
                  className={clsx('w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors', isHost ? 'bg-slate-800 text-slate-100' : 'text-slate-300 hover:bg-slate-800/60')}>
                  <Server className="w-4 h-4 text-blue-400" />
                  <span>Host Shell</span>
                  <Shield className="w-3 h-3 text-amber-400 ml-auto" />
                </button>
                <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-600 uppercase tracking-widest">Running Containers</div>
                {containers.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-slate-600">No running containers</p>
                ) : containers.map(c => (
                  <button key={c.ID} onClick={() => selectTarget({ kind: 'container', name: c.Names })}
                    className={clsx('w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors',
                      !isHost && (target as any)?.name === c.Names ? 'bg-slate-800 text-slate-100' : 'text-slate-300 hover:bg-slate-800/60')}>
                    <ContainerIcon className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span className="font-mono truncate">{c.Names}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Shell picker (container only) */}
        {target?.kind === 'container' && (
          <div className="flex items-center gap-1 p-1 bg-slate-800 rounded-lg">
            {(['sh', 'bash', 'zsh'] as const).map(s => (
              <button key={s} onClick={() => { setShell(s); setKey(k => k + 1) }}
                className={clsx('text-xs px-2 py-1 rounded font-mono transition-colors',
                  shell === s ? 'bg-slate-700 text-blue-300' : 'text-slate-400 hover:text-slate-200')}>
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Quick paths (host only) */}
        {isHost && otpState === 'ready' && (
          <div className="flex items-center gap-1 flex-wrap">
            {QUICK_PATHS.map(p => (
              <button key={p.path} onClick={() => { termRef.current?.send(`cd ${p.path}\r`); termRef.current?.focus() }}
                className="text-xs px-2 py-0.5 rounded font-mono text-slate-500 border border-slate-700 hover:text-slate-300 hover:border-slate-600 transition-colors">
                {p.label}
              </button>
            ))}
          </div>
        )}

        {showTerminal && <span className="text-xs font-mono text-slate-600 truncate hidden md:block">{title}</span>}

        {/* Controls */}
        <div className="flex items-center gap-2 ml-auto">
          {showTerminal && <>
            <div className="flex items-center gap-1 text-slate-500">
              <button onClick={() => setFontSize(s => Math.max(9, s - 1))} className="p-1 rounded border border-slate-700 hover:text-slate-300"><Minus className="w-3 h-3" /></button>
              <span className="text-xs font-mono tabular-nums w-5 text-center">{fontSize}</span>
              <button onClick={() => setFontSize(s => Math.min(24, s + 1))} className="p-1 rounded border border-slate-700 hover:text-slate-300"><Plus className="w-3 h-3" /></button>
            </div>
            <button onClick={handleCopy} title="Copy selection"
              className={clsx('inline-flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors',
                copied ? 'text-emerald-400 border-emerald-500/40' : 'text-slate-400 border-slate-700 hover:text-slate-200')}>
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}{copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={handlePaste} disabled={!canPaste} title={canPaste ? 'Paste' : 'Paste requires HTTPS — use Ctrl+V'}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed">
              <ClipboardPaste className="w-3.5 h-3.5" /> Paste
            </button>
            <button onClick={reconnect} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-slate-200">
              <RotateCw className="w-3.5 h-3.5" /> Reconnect
            </button>
          </>}
          {isHost && otpState === 'ready' && (
            <button onClick={() => { setOtpState('idle'); setTerminalToken(''); setTarget(null) }}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-amber-700/40 text-amber-500 hover:text-amber-300">
              <Shield className="w-3.5 h-3.5" /> End Session
            </button>
          )}
        </div>
      </div>

      {/* OTP flow overlay */}
      {target?.kind === 'host' && otpState !== 'ready' && (
        <div className="flex-1 flex items-center justify-center bg-[#0d1117]">
          <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
                <Shield className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-100">Root Terminal — OTP Required</h2>
                <p className="text-xs text-slate-500 mt-0.5">One-time password sent to your email</p>
              </div>
            </div>

            {otpState === 'requesting' && (
              <div className="flex items-center gap-3 text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Sending OTP to your email…</span>
              </div>
            )}

            {(otpState === 'enter_code' || otpState === 'verifying') && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm text-slate-400 bg-slate-800/60 rounded-lg px-3 py-2.5">
                  <Mail className="w-4 h-4 text-blue-400 shrink-0" />
                  <span>Code sent to <span className="text-slate-200 font-mono">{otpEmail}</span></span>
                </div>
                {otpError && (
                  <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {otpError}
                  </div>
                )}
                <div>
                  <label className="block text-xs text-slate-500 mb-1.5">Enter 6-digit OTP</label>
                  <input
                    ref={codeInputRef}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={otpCode}
                    onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    onKeyDown={e => { if (e.key === 'Enter' && otpCode.length === 6) verifyOTP() }}
                    placeholder="000000"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-2xl font-mono text-center tracking-[0.5em] text-slate-100 focus:outline-none focus:border-blue-500 transition-colors"
                  />
                </div>
                <button
                  onClick={verifyOTP}
                  disabled={otpCode.length !== 6 || otpState === 'verifying'}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                  {otpState === 'verifying' ? <><Loader2 className="w-4 h-4 animate-spin" /> Verifying…</> : <><KeyRound className="w-4 h-4" /> Verify & Open Terminal</>}
                </button>
                <button onClick={requestOTP} className="w-full text-xs text-slate-500 hover:text-slate-300 transition-colors">
                  Resend OTP
                </button>
              </div>
            )}

            {otpState === 'error' && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2.5">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {otpError}
                </div>
                <button onClick={requestOTP}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium transition-colors">
                  <Mail className="w-4 h-4" /> Try Again
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* No target selected */}
      {target === null && (
        <div className="flex-1 flex items-center justify-center text-slate-600 text-sm">
          Select a target from the dropdown above
        </div>
      )}

      {/* Terminal */}
      {showTerminal && (
        <XTerminal key={termKey} ref={termRef} wsUrl={wsUrl} fontSize={fontSize} className="flex-1 min-h-0" style={{ padding: '8px' }} />
      )}
    </div>
  )
}
