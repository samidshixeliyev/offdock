import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'

export default function ProjectsNewPage() {
  const navigate = useNavigate()
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
