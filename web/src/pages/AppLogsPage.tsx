import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useAuth } from '../hooks/useAuth'
import { RefreshCw, Play, Square, Download, FileText, WifiOff, Trash2, Search, X } from 'lucide-react'
import clsx from 'clsx'
import ConfirmModal from '../components/ConfirmModal'

type LogLine = { raw: string; level: string }

function classifyLine(line: string): string {
  const l = line.toLowerCase()
  if (l.includes(' error') || l.includes('err=') || l.includes('level=error')) return 'error'
  if (l.includes(' warn') || l.includes('level=warn')) return 'warn'
  if (l.includes(' debug') || l.includes('level=debug')) return 'debug'
  return 'info'
}

function lineColor(level: string): string {
  switch (level) {
    case 'error': return 'text-red-400'
    case 'warn':  return 'text-amber-400'
    case 'debug': return 'text-slate-500'
    default:      return 'text-slate-300'
  }
}

type Level = 'error' | 'warn' | 'info' | 'debug'
const ALL_LEVELS: Level[] = ['error', 'warn', 'info', 'debug']

export default function AppLogsPage() {
  const { user } = useAuth()
  const isSuperAdmin = user?.role === 'superadmin'
  const [lines, setLines] = useState<LogLine[]>([])
  const [source, setSource] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [streaming, setStreaming] = useState(false)
  const [streamStatus, setStreamStatus] = useState<'idle' | 'live' | 'error'>('idle')
  const [search, setSearch] = useState('')
  const [hiddenLevels, setHiddenLevels] = useState<Set<Level>>(new Set())
  const [autoScroll, setAutoScroll] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await api.getAppLogs(1000)
      setSource(res.source)
      setLines(res.lines.map(raw => ({ raw, level: classifyLine(raw) })))
    } catch {
      setLines([{ raw: 'Failed to load logs.', level: 'error' }])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (autoScroll && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
    }
  }, [lines, autoScroll])

  const startStream = () => {
    if (esRef.current) return
    setStreaming(true)
    setStreamStatus('live')
    const es = new EventSource(api.appLogsStreamUrl())
    esRef.current = es
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data) as { line: string }
        if (d.line) {
          setLines(prev => {
            const next = [...prev, { raw: d.line, level: classifyLine(d.line) }]
            return next.length > 5000 ? next.slice(-5000) : next
          })
        }
      } catch { /* ignore */ }
    }
    es.onerror = () => {
      setStreamStatus('error')
      es.close()
      esRef.current = null
      setStreaming(false)
    }
  }

  const stopStream = () => {
    esRef.current?.close()
    esRef.current = null
    setStreaming(false)
    setStreamStatus('idle')
  }

  useEffect(() => () => { esRef.current?.close() }, [])

  const clearLogs = async () => {
    setConfirmClear(false)
    setClearing(true)
    try {
      await api.clearAppLogs()
      setLines([])
    } catch { /* ignore */ } finally {
      setClearing(false)
    }
  }

  const downloadLogs = () => {
    const text = lines.map(l => l.raw).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'offdock.log'
    a.click()
    URL.revokeObjectURL(url)
  }

  const levelCounts = {
    error: lines.filter(l => l.level === 'error').length,
    warn:  lines.filter(l => l.level === 'warn').length,
    info:  lines.filter(l => l.level === 'info').length,
    debug: lines.filter(l => l.level === 'debug').length,
  }

  const toggleLevel = (level: Level) =>
    setHiddenLevels(prev => {
      const next = new Set(prev)
      next.has(level) ? next.delete(level) : next.add(level)
      return next
    })

  const searchLower = search.toLowerCase()
  const filtered = lines.filter(l => {
    if (hiddenLevels.has(l.level as Level)) return false
    if (searchLower && !l.raw.toLowerCase().includes(searchLower)) return false
    return true
  })

  const highlightSearch = (text: string) => {
    if (!search) return text
    const idx = text.toLowerCase().indexOf(searchLower)
    if (idx === -1) return text
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-amber-400/30 text-amber-200 rounded-sm">{text.slice(idx, idx + search.length)}</mark>
        {text.slice(idx + search.length)}
      </>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-800 shrink-0 bg-slate-900/30">
        <FileText className="w-4 h-4 text-blue-400 shrink-0" />
        <span className="text-sm font-semibold text-slate-200">OffDock App Logs</span>
        {source && (
          <span className="text-[10px] text-slate-600 uppercase tracking-wider">
            {source}
          </span>
        )}

        {/* Level filter pills */}
        <div className="flex items-center gap-1">
          {ALL_LEVELS.map(lv => {
            const count = levelCounts[lv]
            const active = !hiddenLevels.has(lv)
            const colors: Record<Level, string> = {
              error: active ? 'bg-red-500/20 border-red-500/40 text-red-400' : 'bg-slate-900 border-slate-800 text-slate-600',
              warn:  active ? 'bg-amber-500/20 border-amber-500/40 text-amber-400' : 'bg-slate-900 border-slate-800 text-slate-600',
              info:  active ? 'bg-slate-700/50 border-slate-600 text-slate-300' : 'bg-slate-900 border-slate-800 text-slate-600',
              debug: active ? 'bg-slate-800 border-slate-700 text-slate-500' : 'bg-slate-900 border-slate-800 text-slate-600',
            }
            return (
              <button
                key={lv}
                onClick={() => toggleLevel(lv)}
                className={clsx('px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors', colors[lv])}
                title={`${active ? 'Hide' : 'Show'} ${lv} lines`}
              >
                {lv} {count > 0 && <span className="ml-0.5 opacity-70">{count}</span>}
              </button>
            )
          })}
        </div>

        {/* Search */}
        <div className="relative flex-1 min-w-[140px] max-w-xs">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-600 pointer-events-none" />
          <input
            type="text"
            placeholder="Search logs…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-7 w-full pl-7 pr-6 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-600 hover:text-slate-300">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

          {/* Auto-scroll */}
          <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={e => setAutoScroll(e.target.checked)}
              className="rounded border-slate-700 bg-slate-800"
            />
            Follow
          </label>

          {/* Stream status */}
          {streaming && (
            <span className={clsx(
              'flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider',
              streamStatus === 'live' ? 'text-emerald-400' : 'text-red-400',
            )}>
              <span className={clsx('w-1.5 h-1.5 rounded-full', streamStatus === 'live' ? 'bg-emerald-400 animate-pulse' : 'bg-red-400')} />
              {streamStatus === 'live' ? 'live' : 'disconnected'}
            </span>
          )}

          {/* Live stream toggle */}
          {!streaming ? (
            <button
              onClick={startStream}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 text-xs font-medium transition-colors"
            >
              <Play className="w-3 h-3" /> Live
            </button>
          ) : (
            <button
              onClick={stopStream}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-400 hover:text-red-400 hover:border-red-500/30 text-xs font-medium transition-colors"
            >
              <Square className="w-3 h-3" /> Stop
            </button>
          )}

          {/* Refresh */}
          <button
            onClick={load}
            title="Reload log snapshot"
            className="p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-slate-300 transition-colors"
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>

          {/* Download */}
          <button
            onClick={downloadLogs}
            title="Download log file"
            className="p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-slate-300 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          {/* Clear (superadmin only) */}
          {isSuperAdmin && (
            <button
              onClick={() => setConfirmClear(true)}
              disabled={clearing}
              title="Clear log file"
              className="p-1.5 rounded hover:bg-slate-800 text-slate-600 hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
      </div>

      {/* Count bar */}
      <div className="px-4 py-1.5 border-b border-slate-800/50 shrink-0 text-[10px] text-slate-600 flex items-center gap-3">
        <span>
          {filtered.length}{filtered.length !== lines.length ? ` / ${lines.length} total` : ' lines'}
        </span>
        {hiddenLevels.size > 0 && (
          <span className="text-slate-500">hiding: {[...hiddenLevels].join(', ')}</span>
        )}
        {search && (
          <span className="text-amber-400/70">matching "{search}"</span>
        )}
        {(hiddenLevels.size > 0 || search) && (
          <button
            onClick={() => { setHiddenLevels(new Set()); setSearch('') }}
            className="text-slate-600 hover:text-slate-400 underline"
          >
            clear filters
          </button>
        )}
      </div>

      {/* Log content */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0 bg-slate-950/60 font-mono">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-slate-600 text-sm">
            <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-slate-600 gap-2">
            <WifiOff className="w-6 h-6" />
            <p className="text-sm">{lines.length === 0 ? 'No log lines available' : 'No lines match the filter'}</p>
          </div>
        ) : (
          <div className="py-1">
            {filtered.map((l, i) => (
              <div
                key={i}
                className={clsx(
                  'px-4 py-0.5 text-[11px] leading-5 hover:bg-slate-800/20 whitespace-pre-wrap break-all',
                  lineColor(l.level),
                  l.level === 'error' && 'border-l-2 border-red-500/60 pl-3 bg-red-950/20',
                  l.level === 'warn'  && 'border-l-2 border-amber-500/40 pl-3',
                )}
              >
                {highlightSearch(l.raw)}
              </div>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {confirmClear && (
        <ConfirmModal
          danger
          title="Clear log file?"
          message="The OffDock log file will be emptied. This cannot be undone."
          confirmLabel="Clear logs"
          onConfirm={clearLogs}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  )
}
