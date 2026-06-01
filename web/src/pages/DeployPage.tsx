import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, ComposeConfig, DeploymentRecord, DeploySettings, EnvVarSet } from '../api/client'

function duration(d: DeploymentRecord) {
  if (!d.finished_at) return '—'
  const ms = new Date(d.finished_at).getTime() - new Date(d.started_at).getTime()
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

const statusBadge = (s: string) =>
  ({ pending: 'badge-pending', running: 'badge-pending', success: 'badge-running', failed: 'badge-error', cancelled: 'badge-stopped' } as Record<string, string>)[s] ?? 'badge-stopped'

export default function DeployPage() {
  const { id } = useParams<{ id: string }>()

  const [deployments, setDeployments] = useState<DeploymentRecord[]>([])
  const [composeHistory, setComposeHistory] = useState<ComposeConfig[]>([])
  const [envHistory, setEnvHistory] = useState<EnvVarSet[]>([])
  const [settings, setSettings] = useState<DeploySettings | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<Omit<DeploySettings, 'id' | 'project_id'>>({
    health_timeout_secs: 120, deploy_timeout_secs: 300, health_stable_secs: 5,
  })
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)

  const [log, setLog] = useState<string[]>([])
  const [deploying, setDeploying] = useState(false)
  const [streamKey, setStreamKey] = useState('')

  const [rollbackCompose, setRollbackCompose] = useState(0)
  const [rollbackEnv, setRollbackEnv] = useState(0)
  const [expandLog, setExpandLog] = useState<string | null>(null)

  const logRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)
  const isAtBottomRef = useRef<boolean>(true)

  const handleLogScroll = () => {
    const el = logRef.current
    if (!el) return
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50
  }

  const reload = () => {
    if (!id) return
    api.listDeployments(id).then(d => setDeployments(d ?? [])).catch(() => {})
  }

  useEffect(() => {
    if (!id) return
    reload()
    api.composeHistory(id).then(h => {
      const sorted = (h ?? []).slice().sort((a, b) => b.version - a.version)
      setComposeHistory(sorted)
    }).catch(() => {})
    api.envHistory(id).then(h => {
      const sorted = (h ?? []).slice().sort((a, b) => b.version - a.version)
      setEnvHistory(sorted)
    }).catch(() => {})
    api.getDeploySettings(id).then(s => {
      setSettings(s)
      setSettingsDraft({ health_timeout_secs: s.health_timeout_secs, deploy_timeout_secs: s.deploy_timeout_secs, health_stable_secs: s.health_stable_secs })
    }).catch(() => {})
  }, [id])

  useEffect(() => {
    if (logRef.current && isAtBottomRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
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
          reload()
        }
        if (data.error) {
          setLog(prev => [...prev, `\n✗ Error: ${data.error}`])
          setDeploying(false)
          es.close()
          reload()
        }
      } catch {}
    }
    es.onerror = () => { setDeploying(false); es.close() }
    return () => es.close()
  }, [streamKey, id])

  const startDeploy = async (composeVer = 0, envVer = 0) => {
    if (!id) return
    setDeploying(true)
    isAtBottomRef.current = true
    const label = composeVer || envVer
      ? `Rolling back to compose v${composeVer || 'latest'} · env v${envVer || 'latest'}…`
      : 'Deploying latest…'
    setLog([label])
    try {
      const { deployment_id } = await api.triggerDeploy(id, composeVer || undefined, envVer || undefined)
      setStreamKey(deployment_id)
    } catch (e: unknown) {
      setLog(['Error: ' + (e instanceof Error ? e.message : 'unknown')])
      setDeploying(false)
    }
  }

  const saveSettings = async () => {
    if (!id) return
    setSettingsSaving(true)
    try {
      const s = await api.saveDeploySettings(id, settingsDraft)
      setSettings(s)
      setSettingsSaved(true)
      setTimeout(() => setSettingsSaved(false), 2000)
    } catch {}
    setSettingsSaving(false)
  }

  const latestCompose = composeHistory[0]
  const latestEnv = envHistory[0]

  return (
    <div className="p-6 max-w-5xl space-y-6 animate-fadeIn">

      {/* ── Deploy now ─────────────────────────────────────────────────────── */}
      <div className="card-static">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Deploy Latest</h2>
            <p className="text-xs text-slate-500 mt-1">
              Uses&nbsp;
              {latestCompose ? <span className="text-slate-300 font-medium">compose v{latestCompose.version}</span> : <span className="text-amber-400">no compose saved</span>}
              &nbsp;·&nbsp;
              {latestEnv ? <span className="text-slate-300 font-medium">env v{latestEnv.version} ({latestEnv.vars.length} vars)</span> : <span className="text-slate-500">no env vars</span>}
            </p>
          </div>
          <button
            onClick={() => startDeploy()}
            disabled={deploying || !latestCompose}
            className="btn-primary flex items-center gap-2"
          >
            {deploying ? (
              <>
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Deploying…
              </>
            ) : (
              <>
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                </svg>
                Deploy Latest
              </>
            )}
          </button>
        </div>

        {/* Terminal-style log panel */}
        <div className="rounded-xl border border-slate-800 overflow-hidden bg-slate-950">
          <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/60" />
              </div>
              <span className="text-xs font-mono text-slate-400 ml-2">deploy.log</span>
            </div>
            <div className="flex items-center gap-1.5">
              {deploying ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                  <span className="text-xs text-blue-400 font-medium">Streaming</span>
                </>
              ) : log.length > 0 ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  <span className="text-xs text-emerald-400 font-medium">Idle</span>
                </>
              ) : (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-600" />
                  <span className="text-xs text-slate-500 font-medium">Ready</span>
                </>
              )}
            </div>
          </div>
          {log.length > 0 ? (
            <div
              ref={logRef}
              onScroll={handleLogScroll}
              className="font-mono text-xs text-emerald-400 p-4 h-56 overflow-y-auto leading-relaxed"
            >
              {log.map((line, i) => <div key={i}>{line}</div>)}
              {deploying && <span className="animate-pulse text-blue-400">▌</span>}
            </div>
          ) : (
            <div className="font-mono text-xs text-slate-600 p-4 h-56 flex items-center justify-center">
              No logs yet — click "Deploy Latest" to start
            </div>
          )}
        </div>
      </div>

      {/* ── Rollback ───────────────────────────────────────────────────────── */}
      <div className="card">
        <h2 className="text-sm font-semibold text-white mb-1">Rollback</h2>
        <p className="text-xs text-slate-500 mb-4">
          Pick a compose version and/or env version to deploy. Leave at "latest" to use the newest.
        </p>

        <div className="grid grid-cols-2 gap-4 mb-4">
          {/* Compose version picker */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Compose version</label>
            <select
              value={rollbackCompose}
              onChange={e => setRollbackCompose(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            >
              <option value={0}>Latest (v{latestCompose?.version ?? '—'})</option>
              {composeHistory.map(c => (
                <option key={c.id} value={c.version}>
                  v{c.version} — saved {new Date(c.created_at).toLocaleDateString()} by {c.created_by}
                </option>
              ))}
            </select>
            {rollbackCompose > 0 && composeHistory.find(c => c.version === rollbackCompose) && (
              <details className="mt-2">
                <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-300">Preview compose v{rollbackCompose}</summary>
                <pre className="mt-1 text-xs text-slate-400 bg-slate-950 rounded p-3 overflow-x-auto max-h-40">
                  {composeHistory.find(c => c.version === rollbackCompose)?.raw_yaml}
                </pre>
              </details>
            )}
          </div>

          {/* Env version picker */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Env version</label>
            <select
              value={rollbackEnv}
              onChange={e => setRollbackEnv(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            >
              <option value={0}>Latest (v{latestEnv?.version ?? '—'}, {latestEnv?.vars.length ?? 0} vars)</option>
              {envHistory.map(s => (
                <option key={s.id} value={s.version}>
                  v{s.version} — {s.vars.length} vars, saved {new Date(s.created_at).toLocaleDateString()} by {s.created_by}
                </option>
              ))}
            </select>
            {rollbackEnv > 0 && envHistory.find(s => s.version === rollbackEnv) && (
              <div className="mt-2 text-xs text-slate-500 bg-slate-950 rounded p-3 max-h-32 overflow-y-auto">
                {envHistory.find(s => s.version === rollbackEnv)?.vars.map(v => (
                  <div key={v.key} className="font-mono">
                    <span className="text-slate-300">{v.key}</span>
                    <span className="text-slate-600">=</span>
                    <span className="text-slate-500">{v.is_secret ? '••••••••' : v.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <button
          onClick={() => startDeploy(rollbackCompose, rollbackEnv)}
          disabled={deploying || !latestCompose}
          className="btn-secondary text-sm"
        >
          ↩ Roll back to compose {rollbackCompose > 0 ? `v${rollbackCompose}` : 'latest'} · env {rollbackEnv > 0 ? `v${rollbackEnv}` : 'latest'}
        </button>
      </div>

      {/* ── Deploy settings ────────────────────────────────────────────────── */}
      <div className="card">
        <h2 className="text-sm font-semibold text-white mb-4">Deploy Settings</h2>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Health timeout (seconds)</label>
            <input
              type="number"
              min={10}
              max={600}
              value={settingsDraft.health_timeout_secs}
              onChange={e => setSettingsDraft(d => ({ ...d, health_timeout_secs: Number(e.target.value) }))}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            />
            <p className="text-xs text-slate-600 mt-1">How long to wait for containers to become healthy</p>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Deploy timeout (seconds)</label>
            <input
              type="number"
              min={30}
              max={1800}
              value={settingsDraft.deploy_timeout_secs}
              onChange={e => setSettingsDraft(d => ({ ...d, deploy_timeout_secs: Number(e.target.value) }))}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            />
            <p className="text-xs text-slate-600 mt-1">Hard limit for the entire deploy operation</p>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Stable period (seconds)</label>
            <input
              type="number"
              min={0}
              max={60}
              value={settingsDraft.health_stable_secs}
              onChange={e => setSettingsDraft(d => ({ ...d, health_stable_secs: Number(e.target.value) }))}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            />
            <p className="text-xs text-slate-600 mt-1">Time a "running" container must stay up before considered healthy</p>
          </div>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button
            onClick={saveSettings}
            disabled={settingsSaving}
            className="btn-secondary text-sm"
          >
            {settingsSaving ? 'Saving…' : 'Save settings'}
          </button>
          {settingsSaved && <span className="text-xs text-green-400">✓ Saved</span>}
          {settings && (
            <span className="text-xs text-slate-600">
              Current: health {settings.health_timeout_secs}s · deploy {settings.deploy_timeout_secs}s · stable {settings.health_stable_secs}s
            </span>
          )}
        </div>
      </div>

      {/* ── Deployment history ─────────────────────────────────────────────── */}
      <section>
        <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">Deployment History</h2>
        {deployments.length === 0 ? (
          <div className="card text-slate-500 text-sm text-center py-8">No deployments yet</div>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-slate-500 text-xs">
                  <th className="text-left px-4 py-2.5">Status</th>
                  <th className="text-left px-4 py-2.5">Compose</th>
                  <th className="text-left px-4 py-2.5">Env</th>
                  <th className="text-left px-4 py-2.5">Triggered By</th>
                  <th className="text-left px-4 py-2.5">Started</th>
                  <th className="text-left px-4 py-2.5">Duration</th>
                  <th className="text-left px-4 py-2.5">Log</th>
                </tr>
              </thead>
              <tbody>
                {deployments.map(d => (
                  <>
                    <tr key={d.id} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                      <td className="px-4 py-2.5"><span className={statusBadge(d.status)}>{d.status}</span></td>
                      <td className="px-4 py-2.5 text-slate-300 text-xs font-mono">v{d.new_compose_version}</td>
                      <td className="px-4 py-2.5 text-slate-300 text-xs font-mono">{d.env_version > 0 ? `v${d.env_version}` : <span className="text-slate-600">—</span>}</td>
                      <td className="px-4 py-2.5 text-slate-400 text-xs">{d.triggered_by}</td>
                      <td className="px-4 py-2.5 text-slate-500 text-xs">{new Date(d.started_at).toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-slate-500 text-xs">{duration(d)}</td>
                      <td className="px-4 py-2.5">
                        {d.log_text ? (
                          <button
                            onClick={() => setExpandLog(expandLog === d.id ? null : d.id)}
                            className="text-xs text-blue-400 hover:text-blue-300"
                          >
                            {expandLog === d.id ? 'hide' : 'show'}
                          </button>
                        ) : <span className="text-slate-700 text-xs">—</span>}
                      </td>
                    </tr>
                    {expandLog === d.id && (
                      <tr key={`${d.id}-log`} className="border-b border-slate-800/50">
                        <td colSpan={7} className="px-4 pb-3">
                          <pre className="font-mono text-xs text-green-400 bg-slate-950 rounded p-3 max-h-64 overflow-y-auto whitespace-pre-wrap">
                            {d.log_text}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
