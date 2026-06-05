import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { RefreshCw, Play, Square, Download, FileText, WifiOff } from 'lucide-react'
import clsx from 'clsx'

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

export default function AppLogsPage() {
  const [lines, setLines] = useState<LogLine[]>([])
  const [source, setSource] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [streaming, setStreaming] = useState(false)
  const [streamStatus, setStreamStatus] = useState<'idle' | 'live' | 'error'>('idle')
  const [filter, setFilter] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)

  const bottomRef = useRef<HTMLDivElement>(null)
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
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
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

  const errorCount = lines.filter(l => l.level === 'error').length

  const [errorsOnly, setErrorsOnly] = useState(false)
  const filtered = lines.filter(l => {
    if (errorsOnly && l.level !== 'error') return false
    if (filter && !l.raw.toLowerCase().includes(filter.toLowerCase())) return false
    return true
  })

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 shrink-0 bg-slate-900/30">
        <FileText className="w-4 h-4 text-blue-400 shrink-0" />
        <span className="text-sm font-semibold text-slate-200">OffDock App Logs</span>
        {source && (
          <span className="text-[10px] text-slate-600 uppercase tracking-wider">
            source: {source}
          </span>
        )}

        <div className="flex items-center gap-1.5 ml-auto">
          {/* Error count badge + quick filter */}
          {errorCount > 0 && (
            <button
              onClick={() => setErrorsOnly(v => !v)}
              className={clsx(
                'flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold transition-colors',
                errorsOnly
                  ? 'bg-red-500/20 border border-red-500/40 text-red-400'
                  : 'bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20',
              )}
            >
              {errorCount} error{errorCount !== 1 ? 's' : ''}
            </button>
          )}

          {/* Filter */}
          <input
            type="text"
            placeholder="Filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="h-7 px-2.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500 w-40"
          />

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
        </div>
      </div>

      {/* Count bar */}
      <div className="px-4 py-1.5 border-b border-slate-800/50 shrink-0 text-[10px] text-slate-600 flex items-center gap-3">
        <span>{filtered.length} {filtered.length !== lines.length ? `/ ${lines.length} total` : 'lines'}</span>
        {errorsOnly && <span className="text-red-400/70">errors only</span>}
        {filter && <span className="text-amber-400/70">filtered by "{filter}"</span>}
      </div>

      {/* Log content */}
      <div className="flex-1 overflow-y-auto min-h-0 bg-slate-950/60 font-mono">
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
                {l.raw}
              </div>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
