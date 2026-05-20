import { useEffect, useState } from 'react'
import { api } from '../api/client'

const NPM_COMPOSE = `services:
  nginx-proxy-manager:
    image: jc21/nginx-proxy-manager:latest
    restart: unless-stopped
    ports:
      - "80:80"
      - "81:81"
      - "443:443"
    volumes:
      - /var/offdock/npm/data:/data
      - /var/offdock/npm/letsencrypt:/etc/letsencrypt`

type Status = 'unknown' | 'checking' | 'up' | 'down'

function StatusBadge({ s }: { s: Status }) {
  const map: Record<Status, string> = {
    unknown:  'bg-gray-800 text-gray-400',
    checking: 'bg-yellow-900/50 text-yellow-400',
    up:       'bg-green-900/60 text-green-300',
    down:     'bg-red-900/50 text-red-400',
  }
  const label: Record<Status, string> = {
    unknown: 'Unknown', checking: 'Checking…', up: 'Online', down: 'Offline',
  }
  return (
    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${map[s]}`}>
      {s === 'up' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-1.5 animate-pulse" />}
      {label[s]}
    </span>
  )
}

export default function ReverseProxyPage() {
  const [url, setUrl] = useState(() => `http://${window.location.hostname}:81`)
  const [status, setStatus] = useState<Status>('unknown')
  const [iframeKey, setIframeKey] = useState(0)
  const [copied, setCopied] = useState(false)

  const check = async (target = url) => {
    setStatus('checking')
    try {
      const r = await api.proxyStatus(target)
      setStatus(r.accessible ? 'up' : 'down')
    } catch {
      setStatus('down')
    }
  }

  useEffect(() => { check() }, [])

  const connect = () => { setIframeKey(k => k + 1); check() }

  const copyCompose = () => {
    navigator.clipboard.writeText(NPM_COMPOSE).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* ── Top bar ────────────────────────────────────────────────── */}
      <div className="shrink-0 px-6 py-3 border-b border-gray-800 bg-gray-900 flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <span className="text-lg">🔀</span>
          <div>
            <h1 className="text-sm font-semibold text-white leading-none">Nginx Proxy Manager</h1>
            <p className="text-xs text-gray-500 mt-0.5">Docker-based reverse proxy with web UI</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-1 max-w-lg ml-4">
          <input
            className="input font-mono text-xs flex-1"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && connect()}
            placeholder="http://hostname:81"
          />
          <button onClick={connect} className="btn-ghost text-xs shrink-0">Connect</button>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <StatusBadge s={status} />
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="btn-primary text-xs"
          >
            Open ↗
          </a>
        </div>
      </div>

      {/* ── Main ───────────────────────────────────────────────────── */}
      {status === 'up' ? (
        <div className="flex-1 flex flex-col min-h-0">
          <iframe
            key={iframeKey}
            src={url}
            className="flex-1 w-full border-0 bg-gray-950"
            title="Nginx Proxy Manager UI"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
          />
          <p className="shrink-0 text-center text-xs text-gray-600 py-1.5 border-t border-gray-800">
            If the UI appears blank, your browser blocked the iframe.{' '}
            <a href={url} target="_blank" rel="noreferrer" className="text-blue-500 hover:text-blue-400">
              Open directly ↗
            </a>
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl mx-auto space-y-6">

            {/* Status */}
            {status === 'down' && (
              <div className="card border border-red-900/40 bg-red-900/10 flex items-start gap-3">
                <span className="text-red-400 text-lg shrink-0 mt-0.5">✕</span>
                <div>
                  <p className="text-sm font-medium text-red-300">NPM not reachable at <code className="font-mono">{url}</code></p>
                  <p className="text-xs text-gray-500 mt-1">Deploy it using the setup below, then click Connect.</p>
                </div>
              </div>
            )}

            {/* What is NPM */}
            <div className="card space-y-3">
              <h2 className="text-sm font-semibold text-white">What is Nginx Proxy Manager?</h2>
              <p className="text-sm text-gray-400 leading-relaxed">
                NPM is a Docker-based nginx reverse proxy with a polished web UI. It lets you route
                incoming requests to different Docker apps <strong className="text-gray-200">by hostname</strong> without
                touching a config file. It also handles automatic SSL certificates.
              </p>
              <div className="grid grid-cols-3 gap-3 pt-1">
                {[
                  ['Port 80', 'HTTP traffic'],
                  ['Port 443', 'HTTPS traffic'],
                  ['Port 81', 'Admin web UI'],
                ].map(([port, desc]) => (
                  <div key={port} className="bg-gray-800/50 rounded-lg px-3 py-2 text-center">
                    <p className="text-xs font-mono font-bold text-blue-400">{port}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Setup steps */}
            <div className="card space-y-4">
              <h2 className="text-sm font-semibold text-white">Quick Setup</h2>

              <div className="space-y-3">
                <div className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-blue-600/20 text-blue-400 text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">1</div>
                  <div>
                    <p className="text-sm text-gray-300 font-medium">Stop system nginx (NPM needs ports 80 and 443)</p>
                    <code className="block mt-1.5 font-mono text-xs bg-gray-950 border border-gray-800 rounded px-3 py-2 text-green-400">
                      sudo systemctl stop nginx && sudo systemctl disable nginx
                    </code>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-blue-600/20 text-blue-400 text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">2</div>
                  <div className="flex-1">
                    <p className="text-sm text-gray-300 font-medium">Create a project in OffDock with this compose</p>
                    <div className="relative mt-1.5">
                      <pre className="font-mono text-xs bg-gray-950 border border-gray-800 rounded px-3 py-3 text-gray-300 overflow-x-auto">
                        {NPM_COMPOSE}
                      </pre>
                      <button
                        onClick={copyCompose}
                        className="absolute top-2 right-2 text-xs text-gray-500 hover:text-gray-300 bg-gray-900 px-2 py-1 rounded border border-gray-700"
                      >
                        {copied ? '✓ Copied' : 'Copy'}
                      </button>
                    </div>
                    <p className="text-xs text-gray-600 mt-1.5">
                      Go to Dashboard → New Project → Compose tab → paste → Save → Deploy.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-blue-600/20 text-blue-400 text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">3</div>
                  <div>
                    <p className="text-sm text-gray-300 font-medium">Load the NPM image first (air-gapped)</p>
                    <p className="text-xs text-gray-500 mt-1">
                      Download <code className="text-gray-400">jc21/nginx-proxy-manager:latest</code> as a tar on an internet machine,
                      copy to USB, then load it via OffDock's Import page.
                    </p>
                    <code className="block mt-1.5 font-mono text-xs bg-gray-950 border border-gray-800 rounded px-3 py-2 text-green-400">
                      docker save jc21/nginx-proxy-manager:latest -o npm.tar
                    </code>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-blue-600/20 text-blue-400 text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">4</div>
                  <div>
                    <p className="text-sm text-gray-300 font-medium">Open NPM and add proxy hosts</p>
                    <p className="text-xs text-gray-500 mt-1">
                      Once deployed, access <code className="text-gray-400">http://your-server:81</code>.<br />
                      Default credentials: <code className="text-gray-400">admin@example.com</code> / <code className="text-gray-400">changeme</code>
                    </p>
                    <div className="mt-2">
                      <button onClick={connect} className="btn-primary text-xs">
                        Check Again & Connect
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* How it works with OffDock */}
            <div className="card space-y-3">
              <h2 className="text-sm font-semibold text-white">How it works with OffDock</h2>
              <div className="space-y-2 text-sm text-gray-400">
                <div className="flex items-start gap-2">
                  <span className="text-blue-400 shrink-0">→</span>
                  <p>Deploy your apps via OffDock on internal ports (e.g. 3000, 4000, 5000)</p>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-blue-400 shrink-0">→</span>
                  <p>In NPM, add a Proxy Host: <code className="text-gray-300">app.yourdomain.com</code> → <code className="text-gray-300">localhost:3000</code></p>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-blue-400 shrink-0">→</span>
                  <p>NPM handles HTTP→HTTPS redirect, SSL certs, and hostname routing automatically</p>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-blue-400 shrink-0">→</span>
                  <p>No need to configure system nginx — NPM replaces it entirely</p>
                </div>
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  )
}
