import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { usePermissions, PERMS } from '../hooks/usePermissions'
import { Lock } from 'lucide-react'

export default function ProjectsNewPage() {
  const navigate = useNavigate()
  const { can } = usePermissions()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const project = await api.createProject({ name, description })
      navigate(`/projects/${project.id}`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create project')
    } finally {
      setLoading(false)
    }
  }

  if (!can(PERMS.manageProjects)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-slate-400">
        <Lock className="w-10 h-10 opacity-40" />
        <p className="text-sm font-medium">You don't have permission to create projects.</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-xl">
      <h1 className="text-xl font-semibold text-white mb-6">New Project</h1>
      <div className="card">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Project Name <span className="text-red-400">*</span></label>
            <input className="input" value={name} onChange={e => setName(e.target.value)} required autoFocus placeholder="my-app" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Description</label>
            <input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional description" />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex gap-3">
            <button type="submit" disabled={loading} className="btn-primary">
              {loading ? 'Creating…' : 'Create Project'}
            </button>
            <button type="button" onClick={() => navigate('/')} className="btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}
