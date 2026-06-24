// Custom-designed dropdown — replaces native <select> for a consistent,
// keyboard-accessible, dark-themed control. Offline-safe (no external deps).
// The popover renders in a portal with fixed positioning so it is never clipped
// by a parent's `overflow-hidden` and never lost behind another stacking context.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Check, ChevronDown, Search, type LucideIcon } from 'lucide-react'

export interface SelectOption<T extends string> {
  value: T
  label: string
  hint?: string          // small muted text on the right
  icon?: LucideIcon
}

interface SelectProps<T extends string> {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  label?: string
  icon?: LucideIcon       // leading icon on the trigger
  searchable?: boolean    // show a filter box when many options
  disabled?: boolean
  className?: string
  size?: 'sm' | 'md'
  align?: 'left' | 'right'
}

export function Select<T extends string>({
  value, options, onChange, placeholder = 'Select…', label, icon: Icon,
  searchable, disabled, className, size = 'md', align = 'left',
}: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number; width: number; flipUp: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selected = options.find(o => o.value === value)
  const useSearch = searchable ?? options.length > 8
  const filtered = query.trim()
    ? options.filter(o => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options

  // Compute the popover's fixed position from the trigger's rect. Re-run on open
  // and on any scroll/resize so it stays glued to the trigger.
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const el = rootRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const spaceBelow = window.innerHeight - r.bottom
      const flipUp = spaceBelow < 280 && r.top > spaceBelow
      const base = { width: r.width, flipUp, top: flipUp ? r.top : r.bottom }
      setPos(align === 'right'
        ? { ...base, right: window.innerWidth - r.right }
        : { ...base, left: r.left })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open, align])

  // Close on outside click — accounts for the portaled popover too.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // Reset query + focus search when opening.
  useEffect(() => {
    if (open) {
      setQuery('')
      const idx = Math.max(0, options.findIndex(o => o.value === value))
      setActiveIdx(idx)
      if (useSearch) requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (v: T) => { onChange(v); setOpen(false) }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(filtered.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[activeIdx]
      if (opt) commit(opt.value)
    }
  }

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      {label && <label className="block text-[11px] font-medium text-slate-500 uppercase tracking-wider mb-1">{label}</label>}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onKeyDown}
        className={clsx(
          'w-full inline-flex items-center gap-2 rounded-lg border bg-slate-900 text-left transition-colors',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          open ? 'border-blue-500/50 ring-1 ring-blue-500/20' : 'border-slate-700 hover:border-slate-600',
          size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm',
        )}
      >
        {Icon && <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
        {selected?.icon && <selected.icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
        <span className={clsx('truncate flex-1', selected ? 'text-slate-200' : 'text-slate-500')}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className={clsx('w-4 h-4 text-slate-500 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{
            position: 'fixed',
            top: pos.flipUp ? undefined : pos.top + 4,
            bottom: pos.flipUp ? window.innerHeight - pos.top + 4 : undefined,
            left: pos.left,
            right: pos.right,
            minWidth: pos.width,
          }}
          className={clsx(
            'z-[200] w-max max-w-[min(20rem,80vw)] rounded-lg border border-slate-700 bg-slate-900 shadow-2xl shadow-black/40 animate-scaleIn',
            pos.flipUp ? 'origin-bottom' : 'origin-top',
          )}
        >
          {useSearch && (
            <div className="p-2 border-b border-slate-800">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={e => { setQuery(e.target.value); setActiveIdx(0) }}
                  onKeyDown={onKeyDown}
                  placeholder="Filter…"
                  className="w-full bg-slate-800 border border-slate-700 rounded-md pl-7 pr-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50"
                />
              </div>
            </div>
          )}
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && <div className="px-3 py-2 text-xs text-slate-500">No matches</div>}
            {filtered.map((opt, i) => {
              const isSel = opt.value === value
              const isActive = i === activeIdx
              return (
                <button
                  key={opt.value}
                  type="button"
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => commit(opt.value)}
                  className={clsx(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors',
                    isActive ? 'bg-slate-800 text-slate-100' : 'text-slate-300',
                  )}
                >
                  {opt.icon && <opt.icon className="w-3.5 h-3.5 shrink-0 text-slate-400" />}
                  <span className="truncate flex-1">{opt.label}</span>
                  {opt.hint && <span className="text-[10px] text-slate-500 shrink-0">{opt.hint}</span>}
                  {isSel && <Check className="w-3.5 h-3.5 text-blue-400 shrink-0" />}
                </button>
              )
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

// Small helper so callers can pass children-less option arrays inline.
export function selectOptions<T extends string>(items: (readonly [T, string] | { value: T; label: string; hint?: string })[]): SelectOption<T>[] {
  return items.map(it =>
    Array.isArray(it) ? { value: it[0], label: it[1] } : (it as { value: T; label: string; hint?: string }),
  )
}
