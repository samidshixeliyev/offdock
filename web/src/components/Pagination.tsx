// Numbered pagination control with a page-size selector. Offline-safe.
import clsx from 'clsx'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { Select } from './Select'

interface PaginationProps {
  total: number
  page: number              // 0-based page index
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (size: number) => void
  pageSizeOptions?: number[]
  className?: string
  itemLabel?: string        // e.g. "trace", "session"
}

// Build a compact page-number window with ellipses: 1 … 4 5 [6] 7 8 … 20
function pageWindow(current: number, totalPages: number): (number | '…')[] {
  const out: (number | '…')[] = []
  const push = (n: number | '…') => out.push(n)
  const window = 1 // neighbors on each side
  const first = 0
  const last = totalPages - 1
  const from = Math.max(first, current - window)
  const to = Math.min(last, current + window)

  if (from > first) { push(first); if (from > first + 1) push('…') }
  for (let i = from; i <= to; i++) push(i)
  if (to < last) { if (to < last - 1) push('…'); push(last) }
  return out
}

export function Pagination({
  total, page, pageSize, onPageChange, onPageSizeChange,
  pageSizeOptions = [25, 50, 100], className, itemLabel = 'item',
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const clamped = Math.min(page, totalPages - 1)
  const start = total === 0 ? 0 : clamped * pageSize + 1
  const end = Math.min(total, (clamped + 1) * pageSize)
  const win = pageWindow(clamped, totalPages)

  const NavBtn = ({ to, disabled, children, title }: { to: number; disabled: boolean; children: React.ReactNode; title: string }) => (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => onPageChange(to)}
      className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-100 hover:border-slate-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  )

  return (
    <div className={clsx('flex flex-wrap items-center justify-between gap-3 px-4 py-3', className)}>
      <div className="text-xs text-slate-500 tabular-nums">
        {total === 0
          ? `No ${itemLabel}s`
          : <>Showing <span className="text-slate-300">{start}–{end}</span> of <span className="text-slate-300">{total}</span> {itemLabel}{total !== 1 ? 's' : ''}</>}
      </div>

      <div className="flex items-center gap-2">
        {onPageSizeChange && (
          <div className="hidden sm:block">
            <Select
              size="sm"
              align="right"
              value={String(pageSize)}
              onChange={v => onPageSizeChange(Number(v))}
              options={pageSizeOptions.map(n => ({ value: String(n), label: `${n} / page` }))}
            />
          </div>
        )}
        <div className="flex items-center gap-1">
          <NavBtn to={0} disabled={clamped === 0} title="First page"><ChevronsLeft className="w-4 h-4" /></NavBtn>
          <NavBtn to={clamped - 1} disabled={clamped === 0} title="Previous page"><ChevronLeft className="w-4 h-4" /></NavBtn>
          {win.map((p, i) =>
            p === '…'
              ? <span key={`e${i}`} className="w-8 h-8 inline-flex items-center justify-center text-slate-600 text-xs">…</span>
              : (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPageChange(p)}
                  className={clsx(
                    'inline-flex items-center justify-center min-w-8 h-8 px-2 rounded-lg border text-xs font-medium tabular-nums transition-colors',
                    p === clamped
                      ? 'border-blue-500/50 bg-blue-500/15 text-blue-300'
                      : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-100 hover:border-slate-600',
                  )}
                >
                  {p + 1}
                </button>
              ),
          )}
          <NavBtn to={clamped + 1} disabled={clamped >= totalPages - 1} title="Next page"><ChevronRight className="w-4 h-4" /></NavBtn>
          <NavBtn to={totalPages - 1} disabled={clamped >= totalPages - 1} title="Last page"><ChevronsRight className="w-4 h-4" /></NavBtn>
        </div>
      </div>
    </div>
  )
}
