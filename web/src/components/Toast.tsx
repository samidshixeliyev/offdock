// Lightweight toast notification system. Wrap the app in <ToastProvider> and
// call useToast().push(...) anywhere.
import { createContext, useCallback, useContext, useState, ReactNode } from 'react'
import clsx from 'clsx'
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react'

type ToastTone = 'success' | 'error' | 'warning' | 'info'
interface Toast { id: number; tone: ToastTone; message: string }

interface ToastCtx {
  push: (message: string, tone?: ToastTone) => void
  success: (m: string) => void
  error: (m: string) => void
  info: (m: string) => void
}

const Ctx = createContext<ToastCtx | null>(null)

let counter = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const remove = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), [])

  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = ++counter
    setToasts(t => [...t, { id, tone, message }])
    setTimeout(() => remove(id), 4000)
  }, [remove])

  const value: ToastCtx = {
    push,
    success: m => push(m, 'success'),
    error: m => push(m, 'error'),
    info: m => push(m, 'info'),
  }

  const icons = { success: CheckCircle2, error: XCircle, warning: AlertTriangle, info: Info }
  const tones = {
    success: 'border-emerald-500/30 text-emerald-400',
    error:   'border-red-500/30 text-red-400',
    warning: 'border-amber-500/30 text-amber-400',
    info:    'border-blue-500/30 text-blue-400',
  }

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
        {toasts.map(t => {
          const Icon = icons[t.tone]
          return (
            <div key={t.id}
              className={clsx('flex items-start gap-3 bg-slate-900 border rounded-xl px-4 py-3 shadow-2xl animate-scaleIn', tones[t.tone])}>
              <Icon className="w-5 h-5 shrink-0 mt-0.5" />
              <p className="text-sm text-slate-200 flex-1 leading-snug">{t.message}</p>
              <button onClick={() => remove(t.id)} className="text-slate-500 hover:text-slate-300 shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>
          )
        })}
      </div>
    </Ctx.Provider>
  )
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
