import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, ComposeConfig, ComposeServiceInfo, DeploymentRecord, DeploySettings, EnvVarSet, DeployTag, ImageUsage } from '../api/client'
import clsx from 'clsx'
import {
  Search, FileText, Container as ContainerIcon, HeartPulse, Server, CheckCircle2,
  Loader2, AlertCircle, RotateCcw, Rocket, Eye, EyeOff, Tag as TagIcon, Trash2,
} from 'lucide-react'
import { useToast } from '../components/Toast'
import { usePermissions, PERMS } from '../hooks/usePermissions'
import { useAuth } from '../hooks/useAuth'
import { Modal } from '../components/Modal'
import { ReadOnlyBanner } from '../components/ReadOnlyBanner'

function duration(d: DeploymentRecord) {
  if (!d.finished_at) return '—'
  const ms = new Date(d.finished_at).getTime() - new Date(d.started_at).getTime()
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60000) return 'just now'
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`
  return `${Math.floor(ms / 86400000)}d ago`
}

const statusBadge = (s: string) =>
  ({ pending: 'badge-pending', running: 'badge-pending', success: 'badge-running', failed: 'badge-error', cancelled: 'badge-stopped' } as Record<string, string>)[s] ?? 'badge-stopped'

// ─── Deploy pipeline ──────────────────────────────────────────────────────────

type StageStatus = 'pending' | 'running' | 'done' | 'error'

interface StageDef { id: string; label: string; icon: typeof Search; marker: string }

// Maps the [STAGE] markers emitted by the deploy engine to visual stages.
const PIPELINE_STAGES: StageDef[] = [
  { id: 'resolve', label: 'Resolve', icon: Search, marker: 'Resolving versions' },
  { id: 'write', label: 'Write Files', icon: FileText, marker: 'Writing compose + env' },
  { id: 'deploy', label: 'Deploy', icon: ContainerIcon, marker: 'Running docker compose' },
  { id: 'health', label: 'Health Check', icon: HeartPulse, marker: 'Health check' },
  { id: 'nginx', label: 'Nginx', icon: Server, marker: 'Nginx reload' },
  { id: 'done', label: 'Done', icon: CheckCircle2, marker: 'Complete' },
]

interface StageState { status: StageStatus; elapsedMs?: number }

// Derives per-stage status + elapsed time from the ordered log lines.
function computePipeline(log: string[], deploying: boolean): { stages: Record<string, StageState>; errorStageIdx: number } {
  const stages: Record<string, StageState> = {}
  for (const s of PIPELINE_STAGES) stages[s.id] = { status: 'pending' }

  // Find the index in PIPELINE_STAGES each marker corresponds to, and the
  // wall-clock-free ordering (line index) for elapsed estimation is not
  // available; we instead mark progression: a stage is "done" once a later
  // stage marker appears, "running" if it is the latest seen.
  let latestIdx = -1
  let errorStageIdx = -1

  for (const line of log) {
    const errMatch = line.match(/\[STAGE:ERROR\]/)
    if (errMatch) {
      // The error belongs to the most recently started stage (or resolve).
      errorStageIdx = latestIdx >= 0 ? latestIdx : 0
      continue
    }
    const m = line.match(/\[STAGE\]\s*(.+)$/)
    if (!m) continue
    const markerText = m[1].trim()
    const idx = PIPELINE_STAGES.findIndex(s => s.marker === markerText)
    if (idx === -1) continue
    // Everything before this is done.
    for (let i = 0; i < idx; i++) {
      if (stages[PIPELINE_STAGES[i].id].status !== 'error') stages[PIPELINE_STAGES[i].id].status = 'done'
    }
    latestIdx = idx
  }

  if (errorStageIdx >= 0) {
    stages[PIPELINE_STAGES[errorStageIdx].id].status = 'error'
    // Stages before the error are done; stages after stay pending.
    for (let i = 0; i < errorStageIdx; i++) {
      if (stages[PIPELINE_STAGES[i].id].status !== 'error') stages[PIPELINE_STAGES[i].id].status = 'done'
    }
  } else if (latestIdx >= 0) {
    const latestStage = PIPELINE_STAGES[latestIdx]
    if (latestStage.id === 'done') {
      stages[latestStage.id].status = 'done'
    } else {
      stages[latestStage.id].status = deploying ? 'running' : 'done'
    }
  }

  return { stages, errorStageIdx }
}

function PipelineBar({ log, deploying }: { log: string[]; deploying: boolean }) {
  const { stages } = useMemo(() => computePipeline(log, deploying), [log, deploying])
  const started = log.length > 0

  const stageIcon = (st: StageStatus, Icon: typeof Search) => {
    switch (st) {
      case 'running': return <Loader2 className="w-4 h-4 animate-spin" />
      case 'done': return <CheckCircle2 className="w-4 h-4" />
      case 'error': return <AlertCircle className="w-4 h-4" />
      default: return <Icon className="w-4 h-4" />
    }
  }
  const stageClasses = (st: StageStatus) => {
    switch (st) {
      case 'running': return 'bg-blue-500/15 border-blue-500/40 text-blue-300 animate-pulse'
      case 'done': return 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
      case 'error': return 'bg-red-500/15 border-red-500/40 text-red-300'
      default: return 'bg-slate-900 border-slate-800 text-slate-600'
    }
  }
  const connectorClass = (st: StageStatus) =>
    st === 'done' ? 'bg-emerald-500/40' : st === 'error' ? 'bg-red-500/40' : st === 'running' ? 'bg-blue-500/40' : 'bg-slate-800'

  return (
    <div className="flex items-center gap-1 mb-4 overflow-x-auto pb-1">
      {PIPELINE_STAGES.map((s, i) => {
        const st = stages[s.id].status
        return (
          <div key={s.id} className="flex items-center shrink-0">
            <div className={clsx('flex items-center gap-2 px-3 py-2 rounded-xl border transition-colors', stageClasses(started ? st : 'pending'))}>
              {stageIcon(started ? st : 'pending', s.icon)}
              <span className="text-xs font-medium whitespace-nowrap">{s.label}</span>
            </div>
            {i < PIPELINE_STAGES.length - 1 && (
              <div className={clsx('h-0.5 w-5 shrink-0 transition-colors', connectorClass(started ? st : 'pending'))} />
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function DeployPage() {
  const toast = useToast()
  const { can } = usePermissions()
  const { id } = useParams<{ id: string }>()

  const [deployments, setDeployments] = useState<DeploymentRecord[]>([])
  const [composeHistory, setComposeHistory] = useState<ComposeConfig[]>([])
  const [envHistory, setEnvHistory] = useState<EnvVarSet[]>([])
  const [settings, setSettings] = useState<DeploySettings | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<Omit<DeploySettings, 'id' | 'project_id'>>({
    health_timeout_secs: 120, deploy_timeout_secs: 300, health_stable_secs: 5, webhook_url: '', otel_enabled: false,
  })
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [composeServices, setComposeServices] = useState<ComposeServiceInfo[]>([])
  const [langOverrides, setLangOverrides] = useState<Record<string, string>>({})
  const [manualOpen, setManualOpen] = useState(false)
  const [manualName, setManualName] = useState('')
  const [manualLang, setManualLang] = useState('java')

  const [log, setLog] = useState<string[]>([])
  const [deploying, setDeploying] = useState(false)
  const [streamKey, setStreamKey] = useState('')

  const [rollbackCompose, setRollbackCompose] = useState(0)
  const [rollbackEnv, setRollbackEnv] = useState(0)
  const [expandLog, setExpandLog] = useState<string | null>(null)
  const [tags, setTags] = useState<DeployTag[]>([])
  const [newTagName, setNewTagName] = useState('')
  const [newTagDesc, setNewTagDesc] = useState('')
  const [tagComposeVer, setTagComposeVer] = useState(0)
  const [tagEnvVer, setTagEnvVer] = useState(0)
  const [showTagForm, setShowTagForm] = useState(false)
  const [tagSaving, setTagSaving] = useState(false)

  // Superadmin can reveal secret values in env-version previews (audited server-side).
  const { user } = useAuth()
  const isSuper = user?.role === 'superadmin'
  const [revealSecrets, setRevealSecrets] = useState(false)

  // "What will deploy" confirmation modal — target compose/env versions.
  const [confirmTarget, setConfirmTarget] = useState<{ compose: number; env: number; label: string } | null>(null)

  // Image overrides (deploy a previously-loaded image per service).
  const [imageOverrides, setImageOverrides] = useState<Record<string, string>>({})
  const [loadedImages, setLoadedImages] = useState<ImageUsage[]>([])

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

  // Single source of truth for env history; reveal is passed explicitly so there
  // is no effect-race between an initial (masked) load and a reveal refetch.
  const loadEnvHistory = (reveal: boolean) => {
    if (!id) return
    api.envHistory(id, reveal && isSuper).then(h => {
      setEnvHistory((h ?? []).slice().sort((a, b) => b.version - a.version))
    }).catch(() => {})
  }

  useEffect(() => {
    if (!id) return
    reload()
    api.composeHistory(id).then(h => {
      const sorted = (h ?? []).slice().sort((a, b) => b.version - a.version)
      setComposeHistory(sorted)
    }).catch(() => {})
    loadEnvHistory(false)
    setRevealSecrets(false)
    api.getDeploySettings(id).then(s => {
      setSettings(s)
      setSettingsDraft({
        health_timeout_secs: s.health_timeout_secs, deploy_timeout_secs: s.deploy_timeout_secs,
        health_stable_secs: s.health_stable_secs, webhook_url: s.webhook_url ?? '', otel_enabled: s.otel_enabled ?? false,
        otel_language_overrides: s.otel_language_overrides,
      })
      setLangOverrides(s.otel_language_overrides ?? {})
      setImageOverrides(s.image_overrides ?? {})
    }).catch(() => {})
    api.getComposeServices(id).then(r => setComposeServices(r.services ?? [])).catch(() => {})
    api.listDeployTags(id).then(t => setTags(t ?? [])).catch(() => {})
    api.imageUsage().then(r => setLoadedImages(r.images ?? [])).catch(() => {})
  }, [id])

  useEffect(() => {
    if (!logRef.current) return
    const last = log[log.length - 1] ?? ''
    const isError = /\[STAGE:ERROR\]|✗ Error|FAILED/.test(last)
    // Always scroll to surface errors; otherwise respect the user's scroll position.
    if (isError || isAtBottomRef.current) {
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

  const deleteComposeVer = async (version: number) => {
    if (!id) return
    try {
      await api.deleteComposeVersion(id, version)
      toast.success(`Deleted compose v${version}`)
      setComposeHistory(prev => prev.filter(c => c.version !== version))
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed') }
  }
  const deleteEnvVer = async (version: number) => {
    if (!id) return
    try {
      await api.deleteEnvVersion(id, version)
      toast.success(`Deleted env v${version}`)
      setEnvHistory(prev => prev.filter(s => s.version !== version))
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed') }
  }

  // requestDeploy opens the "what will deploy" confirmation; the modal calls
  // startDeploy on confirm. Every deploy/rollback action funnels through this so
  // the operator always sees exactly which compose+env version will go live.
  const requestDeploy = (composeVer = 0, envVer = 0) => {
    const label = composeVer || envVer ? 'Roll back / deploy specific version' : 'Deploy latest'
    setConfirmTarget({ compose: composeVer, env: envVer, label })
  }

  const saveSettings = async () => {
    if (!id) return
    setSettingsSaving(true)
    try {
      const payload = {
        ...settingsDraft,
        otel_language_overrides: Object.keys(langOverrides).length > 0 ? langOverrides : undefined,
        image_overrides: Object.keys(imageOverrides).length > 0 ? imageOverrides : undefined,
      }
      const s = await api.saveDeploySettings(id, payload)
      setSettings(s)
      setSettingsSaved(true)
      setTimeout(() => setSettingsSaved(false), 2000)
    } catch (e) {
      toast.error('Failed to save settings: ' + (e instanceof Error ? e.message : 'unknown'))
    }
    setSettingsSaving(false)
  }

  const latestCompose = composeHistory[0]
  const latestEnv = envHistory[0]

  // Most recent successful deployment — drives the "currently running" banner
  // and the quick-rollback target.
  const lastSuccessful = useMemo(
    () => deployments
      .filter(d => d.status === 'success')
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())[0],
    [deployments],
  )

  return (
    <div className="flex flex-col min-h-0">
    {!can(PERMS.deploy) && <ReadOnlyBanner message="You don't have permission to deploy. Viewing in read-only mode." />}
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
            onClick={() => requestDeploy()}
            disabled={deploying || !latestCompose || !can(PERMS.deploy)}
            title={!can(PERMS.deploy) ? 'You do not have permission to deploy' : undefined}
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

        {/* Visual pipeline */}
        {log.length > 0 && <PipelineBar log={log} deploying={deploying} />}

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

      {/* ── Release Tags + Rollback ──────────────────────────────────────────── */}
      <div className="card space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Release Tags &amp; Rollback</h2>
            <p className="text-xs text-slate-500 mt-0.5">Tags are created manually (GitLab-style). Tag a version, then deploy it any time.</p>
          </div>
          <div className="flex items-center gap-2">
            {lastSuccessful && can(PERMS.deploy) && (
              <button
                onClick={() => {
                  setTagComposeVer(lastSuccessful.new_compose_version)
                  setTagEnvVer(lastSuccessful.env_version)
                  setNewTagName(''); setNewTagDesc('')
                  setShowTagForm(true)
                }}
                title="Create a tag pinned to the last successfully deployed compose + env"
                className="btn-secondary text-xs gap-1.5"
              >
                <TagIcon className="w-3.5 h-3.5" /> Tag last deploy
              </button>
            )}
            <button onClick={() => setShowTagForm(f => !f)} className="btn-secondary text-xs gap-1.5">
              {showTagForm ? '✕ Cancel' : (<><span className="text-base leading-none">＋</span> Create tag</>)}
            </button>
          </div>
        </div>

        {/* Currently running + quick rollback */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-slate-950/60 border border-slate-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <Rocket className="w-4 h-4 text-emerald-400 shrink-0" />
            {lastSuccessful ? (
              <p className="text-xs text-slate-400">
                Currently running:&nbsp;
                <span className="text-slate-200 font-semibold font-mono">compose v{lastSuccessful.new_compose_version}</span>
                <span className="text-slate-600"> · </span>
                <span className="text-slate-200 font-semibold font-mono">{lastSuccessful.env_version > 0 ? `env v${lastSuccessful.env_version}` : 'no env'}</span>
                <span className="text-slate-600"> (deployed {relativeTime(lastSuccessful.started_at)})</span>
              </p>
            ) : (
              <p className="text-xs text-slate-500">No successful deployment yet</p>
            )}
          </div>
          {lastSuccessful && (
            <button
              onClick={() => requestDeploy(lastSuccessful.new_compose_version, lastSuccessful.env_version)}
              disabled={deploying}
              title="Re-deploy the last successful compose + env version"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/20 text-xs font-medium transition-all disabled:opacity-40 shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Quick rollback to last successful deploy
            </button>
          )}
        </div>

        {/* Tag list */}
        {tags.length === 0 && !showTagForm ? (
          <div className="flex flex-col items-center justify-center py-8 border border-dashed border-slate-800 rounded-xl text-slate-600 gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-8 h-8 opacity-40">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6z" />
            </svg>
            <p className="text-sm">No release tags yet</p>
            <p className="text-xs">Click "Create tag" (or "Tag last deploy") to mark a stable release for quick rollback.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {tags.map(t => {
              const isSelected = rollbackCompose === t.compose_version && rollbackEnv === t.env_version
              return (
                <div
                  key={t.id}
                  className={clsx(
                    'flex items-center gap-3 p-3 rounded-xl border transition-all cursor-pointer',
                    isSelected
                      ? 'bg-blue-600/10 border-blue-500/40'
                      : 'bg-slate-900/60 border-slate-800 hover:border-slate-700',
                  )}
                  onClick={() => { setRollbackCompose(t.compose_version); setRollbackEnv(t.env_version) }}
                >
                  {/* Tag icon */}
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-blue-500/15 border border-blue-500/25 text-blue-300">
                    <TagIcon className="w-4 h-4" />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-slate-100">{t.name}</span>
                      {isSelected && <span className="px-1.5 py-0.5 rounded bg-blue-600/20 text-blue-300 text-[10px] font-medium">selected</span>}
                      {t.protected && <span className="px-1.5 py-0.5 rounded bg-emerald-600/20 text-emerald-300 text-[10px]">protected</span>}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-[11px] text-slate-500 font-mono">
                      <span>compose v{t.compose_version || 'latest'}</span>
                      <span className="text-slate-700">·</span>
                      <span>env v{t.env_version || 'latest'}</span>
                      {t.description && <><span className="text-slate-700">·</span><span className="font-sans text-slate-600 truncate max-w-[200px]">{t.description}</span></>}
                    </div>
                    <p className="text-[10px] text-slate-700 mt-0.5">by {t.created_by} · {new Date(t.created_at).toLocaleString()}</p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={e => { e.stopPropagation(); requestDeploy(t.compose_version, t.env_version) }}
                      disabled={deploying}
                      title={`Deploy this tag (compose v${t.compose_version || 'latest'} · env v${t.env_version || 'latest'})`}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/20 text-xs font-medium transition-all disabled:opacity-40"
                    >
                      <Rocket className="w-3.5 h-3.5" />
                      Deploy
                    </button>
                    <button
                      onClick={async e => {
                        e.stopPropagation()
                        if (!id) return
                        await api.deleteDeployTag(id, t.id).catch(() => {})
                        setTags(prev => prev.filter(x => x.id !== t.id))
                        if (isSelected) { setRollbackCompose(0); setRollbackEnv(0) }
                      }}
                      title="Delete tag"
                      className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-all"
                    >
                      <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                        <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.808a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* New tag form */}
        {showTagForm && (
          <div className="p-4 rounded-xl bg-slate-950/60 border border-blue-500/20 space-y-3">
            <p className="text-xs font-semibold text-slate-300">Tag current version</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Tag name <span className="text-slate-600">(e.g. v1.0.0, stable)</span></label>
                <input
                  className="input w-full"
                  value={newTagName}
                  onChange={e => setNewTagName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && newTagName.trim() && !tagSaving && document.getElementById('createTagBtn')?.click()}
                  placeholder="v1.0.0"
                  autoFocus
                />
                {tags.some(t => t.name === newTagName.trim()) && (
                  <p className="text-xs text-amber-400 mt-1">⚠ A tag with this name already exists</p>
                )}
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Description <span className="text-slate-700">(optional)</span></label>
                <input className="input w-full" value={newTagDesc} onChange={e => setNewTagDesc(e.target.value)} placeholder="Production release" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Compose version</label>
                <select className="select w-full" value={tagComposeVer} onChange={e => setTagComposeVer(Number(e.target.value))}>
                  <option value={0}>Latest (v{latestCompose?.version ?? '—'}) ✓ current</option>
                  {composeHistory.map(c => <option key={c.id} value={c.version}>v{c.version} — {new Date(c.created_at).toLocaleDateString()}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Env version</label>
                <select className="select w-full" value={tagEnvVer} onChange={e => setTagEnvVer(Number(e.target.value))}>
                  <option value={0}>Latest (v{latestEnv?.version ?? '—'}) ✓ current</option>
                  {envHistory.map(s => <option key={s.id} value={s.version}>v{s.version} ({s.vars.length} vars)</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowTagForm(false)} className="btn-secondary text-xs">Cancel</button>
              <button
                id="createTagBtn"
                disabled={!newTagName.trim() || tagSaving || tags.some(t => t.name === newTagName.trim())}
                onClick={async () => {
                  if (!id || !newTagName.trim()) return
                  setTagSaving(true)
                  try {
                    const t = await api.createDeployTag(id, {
                      name: newTagName.trim(), description: newTagDesc.trim(),
                      compose_version: tagComposeVer || undefined,
                      env_version: tagEnvVer || undefined,
                    })
                    setTags(prev => [...prev, t])
                    setNewTagName(''); setNewTagDesc(''); setTagComposeVer(0); setTagEnvVer(0)
                    setShowTagForm(false)
                  } catch {}
                  setTagSaving(false)
                }}
                className="btn-primary text-xs"
              >
                {tagSaving ? 'Creating…' : 'Create tag'}
              </button>
            </div>
          </div>
        )}

        {/* Manual version pickers */}
        <div className="border-t border-slate-800 pt-4">
          <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-3">Manual version selection</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
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
                    v{c.version} — {new Date(c.created_at).toLocaleDateString()} by {c.created_by}
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
                    v{s.version} — {s.vars.length} vars, {new Date(s.created_at).toLocaleDateString()} by {s.created_by}
                  </option>
                ))}
              </select>
              {rollbackEnv > 0 && envHistory.find(s => s.version === rollbackEnv) && (
                <div className="mt-2">
                  {isSuper && (
                    <button
                      onClick={() => { const next = !revealSecrets; setRevealSecrets(next); loadEnvHistory(next) }}
                      className="mb-1 inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
                      title="Superadmin only — reveal is audited"
                    >
                      {revealSecrets ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                      {revealSecrets ? 'Hide secret values' : 'Reveal secret values'}
                    </button>
                  )}
                  <div className="text-xs text-slate-500 bg-slate-950 rounded p-3 max-h-40 overflow-y-auto">
                    {envHistory.find(s => s.version === rollbackEnv)?.vars.map(v => (
                      <div key={v.key} className="font-mono">
                        <span className="text-slate-300">{v.key}</span>
                        <span className="text-slate-600">=</span>
                        <span className="text-slate-500">{v.is_secret && !revealSecrets ? '••••••••' : v.value}</span>
                        {v.is_secret && <span className="ml-1 text-[9px] text-amber-500/70">secret</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <button
            onClick={() => requestDeploy(rollbackCompose, rollbackEnv)}
            disabled={deploying || !latestCompose}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-300 hover:bg-amber-500/20 text-sm font-medium transition-all disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 shrink-0">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
            </svg>
            Roll back to compose {rollbackCompose > 0 ? `v${rollbackCompose}` : 'latest'} · env {rollbackEnv > 0 ? `v${rollbackEnv}` : 'latest'}
          </button>
        </div>
      </div>

      {/* ── Manage versions (delete old compose/env versions) ───────────────── */}
      {can(PERMS.editCompose) && (composeHistory.length > 0 || envHistory.length > 0) && (
        <div className="card space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Manage Versions</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Delete old compose / env versions. The latest version and any version referenced by a tag are protected.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Compose versions */}
            <div>
              <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-2">Compose versions</p>
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {composeHistory.map((c, idx) => {
                  const isLatest = idx === 0
                  const tagged = tags.some(t => t.compose_version === c.version)
                  return (
                    <div key={c.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-900/60 border border-slate-800">
                      <div className="min-w-0">
                        <span className="font-mono text-xs text-slate-200">v{c.version}</span>
                        {isLatest && <span className="ml-2 text-[10px] text-emerald-400">latest</span>}
                        {tagged && <span className="ml-2 text-[10px] text-blue-400">tagged</span>}
                        <span className="ml-2 text-[10px] text-slate-600">{new Date(c.created_at).toLocaleDateString()} · {c.created_by}</span>
                      </div>
                      <button
                        disabled={isLatest || tagged}
                        title={isLatest ? 'Latest version cannot be deleted' : tagged ? 'Referenced by a tag — delete the tag first' : 'Delete this compose version'}
                        onClick={() => deleteComposeVer(c.version)}
                        className={clsx('p-1.5 rounded-lg transition-all shrink-0', (isLatest || tagged) ? 'text-slate-700 cursor-not-allowed' : 'text-slate-500 hover:text-red-400 hover:bg-red-500/10')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
            {/* Env versions */}
            <div>
              <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-2">Env versions</p>
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {envHistory.length === 0 && <p className="text-[11px] text-slate-600 italic">No env versions.</p>}
                {envHistory.map((s, idx) => {
                  const isLatest = idx === 0
                  const tagged = tags.some(t => t.env_version === s.version)
                  return (
                    <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-900/60 border border-slate-800">
                      <div className="min-w-0">
                        <span className="font-mono text-xs text-slate-200">v{s.version}</span>
                        <span className="ml-2 text-[10px] text-slate-500">{s.vars.length} vars</span>
                        {isLatest && <span className="ml-2 text-[10px] text-emerald-400">latest</span>}
                        {tagged && <span className="ml-2 text-[10px] text-blue-400">tagged</span>}
                      </div>
                      <button
                        disabled={isLatest || tagged}
                        title={isLatest ? 'Latest version cannot be deleted' : tagged ? 'Referenced by a tag — delete the tag first' : 'Delete this env version'}
                        onClick={() => deleteEnvVer(s.version)}
                        className={clsx('p-1.5 rounded-lg transition-all shrink-0', (isLatest || tagged) ? 'text-slate-700 cursor-not-allowed' : 'text-slate-500 hover:text-red-400 hover:bg-red-500/10')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Deploy settings ────────────────────────────────────────────────── */}
      <div className="card">
        <h2 className="text-sm font-semibold text-white mb-4">Deploy Settings</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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

        {/* Webhook URL */}
        <div className="mt-4">
          <label className="block text-xs text-slate-400 mb-1">Webhook URL <span className="text-slate-600">(optional — POST on deploy complete/fail)</span></label>
          <input
            type="url"
            placeholder="http://monitoring.intranet/deploy-hook"
            value={settingsDraft.webhook_url ?? ''}
            onChange={e => setSettingsDraft(d => ({ ...d, webhook_url: e.target.value }))}
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
          />
          <p className="text-xs text-slate-600 mt-1">
            HTTP POST on deploy complete or fail — use for Slack webhooks, monitoring, CI/CD callbacks, or any HTTP endpoint.
            Payload: <code className="text-slate-400 font-mono">{'{"status":"success|failed","project":"...","deploy_id":"...","timestamp":"..."}'}</code>
          </p>
        </div>

        {/* OpenTelemetry — toggle + per-service language picker */}
        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/30 overflow-hidden">
          <div className="flex items-center justify-between p-4">
            <div>
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={settingsDraft.otel_enabled ?? false}
                  onChange={e => setSettingsDraft(d => ({ ...d, otel_enabled: e.target.checked }))}
                  className="w-4 h-4 rounded border-slate-600 bg-slate-800 accent-blue-500"
                />
                <span className="text-sm font-medium text-slate-200">Enable OpenTelemetry tracing</span>
              </label>
              <p className="text-xs text-slate-500 mt-1 ml-[26px]">
                Injects OTEL_* env vars and tracer agents automatically per service.
                {settingsDraft.otel_enabled && <><br /><a href="/otel-traces" className="text-blue-400 hover:underline">Open App Traces →</a></>}
              </p>
            </div>
            <div className={`text-[10px] px-2 py-0.5 rounded font-semibold ${settingsDraft.otel_enabled ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-800 text-slate-600'}`}>
              {settingsDraft.otel_enabled ? 'ON' : 'OFF'}
            </div>
          </div>

          {settingsDraft.otel_enabled && (() => {
            const composeNames = new Set(composeServices.map(s => s.name))
            // Manual overrides = entries in langOverrides whose key isn't a known compose service.
            const manualNames = Object.keys(langOverrides).filter(n => !composeNames.has(n)).sort()
            const addManual = () => {
              const name = manualName.trim()
              if (!name) return
              setLangOverrides(prev => ({ ...prev, [name]: manualLang }))
              setManualName('')
              setManualLang('java')
              setManualOpen(false)
            }
            const removeOverride = (name: string) => {
              setLangOverrides(prev => {
                const next = { ...prev }
                delete next[name]
                return next
              })
            }
            return (
            <div className="border-t border-slate-800 px-4 pb-4 pt-3">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
                Service Language Overrides
              </p>
              <p className="text-[11px] text-slate-600 mb-3">
                OffDock auto-detects languages from image names. Override here when detection is wrong or the image name gives no hint (e.g. <code className="text-slate-400">keycloak</code>, custom builds). You can also add a service by name manually if it isn't in the compose file yet.
              </p>

              <div className="space-y-2">
                {/* Auto-detected compose services */}
                {composeServices.map(svc => {
                  const detected = (svc.detected_langs ?? []).length > 0 ? (svc.detected_langs ?? []).join(', ') : 'none detected'
                  const override = langOverrides[svc.name] ?? ''
                  return (
                    <div key={svc.name} className="flex items-center gap-3 text-sm">
                      <div className="flex-1 min-w-0">
                        <span className="font-mono text-slate-200 text-xs">{svc.name}</span>
                        {svc.image && (
                          <span className="ml-2 text-[10px] text-slate-600 font-mono truncate">{svc.image}</span>
                        )}
                      </div>
                      <select
                        value={override}
                        onChange={e => {
                          const v = e.target.value
                          setLangOverrides(prev => {
                            const next = { ...prev }
                            if (v === '') { delete next[svc.name] } else { next[svc.name] = v }
                            return next
                          })
                        }}
                        className="text-xs rounded border border-slate-700 bg-slate-900 text-slate-200 px-2 py-1 focus:outline-none focus:border-slate-500 shrink-0"
                      >
                        <option value="">Auto ({detected})</option>
                        <option value="java">Java</option>
                        <option value="nodejs">Node.js</option>
                        <option value="php">PHP</option>
                        <option value="python">Python</option>
                        <option value="ruby">Ruby</option>
                        <option value="dotnet">.NET / C#</option>
                        <option value="go">Go</option>
                        <option value="none">Disabled (skip)</option>
                      </select>
                      {override && override !== 'none' && (
                        <span className="text-[10px] text-blue-400 font-semibold shrink-0">overridden</span>
                      )}
                      {override === 'none' && (
                        <span className="text-[10px] text-slate-500 shrink-0">skipped</span>
                      )}
                    </div>
                  )
                })}

                {/* Manual overrides — services not present in the compose file */}
                {manualNames.map(name => {
                  const override = langOverrides[name] ?? ''
                  return (
                    <div key={name} className="flex items-center gap-3 text-sm">
                      <div className="flex-1 min-w-0">
                        <span className="font-mono text-slate-200 text-xs">{name}</span>
                        <span className="ml-2 text-[10px] text-amber-500/80 font-semibold shrink-0">manual</span>
                      </div>
                      <select
                        value={override}
                        onChange={e => {
                          const v = e.target.value
                          setLangOverrides(prev => ({ ...prev, [name]: v }))
                        }}
                        className="text-xs rounded border border-slate-700 bg-slate-900 text-slate-200 px-2 py-1 focus:outline-none focus:border-slate-500 shrink-0"
                      >
                        <option value="java">Java</option>
                        <option value="nodejs">Node.js</option>
                        <option value="php">PHP</option>
                        <option value="python">Python</option>
                        <option value="ruby">Ruby</option>
                        <option value="dotnet">.NET / C#</option>
                        <option value="go">Go</option>
                        <option value="none">Disabled (skip)</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => removeOverride(name)}
                        className="text-[10px] text-slate-500 hover:text-red-400 shrink-0 px-1"
                        title="Remove override"
                      >
                        Remove
                      </button>
                    </div>
                  )
                })}

                {composeServices.length === 0 && manualNames.length === 0 && (
                  <p className="text-[11px] text-slate-600 italic">No compose services detected. Use “Add manual override” below to map a service name to a language.</p>
                )}
              </div>

              {/* Add manual override */}
              <div className="mt-3 pt-3 border-t border-slate-800/60">
                {manualOpen ? (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <input
                      type="text"
                      autoFocus
                      placeholder="service name (e.g. keycloak)"
                      value={manualName}
                      onChange={e => setManualName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManual() } }}
                      className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500 font-mono"
                    />
                    <select
                      value={manualLang}
                      onChange={e => setManualLang(e.target.value)}
                      className="text-xs rounded border border-slate-700 bg-slate-900 text-slate-200 px-2 py-1 focus:outline-none focus:border-slate-500 shrink-0"
                    >
                      <option value="java">Java</option>
                      <option value="nodejs">Node.js</option>
                      <option value="php">PHP</option>
                      <option value="python">Python</option>
                      <option value="ruby">Ruby</option>
                      <option value="dotnet">.NET / C#</option>
                      <option value="go">Go</option>
                      <option value="none">Disabled (skip)</option>
                    </select>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={addManual}
                        disabled={!manualName.trim()}
                        className="text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-1"
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        onClick={() => { setManualOpen(false); setManualName(''); setManualLang('java') }}
                        className="text-xs text-slate-500 hover:text-slate-300 px-1"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setManualOpen(true)}
                    className="text-xs text-blue-400 hover:text-blue-300 font-medium"
                  >
                    + Add manual override
                  </button>
                )}
              </div>
            </div>
            )
          })()}
        </div>

        {/* Image overrides — deploy a specific previously-loaded image per service */}
        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/30 overflow-hidden">
          <div className="px-4 pt-4">
            <p className="text-sm font-medium text-slate-200">Image overrides</p>
            <p className="text-xs text-slate-500 mt-1">
              Deploy a specific previously-loaded image version per service (image rollback) without editing the compose YAML.
              Leave as “Use compose image” to keep what the compose file specifies.
            </p>
          </div>
          <div className="px-4 pb-4 pt-3 space-y-2">
            {composeServices.length === 0 ? (
              <p className="text-[11px] text-slate-600 italic">No compose services detected yet. Save a compose file first.</p>
            ) : composeServices.map(svc => {
              const current = imageOverrides[svc.name] ?? ''
              // Available loaded images as repo:tag (skip dangling <none>).
              const options = loadedImages
                .filter(i => i.repository && i.repository !== '<none>' && i.tag && i.tag !== '<none>')
                .map(i => `${i.repository}:${i.tag}`)
              const uniqueOptions = Array.from(new Set(options)).sort()
              return (
                <div key={svc.name} className="flex items-center gap-3 text-sm">
                  <div className="flex-1 min-w-0">
                    <span className="font-mono text-slate-200 text-xs">{svc.name}</span>
                    {svc.image && <span className="ml-2 text-[10px] text-slate-600 font-mono truncate">compose: {svc.image}</span>}
                  </div>
                  <select
                    value={current}
                    onChange={e => {
                      const v = e.target.value
                      setImageOverrides(prev => {
                        const next = { ...prev }
                        if (v === '') delete next[svc.name]; else next[svc.name] = v
                        return next
                      })
                    }}
                    className="text-xs rounded border border-slate-700 bg-slate-900 text-slate-200 px-2 py-1 focus:outline-none focus:border-slate-500 shrink-0 max-w-[260px]"
                  >
                    <option value="">Use compose image</option>
                    {uniqueOptions.map(o => <option key={o} value={o}>{o}</option>)}
                    {current && !uniqueOptions.includes(current) && <option value={current}>{current} (not loaded)</option>}
                  </select>
                  {current && <span className="text-[10px] text-blue-400 font-semibold shrink-0">overridden</span>}
                </div>
              )
            })}
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
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-slate-500 text-xs">
                  <th className="text-left px-4 py-2.5">Status</th>
                  <th className="text-left px-4 py-2.5">Compose</th>
                  <th className="text-left px-4 py-2.5">Env</th>
                  <th className="text-left px-4 py-2.5">Triggered By</th>
                  <th className="text-left px-4 py-2.5">Started</th>
                  <th className="text-left px-4 py-2.5">Duration</th>
                  <th className="text-left px-4 py-2.5">Log</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {deployments.map(d => (
                  <Fragment key={d.id}>
                    <tr className="border-b border-slate-800/50 hover:bg-slate-800/20 group">
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
                      <td className="px-4 py-2.5">
                        {d.status !== 'running' && d.status !== 'pending' && (
                          <div className="flex items-center justify-end gap-1">
                            {d.status === 'success' && (
                              <button
                                title="Re-deploy this compose + env version"
                                disabled={deploying}
                                onClick={() => requestDeploy(d.new_compose_version, d.env_version)}
                                className="opacity-0 group-hover:opacity-100 flex items-center gap-1 text-xs text-slate-500 hover:text-emerald-400 transition-all px-1.5 py-1 rounded hover:bg-emerald-500/10 disabled:opacity-40"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">Rollback to this</span>
                              </button>
                            )}
                            <button
                              title="Delete deployment record"
                              onClick={async () => {
                                if (!id) return
                                await api.deleteDeployment(id, d.id).catch(() => {})
                                setDeployments(prev => prev.filter(x => x.id !== d.id))
                                if (expandLog === d.id) setExpandLog(null)
                              }}
                              className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 transition-all p-1 rounded hover:bg-red-500/10"
                            >
                              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                                <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.808a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                              </svg>
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {expandLog === d.id && (
                      <tr className="border-b border-slate-800/50">
                        <td colSpan={8} className="px-4 pb-3">
                          <pre className="font-mono text-xs text-green-400 bg-slate-950 rounded p-3 max-h-64 overflow-y-auto whitespace-pre-wrap">
                            {d.log_text}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>

    {/* ── "What will deploy" confirmation ─────────────────────────────────── */}
    {confirmTarget && (() => {
      const composeVer = confirmTarget.compose || (latestCompose?.version ?? 0)
      const envVer = confirmTarget.env || (latestEnv?.version ?? 0)
      const composeSel = composeHistory.find(c => c.version === composeVer)
      const envSel = envHistory.find(s => s.version === envVer)
      const overrideEntries = Object.entries(imageOverrides)
      const isRollback = confirmTarget.compose > 0 || confirmTarget.env > 0
      return (
        <Modal open onClose={() => setConfirmTarget(null)} size="lg" icon={isRollback ? RotateCcw : Rocket}
          title={isRollback ? 'Confirm rollback / version deploy' : 'Confirm deploy'}
          subtitle="Review exactly what will go live before deploying."
          footer={<>
            <button onClick={() => setConfirmTarget(null)} className="btn-secondary">Cancel</button>
            <button
              onClick={() => { const t = confirmTarget; setConfirmTarget(null); if (t) startDeploy(t.compose, t.env) }}
              className="btn-primary"
            >
              <Rocket className="w-4 h-4" /> {isRollback ? 'Deploy this version' : 'Deploy latest'}
            </button>
          </>}>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Compose</p>
                <p className="text-sm font-mono text-slate-200">
                  v{composeVer || '—'} {confirmTarget.compose === 0 && <span className="text-slate-500 text-xs">(latest)</span>}
                </p>
                {composeSel && <p className="text-[11px] text-slate-600 mt-0.5">{new Date(composeSel.created_at).toLocaleString()} · {composeSel.created_by}</p>}
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Env</p>
                <p className="text-sm font-mono text-slate-200">
                  {envVer > 0 ? `v${envVer}` : 'none'} {confirmTarget.env === 0 && envVer > 0 && <span className="text-slate-500 text-xs">(latest)</span>}
                  {envSel && <span className="text-slate-500 text-xs"> · {envSel.vars.length} vars</span>}
                </p>
                {envSel && <p className="text-[11px] text-slate-600 mt-0.5">{new Date(envSel.created_at).toLocaleString()} · {envSel.created_by}</p>}
              </div>
            </div>

            {overrideEntries.length > 0 && (
              <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
                <p className="text-[10px] uppercase tracking-wider text-blue-400 mb-1.5">Image overrides applied</p>
                {overrideEntries.map(([svc, ref]) => (
                  <div key={svc} className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-slate-300">{svc}</span><span className="text-slate-600">→</span><span className="text-blue-300">{ref}</span>
                  </div>
                ))}
              </div>
            )}

            {composeSel && (
              <details>
                <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-200">Preview compose v{composeVer}</summary>
                <pre className="mt-2 text-[11px] text-slate-400 bg-slate-950 rounded p-3 overflow-auto max-h-56 whitespace-pre">{composeSel.raw_yaml}</pre>
              </details>
            )}
          </div>
        </Modal>
      )
    })()}
    </div>
  )
}
