import { Lock } from 'lucide-react'

interface Props {
  message?: string
}

export function ReadOnlyBanner({ message = "You have read-only access. Some actions are disabled." }: Props) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-400 text-xs shrink-0">
      <Lock className="w-3.5 h-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  )
}
