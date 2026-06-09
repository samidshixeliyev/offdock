import { useAuth } from './useAuth'

export const PERMS = {
  deploy:          'deploy',
  editCompose:     'edit_compose',
  editEnv:         'edit_env',
  manageProxy:     'manage_proxy',
  manageNetwork:   'manage_network',
  manageImages:    'manage_images',
  containerOps:    'container_ops',
  terminal:        'terminal',
  manageFiles:     'manage_files',
  manageProjects:  'manage_projects',
  manageDNS:       'manage_dns',
} as const

export type PermKey = typeof PERMS[keyof typeof PERMS]

export function usePermissions() {
  const { user } = useAuth()

  // /me returns effective permissions (resolved by backend), so we can check
  // user.permissions directly. superadmin always has all permissions.
  const can = (perm: string): boolean => {
    if (!user) return false
    if (user.role === 'superadmin') return true
    return user.permissions?.includes(perm) ?? false
  }

  const isSuperAdmin = user?.role === 'superadmin'
  const isAdmin = user?.role === 'admin' || isSuperAdmin

  return { can, isSuperAdmin, isAdmin }
}
