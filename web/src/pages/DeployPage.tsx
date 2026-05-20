import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, DeploymentRecord } from '../api/client'

export default function DeployPage() {
  const { id } = useParams<{ id: string }>()
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([])
  const [log, setLog] = useState<string[]>([])
  const [deploying, setDeploying] = useState(false)
  const [streamKey, setStreamKey] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!id) return
    api.listDeployments(id).then(d => setDeployments(d ?? [])).catch(() => {})
  }, [id])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  useEffect(() => {
    if (!streamKey || !id) return
    const es = new EventSource(`/api/v1/projects/${id}/deployments/${streamKey}/stream`)
    esRef.current = es
    es.onmessage = e => {
      try {
        const data = JSON.parse(e.data as string) as Record<string, string>
        if (data.log) setLog(prev => [...prev, data.log])
        if (data.status) {
          setLog(prev => [...prev, `\n✓ Deployment ${data.status}`])
          setDeploying(false)
          es.close()
          if (id) api.listDeployments(id).then(d => setDeployments(d ?? []))
        }
        if (data.error) {
          setLog(prev => [...prev, `\n✗ Error: ${data.error}`])
          setDeploying(false)
          es.close()
        }
      } catch {}
    }
    es.onerror = () => { setDeploying(false); es.close() }
    return () => es.close()
  }, [streamKey, id])

  const handleDeploy = async () => {
    if (!id) return
    setDeploying(true)
    setLog(['Starting deployment…'])
    try {
      const { deployment_id } = await api.triggerDeploy(id)
      setStreamKey(deployment_id)
    } catch (e: unknown) {
      setLog(['Error: ' + (e instanceof Error ? e.message : 'unknown')])
      setDeploying(false)
    }
  }

  const statusBadge = (s: string) => ({ pending: 'badge-pending', running: 'badge-pending', success: 'badge-running', failed: 'badge-error' } as Record<string, string>)[s] ?? 'badge-stopped'

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white">Deploy</h1>
        <button onClick={handleDeploy} disabled={deploying} className="btn-primary">
          {deploying ? '⟳ Deploying…' : '▶ Trigger Deploy'}
        </button>
      </div>

      {log.length > 0 && (
        <div className="card mb-6">
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Live Output</h2>
          <div ref={logRef} className="font-mono text-xs text-green-400 bg-gray-950 rounded-lg p-4 h-64 overflow-y-auto">
            {log.map((line, i) => <div key={i}>{line}</div>)}
            {deploying && <span className="animate-pulse">▌</span>}
          </div>
        </div>
      )}

      <section>
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Deployment History</h2>
        {deployments.length === 0 ? (
          <div className="card text-gray-500 text-sm text-center py-8">No deployments yet</div>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs">
                  <th className="text-left px-4 py-2.5">Status</th>
                  <th className="text-left px-4 py-2.5">Strategy</th>
                  <th className="text-left px-4 py-2.5">Compose Ver</th>
                  <th className="text-left px-4 py-2.5">Triggered By</th>
                  <th className="text-left px-4 py-2.5">Started</th>
                </tr>
              </thead>
              <tbody>
                {deployments.map(d => (
                  <tr key={d.id} className="border-b border-gray-800/50">
                    <td className="px-4 py-2.5"><span className={statusBadge(d.status)}>{d.status}</span></td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">{d.strategy}</td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">v{d.new_compose_version}</td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">{d.triggered_by}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{new Date(d.started_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
