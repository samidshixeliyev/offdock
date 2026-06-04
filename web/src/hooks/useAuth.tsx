import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { api, User, ApiError } from '../api/client'

interface AuthContextValue {
  user: User | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  const login = async (username: string, password: string) => {
    await api.login(username, password)
    const me = await api.me()
    setUser(me)
  }

  const logout = async () => {
    if (user?.oauth_provider) {
      // OAuth user — full IdP logout via redirect (clears both Offdock + IdP sessions).
      window.location.href = api.oauthLogoutUrl()
      return
    }
    await api.logout()
    setUser(null)
  }

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export { ApiError }
