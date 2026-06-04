package store

// Default permission sets per built-in role.
// superadmin implicitly has every permission (handled in EffectivePermissions).
var adminDefaultPerms = AllPermissions // admin gets everything by default

// viewer gets no write permissions (read-only access across the app).
var viewerDefaultPerms = []Permission{}

// EffectivePermissions resolves a user's capabilities using this precedence:
//  1. superadmin → all permissions, always.
//  2. explicit user.Permissions (if non-empty) → used verbatim.
//  3. a referenced custom role's permissions (if set & found).
//  4. otherwise the built-in role defaults.
func EffectivePermissions(u User, roles []CustomRole) []Permission {
	if u.Role == RoleSuperAdmin {
		return AllPermissions
	}
	if len(u.Permissions) > 0 {
		return u.Permissions
	}
	if u.CustomRoleID != "" {
		for _, r := range roles {
			if r.ID == u.CustomRoleID {
				return r.Permissions
			}
		}
	}
	switch u.Role {
	case RoleAdmin:
		return adminDefaultPerms
	default:
		return viewerDefaultPerms
	}
}

// HasPermission reports whether the user holds the given capability.
func HasPermission(u User, roles []CustomRole, p Permission) bool {
	if u.Role == RoleSuperAdmin {
		return true
	}
	for _, have := range EffectivePermissions(u, roles) {
		if have == p {
			return true
		}
	}
	return false
}

// CanAccessProject reports whether a user may act on a given project.
// An empty ProjectIDs list means unrestricted (all projects).
func CanAccessProject(u User, projectID string) bool {
	if len(u.ProjectIDs) == 0 {
		return true
	}
	for _, id := range u.ProjectIDs {
		if id == projectID {
			return true
		}
	}
	return false
}
