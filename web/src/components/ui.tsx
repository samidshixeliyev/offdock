// Shared UI primitives. Import from here across pages for a consistent look.
import { ReactNode } from 'react'
import clsx from 'clsx'
import { type LucideIcon } from 'lucide-react'
import {
  type StatusMeta, toneClasses, toneDot, tonePulse,
  containerStatus, projectStatus, deploymentStatus,
} from '../lib/status'

// ─── Page shell ──────────────────────────────────────────────────────────────
export function Page({ children }: { children: ReactNode }) {
  return <div className="flex-1 overflow-y-auto px-6 py-6 animate-fadeIn">{children}</div>
}

export function PageHeader({
  title, subtitle, icon: Icon, actions,
}: { title: string; subtitle?: string; icon?: LucideIcon; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div className="flex items-center gap-3 min-w-0">
        {Icon && (
          <div className="w-10 h-10 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0">
            <Icon className="w-5 h-5 text-blue-400" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-slate-100 tracking-tight truncate">{title}</h1>
          {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}

// ─── Status badge (uses centralized status mapping) ───────────────────────────
export function StatusBadge({ meta, className }: { meta: StatusMeta; className?: string }) {
  return (
    <span className={clsx(
      'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border',
      toneClasses[meta.tone], className,
    )}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', toneDot[meta.tone], tonePulse[meta.tone] && 'animate-pulse')} />
      {meta.label}
    </span>
  )
}
export const ContainerBadge = ({ state, status }: { state: string; status?: string }) =>
  <StatusBadge meta={containerStatus(state, status)} />
export const ProjectBadge = ({ status }: { status: string }) =>
  <StatusBadge meta={projectStatus(status)} />
export const DeploymentBadge = ({ status }: { status: string }) =>
  <StatusBadge meta={deploymentStatus(status)} />

// ─── Stat card ────────────────────────────────────────────────────────────────
export function StatCard({
  label, value, sublabel, icon: Icon, tone = 'blue', progress,
}: {
  label: string; value: ReactNode; sublabel?: string; icon?: LucideIcon
  tone?: 'blue' | 'emerald' | 'amber' | 'red' | 'violet' | 'slate'
  progress?: number // 0..100, renders a bar
}) {
  const tones = {
    blue:    'from-blue-500/10 text-blue-400 border-blue-500/20',
    emerald: 'from-emerald-500/10 text-emerald-400 border-emerald-500/20',
    amber:   'from-amber-500/10 text-amber-400 border-amber-500/20',
    red:     'from-red-500/10 text-red-400 border-red-500/20',
    violet:  'from-violet-500/10 text-violet-400 border-violet-500/20',
    slate:   'from-slate-500/10 text-slate-400 border-slate-700',
  }
  const bar = {
    blue: 'bg-blue-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500',
    red: 'bg-red-500', violet: 'bg-violet-500', slate: 'bg-slate-500',
  }
  return (
    <div className="relative overflow-hidden bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-colors">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">{label}</p>
          <p className="text-2xl font-semibold text-slate-100 mt-1 tabular-nums">{value}</p>
          {sublabel && <p className="text-xs text-slate-500 mt-0.5 truncate">{sublabel}</p>}
        </div>
        {Icon && (
          <div className={clsx('w-9 h-9 rounded-lg bg-gradient-to-br to-transparent border flex items-center justify-center shrink-0', tones[tone])}>
            <Icon className="w-4.5 h-4.5" />
          </div>
        )}
      </div>
      {progress !== undefined && (
        <div className="mt-3 h-1.5 rounded-full bg-slate-800 overflow-hidden">
          <div className={clsx('h-full rounded-full transition-all duration-500', bar[tone])}
               style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </div>
      )}
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────
export function EmptyState({
  icon: Icon, title, description, action,
}: { icon: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <div className="w-14 h-14 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center mb-4">
        <Icon className="w-7 h-7 text-slate-600" />
      </div>
      <h3 className="text-sm font-medium text-slate-300">{title}</h3>
      {description && <p className="text-sm text-slate-500 mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

// ─── Skeleton loader ──────────────────────────────────────────────────────────
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton', className)} />
}

// ─── Section / panel ──────────────────────────────────────────────────────────
export function Panel({ title, icon: Icon, actions, children, className }: {
  title?: string; icon?: LucideIcon; actions?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <div className={clsx('bg-slate-900 border border-slate-800 rounded-xl', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800">
          <div className="flex items-center gap-2 min-w-0">
            {Icon && <Icon className="w-4 h-4 text-slate-500 shrink-0" />}
            {title && <h2 className="text-sm font-medium text-slate-200 truncate">{title}</h2>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  )
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
export function Tabs<T extends string>({
  tabs, active, onChange,
}: { tabs: { id: T; label: string; icon?: LucideIcon; count?: number }[]; active: T; onChange: (id: T) => void }) {
  return (
    <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg w-fit">
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)}
          className={clsx(
            'inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all',
            active === t.id ? 'bg-slate-800 text-slate-100 shadow-sm' : 'text-slate-400 hover:text-slate-200',
          )}>
          {t.icon && <t.icon className="w-4 h-4" />}
          {t.label}
          {t.count !== undefined && (
            <span className={clsx('px-1.5 py-0.5 rounded text-[10px] tabular-nums',
              active === t.id ? 'bg-slate-700 text-slate-300' : 'bg-slate-800 text-slate-500')}>
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

// ─── Inline alert ─────────────────────────────────────────────────────────────
export function Alert({ tone = 'info', children }: {
  tone?: 'info' | 'success' | 'warning' | 'error'; children: ReactNode
}) {
  const tones = {
    info:    'bg-blue-500/10 border-blue-500/20 text-blue-300',
    success: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300',
    warning: 'bg-amber-500/10 border-amber-500/20 text-amber-300',
    error:   'bg-red-500/10 border-red-500/20 text-red-300',
  }
  return <div className={clsx('px-3 py-2 rounded-lg border text-sm', tones[tone])}>{children}</div>
}

// ─── Icon button ──────────────────────────────────────────────────────────────
export function IconButton({
  icon: Icon, onClick, title, tone = 'default', disabled,
}: {
  icon: LucideIcon; onClick?: () => void; title: string; disabled?: boolean
  tone?: 'default' | 'danger' | 'success'
}) {
  const tones = {
    default: 'text-slate-400 hover:text-slate-100 hover:bg-slate-800',
    danger:  'text-slate-400 hover:text-red-400 hover:bg-red-500/10',
    success: 'text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10',
  }
  return (
    <button onClick={onClick} title={title} disabled={disabled}
      className={clsx('p-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed', tones[tone])}>
      <Icon className="w-4 h-4" />
    </button>
  )
}
