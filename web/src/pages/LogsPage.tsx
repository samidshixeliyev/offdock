import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { api, ContainerInfo } from '../api/client'

export default function LogsPage() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [selected, setSelected] = useState(searchParams.get('container') ?? '')
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const esRef = useRef<EventSource | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!id) return
    api.listContainers(id).then(c => {
      const list = c ?? []
      setContainers(list)
      if (!selected && list.length > 0) setSelected(list[0].Names)
    }).catch(() => {})
  }, [id])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])

  useEffect(() => {
    if (!selected || !id) return
    esRef.current?.close()
    setLines([])
    const es = new EventSource(`/api/v1/projects/${id}/containers/${encodeURIComponent(selected)}/logs?tail=200`)
    esRef.current = es
    es.onmessage = e => {
      try {
        const { line } = JSON.parse(e.data as string) as { line: string }
        setLines(prev => [...prev.slice(-2000), line])
      } catch {}
    }
    es.onerror = () => es.close()
    return () => es.close()
  }, [selected, id])

  const filtered = filter ? lines.filter(l => l.toLowerCase().includes(filter.toLowerCase())) : lines

  return (
    <div className="p-6 flex flex-col h-[calc(100vh-2rem)]">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-xl font-semibold text-white">Container Logs</h1>
        <select className="input w-48" value={selected} onChange={e => setSelected(e.target.value)}>
          {containers.map(c => <option key={c.ID} value={c.Names}>{c.Names}</option>)}
        </select>
        <input className="input w-48" placeholder="Filter logs…" value={filter} onChange={e => setFilter(e.target.value)} />
        <button onClick={() => setLines([])} className="btn-ghost">Clear</button>
      </div>

      <div ref={logRef} className="flex-1 font-mono text-xs bg-gray-950 border border-gray-800 rounded-xl p-4 overflow-y-auto">
        {filtered.length === 0 && <span className="text-gray-600">Waiting for logs…</span>}
        {filtered.map((line, i) => (
          <div key={i} className={line.includes('ERROR') || line.includes('error') ? 'text-red-400' : line.includes('WARN') ? 'text-yellow-400' : 'text-gray-300'}>
            {line}
          </div>
        ))}
      </div>
    </div>
  )
}
