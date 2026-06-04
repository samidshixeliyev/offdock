// Centralized container/project/deployment status mapping.
//
// Fixes the long-standing bug where a *restarting* (crash-looping) container
// was rendered as healthy "running". Docker's `State` field can be:
//   running | restarting | paused | created | exited | dead | removing
// Each maps to a distinct visual tone here — restarting is NOT running.

export type StatusTone = 'running' | 'restarting' | 'paused' | 'stopped' | 'error' | 'pending' | 'neutral'

export interface StatusMeta {
  tone: StatusTone
  label: string
}

// Map a raw docker `State` (+ optional `Status` text) to a status tone.
export function containerStatus(state: string, statusText?: string): StatusMeta {
  const s = (state || '').toLowerCase().trim()
  switch (s) {
    case 'running': {
      // A "running" container whose Status mentions "unhealthy" is degraded.
      if (statusText && /unhealthy/i.test(statusText)) {
        return { tone: 'error', label: 'Unhealthy' }
      }
      if (statusText && /health: starting/i.test(statusText)) {
        return { tone: 'pending', label: 'Starting' }
      }
      return { tone: 'running', label: 'Running' }
    }
    case 'restarting':
      return { tone: 'restarting', label: 'Restarting' }
    case 'paused':
      return { tone: 'paused', label: 'Paused' }
    case 'created':
      return { tone: 'pending', label: 'Created' }
    case 'removing':
      return { tone: 'restarting', label: 'Removing' }
    case 'exited':
      return { tone: 'stopped', label: 'Exited' }
    case 'dead':
      return { tone: 'error', label: 'Dead' }
    default:
      return { tone: 'neutral', label: state || 'Unknown' }
  }
}

export function projectStatus(status: string): StatusMeta {
  switch ((status || '').toLowerCase()) {
    case 'running':  return { tone: 'running', label: 'Running' }
    case 'degraded': return { tone: 'restarting', label: 'Degraded' }
    case 'error':    return { tone: 'error', label: 'Error' }
    case 'stopped':  return { tone: 'stopped', label: 'Stopped' }
    default:         return { tone: 'neutral', label: status || 'Unknown' }
  }
}

export function deploymentStatus(status: string): StatusMeta {
  switch ((status || '').toLowerCase()) {
    case 'success':   return { tone: 'running', label: 'Success' }
    case 'running':   return { tone: 'pending', label: 'Running' }
    case 'pending':   return { tone: 'pending', label: 'Pending' }
    case 'failed':    return { tone: 'error', label: 'Failed' }
    case 'cancelled': return { tone: 'stopped', label: 'Cancelled' }
    default:          return { tone: 'neutral', label: status || 'Unknown' }
  }
}

// Tailwind class fragments per tone — pill background/text/border.
export const toneClasses: Record<StatusTone, string> = {
  running:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  restarting: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  paused:     'bg-sky-500/10 text-sky-400 border-sky-500/20',
  stopped:    'bg-slate-800 text-slate-400 border-slate-700',
  error:      'bg-red-500/10 text-red-400 border-red-500/20',
  pending:    'bg-blue-500/10 text-blue-400 border-blue-500/20',
  neutral:    'bg-slate-800 text-slate-400 border-slate-700',
}

// Dot color per tone (the small status indicator).
export const toneDot: Record<StatusTone, string> = {
  running:    'bg-emerald-400',
  restarting: 'bg-amber-400',
  paused:     'bg-sky-400',
  stopped:    'bg-slate-500',
  error:      'bg-red-400',
  pending:    'bg-blue-400',
  neutral:    'bg-slate-500',
}

// Which tones should pulse (active/transitional states).
export const tonePulse: Record<StatusTone, boolean> = {
  running: true, restarting: true, pending: true,
  paused: false, stopped: false, error: false, neutral: false,
}
