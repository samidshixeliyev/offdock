import clsx from 'clsx'

interface Props {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-5 h-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
    </svg>
  )
}
function QuestionIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-5 h-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
    </svg>
  )
}

export default function ConfirmModal({ title, message, confirmLabel = 'Confirm', onConfirm, onCancel, danger }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm animate-fadeIn"
      onClick={onCancel}
    >
      <div
        className="relative bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl animate-scaleIn"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-4 mb-4">
          <div className={clsx(
            'shrink-0 w-10 h-10 rounded-xl flex items-center justify-center border',
            danger
              ? 'bg-red-500/10 text-red-400 border-red-500/30'
              : 'bg-blue-500/10 text-blue-400 border-blue-500/30',
          )}>
            {danger ? <WarnIcon /> : <QuestionIcon />}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-slate-100">{title}</h3>
            <p className="text-sm text-slate-400 mt-1 leading-relaxed">{message}</p>
          </div>
        </div>

        <div className="flex gap-2 justify-end pt-2 border-t border-slate-800/60 -mx-6 px-6 -mb-6 pb-6 rounded-b-2xl">
          <button onClick={onCancel} className="btn-secondary">Cancel</button>
          <button
            onClick={onConfirm}
            className={clsx(
              danger
                ? 'inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 text-white text-sm font-medium rounded-lg shadow-lg shadow-red-500/20 transition-all duration-200'
                : 'btn-primary',
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
