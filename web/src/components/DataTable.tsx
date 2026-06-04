// Generic, reusable data table with client-side search, sort, and pagination.
import { ReactNode, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Search, ChevronLeft, ChevronRight, ChevronsUpDown, ArrowUp, ArrowDown } from 'lucide-react'

export interface Column<T> {
  key: string
  header: ReactNode
  // cell renderer
  render: (row: T) => ReactNode
  // optional sort accessor; if provided, the column header becomes sortable
  sortValue?: (row: T) => string | number
  className?: string
  headerClassName?: string
}

interface DataTableProps<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  // optional free-text search — provided a row, returns the haystack string
  searchAccessor?: (row: T) => string
  searchPlaceholder?: string
  pageSize?: number
  empty?: ReactNode
  onRowClick?: (row: T) => void
  toolbar?: ReactNode
  dense?: boolean
}

export function DataTable<T>({
  rows, columns, rowKey, searchAccessor, searchPlaceholder = 'Search…',
  pageSize = 10, empty, onRowClick, toolbar, dense,
}: DataTableProps<T>) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const filtered = useMemo(() => {
    if (!query.trim() || !searchAccessor) return rows
    const q = query.toLowerCase()
    return rows.filter(r => searchAccessor(r).toLowerCase().includes(q))
  }, [rows, query, searchAccessor])

  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const col = columns.find(c => c.key === sortKey)
    if (!col?.sortValue) return filtered
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const av = col.sortValue!(a), bv = col.sortValue!(b)
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
  }, [filtered, sortKey, sortDir, columns])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const pageRows = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize)

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key); setSortDir('asc')
    }
  }

  return (
    <div>
      {(searchAccessor || toolbar) && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800">
          {searchAccessor ? (
            <div className="relative max-w-xs flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
              <input
                value={query}
                onChange={e => { setQuery(e.target.value); setPage(0) }}
                placeholder={searchPlaceholder}
                className="w-full pl-9 pr-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
              />
            </div>
          ) : <div />}
          {toolbar}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              {columns.map(col => (
                <th key={col.key}
                  className={clsx('text-left px-4 text-xs font-medium text-slate-500 uppercase tracking-wider',
                    dense ? 'py-2' : 'py-3', col.headerClassName)}>
                  {col.sortValue ? (
                    <button onClick={() => toggleSort(col.key)}
                      className="inline-flex items-center gap-1 hover:text-slate-300 transition-colors">
                      {col.header}
                      {sortKey === col.key
                        ? (sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)
                        : <ChevronsUpDown className="w-3 h-3 opacity-40" />}
                    </button>
                  ) : col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map(row => (
              <tr key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={clsx('border-b border-slate-800/60 last:border-0 transition-colors',
                  onRowClick && 'cursor-pointer hover:bg-slate-800/40')}>
                {columns.map(col => (
                  <td key={col.key} className={clsx('px-4 text-sm text-slate-300', dense ? 'py-2' : 'py-3', col.className)}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pageRows.length === 0 && (
        <div className="py-10">{empty ?? <p className="text-center text-sm text-slate-500">No results.</p>}</div>
      )}

      {sorted.length > pageSize && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-slate-800">
          <p className="text-xs text-slate-500 tabular-nums">
            {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, sorted.length)} of {sorted.length}
          </p>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs text-slate-400 tabular-nums px-2">{safePage + 1} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
