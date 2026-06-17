import { useRef } from 'react'
import { BookOpen, Download } from 'lucide-react'

// DocsPage renders the OffDock operator/developer guide. It is fully static and
// works offline. "Download PDF" uses the browser's native print-to-PDF on a
// print-styled clone of the content — no external library, no network.

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mb-8 scroll-mt-20">
      <h2 className="text-lg font-semibold text-slate-100 mb-3 pb-1.5 border-b border-slate-800">{title}</h2>
      <div className="space-y-3 text-sm text-slate-300 leading-relaxed">{children}</div>
    </section>
  )
}

function Code({ children }: { children: string }) {
  return (
    <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs text-slate-300 overflow-x-auto whitespace-pre font-mono">{children}</pre>
  )
}

const TOC = [
  ['offline-bundle', 'Offline bundle & install.sh'],
  ['images', 'Building Docker images for OffDock'],
  ['network', 'The offdock-external network'],
  ['compose', 'Writing docker-compose for OffDock'],
  ['envs', 'Environment variables & secrets'],
  ['resources', 'Resource management (limits, restart, health)'],
  ['deploy', 'Deploy, rollback & versioning'],
  ['backup', 'Backup, restore & recovery'],
  ['maintenance', 'Maintenance: reconcile & optimize'],
]

export default function DocsPage() {
  const ref = useRef<HTMLDivElement>(null)

  // Print-to-PDF: open a clean window with just the docs HTML + light print CSS,
  // then trigger the browser print dialog (user picks "Save as PDF").
  const downloadPDF = () => {
    const content = ref.current?.innerHTML ?? ''
    const w = window.open('', '_blank', 'width=900,height=700')
    if (!w) return
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>OffDock Guide</title>
      <style>
        body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:820px;margin:24px auto;padding:0 24px;line-height:1.55}
        h1{font-size:24px;border-bottom:2px solid #333;padding-bottom:8px}
        h2{font-size:18px;margin-top:28px;border-bottom:1px solid #ccc;padding-bottom:4px}
        h3{font-size:14px;margin-top:18px}
        pre{background:#f4f4f5;border:1px solid #ddd;border-radius:6px;padding:10px;font-size:12px;overflow:auto;white-space:pre-wrap}
        code{background:#f4f4f5;padding:1px 4px;border-radius:3px;font-size:12px}
        ul{padding-left:20px} li{margin:3px 0}
        table{border-collapse:collapse;width:100%} td,th{border:1px solid #ccc;padding:4px 8px;font-size:12px;text-align:left}
        @media print{a{color:#111;text-decoration:none}}
      </style></head><body>
      <h1>OffDock — Operator &amp; Developer Guide</h1>
      <p style="color:#666;font-size:12px">Generated ${new Date().toISOString().slice(0, 10)}</p>
      ${content}
      </body></html>`)
    w.document.close()
    w.focus()
    setTimeout(() => { w.print() }, 300)
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center">
            <BookOpen className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-slate-100">Documentation</h1>
            <p className="text-sm text-slate-500 mt-0.5">Deploying apps with OffDock — images, networks, compose, recovery.</p>
          </div>
        </div>
        <button onClick={downloadPDF} className="btn-primary text-sm flex items-center gap-2">
          <Download className="w-4 h-4" /> Download PDF
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-6">
        {/* TOC */}
        <nav className="hidden lg:block sticky top-6 self-start text-sm">
          <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-widest mb-2">Contents</p>
          <ul className="space-y-1">
            {TOC.map(([id, label]) => (
              <li key={id}><a href={`#${id}`} className="text-slate-400 hover:text-blue-400 transition-colors">{label}</a></li>
            ))}
          </ul>
        </nav>

        {/* Content (also the source for the PDF export) */}
        <div ref={ref} className="max-w-3xl">
          <Section id="offline-bundle" title="Offline bundle & install.sh">
            <p>OffDock ships as a single binary plus a single script, <code>install.sh</code>, which handles every operation via flags. There are no other scripts.</p>
            <table>
              <thead><tr><th>Command</th><th>What it does</th></tr></thead>
              <tbody>
                <tr><td><code>bash install.sh --bundle</code></td><td>Build the offline <code>.tar.gz</code> (binary + frontend + debs + images). No root needed.</td></tr>
                <tr><td><code>sudo bash install.sh --full --domain D</code></td><td>Non-interactive offline install: Docker + nginx + network tools from bundled debs, loads images, verifies tools, starts OffDock.</td></tr>
                <tr><td><code>sudo bash install.sh</code></td><td>Interactive install (prompts for port/domain/SSL).</td></tr>
                <tr><td><code>sudo bash install.sh --update</code></td><td>Replace the binary and restart (data/config preserved).</td></tr>
                <tr><td><code>sudo bash install.sh --restore ARCHIVE</code></td><td>Restore a backup archive (db, projects, certs, nginx, volumes).</td></tr>
                <tr><td><code>sudo bash install.sh --uninstall</code></td><td>Remove OffDock (keeps <code>/var/offdock</code> data).</td></tr>
              </tbody>
            </table>
            <h3>Bundled deb categories</h3>
            <p>The bundle's <code>debs/</code> folder is split by purpose so an air-gapped host gets everything it needs:</p>
            <ul>
              <li><strong>debs/docker</strong> — docker-ce, cli, containerd, buildx, compose plugin + libs.</li>
              <li><strong>debs/nginx</strong> — nginx core/common/full + modules.</li>
              <li><strong>debs/network</strong> — tcpdump (tracing), dnsutils, iproute2, iptables, conntrack, socat, curl, jq, openssl.</li>
            </ul>
            <p>Debs are release-specific. Re-gather them on a machine matching your target Ubuntu release if needed.</p>
          </Section>

          <Section id="images" title="Building Docker images for OffDock">
            <p>OffDock is air-gapped: images arrive as <code>.tar</code> files, not from a registry. Build on a connected machine, save to tar, transfer, and load via the Images page (or <code>docker load</code>).</p>
            <Code>{`# 1. Build your image, pinned to a version tag (never rely on :latest offline)
docker build -t myapp:1.0.0 .

# 2. Save it to a tar (this is what you carry on USB)
docker save myapp:1.0.0 -o myapp-1.0.0.tar

# 3. On the OffDock host: Images → Load, or
docker load -i myapp-1.0.0.tar`}</Code>
            <p><strong>Rules:</strong> always use explicit version tags; include every dependency in the image (no apt/npm at runtime); keep images small (multi-stage builds) to fit on transfer media.</p>
          </Section>

          <Section id="network" title="The offdock-external network">
            <p>OffDock manages two shared Docker networks so services across different compose projects can talk to each other and to the reverse proxy:</p>
            <ul>
              <li><strong>offdock-external</strong> — a bridge network for services that nginx proxies to, and for cross-project communication. Attach anything that must be reachable by the proxy or other stacks.</li>
              <li><strong>offdock-internal</strong> — for private service-to-service traffic that should not be proxied.</li>
            </ul>
            <p>Declare it as an <em>external</em> network in your compose so OffDock's shared network is used rather than a throwaway per-project one:</p>
            <Code>{`services:
  api:
    image: myapi:1.0.0
    networks: [offdock-external, offdock-internal]
  db:
    image: postgres:16
    networks: [offdock-internal]   # not proxied, private only

networks:
  offdock-external:
    external: true
  offdock-internal:
    external: true`}</Code>
            <p>Create custom networks (with subnet/gateway/IPAM) on the Networks page if you need isolated address ranges.</p>
          </Section>

          <Section id="compose" title="Writing docker-compose for OffDock">
            <p>OffDock stores compose YAML versioned per project. Saving identical content does <strong>not</strong> create a new version (dedup by content hash). Guidelines:</p>
            <ul>
              <li>Pin images to tags you have loaded (<code>myapp:1.0.0</code>).</li>
              <li>Use <code>restart: unless-stopped</code> so containers return after a Docker restart.</li>
              <li>Add a <code>healthcheck</code> — the deploy engine waits for health before marking success.</li>
              <li>One-shot/init containers that exit 0 are treated as healthy.</li>
              <li>Reference shared networks as <code>external: true</code> (see above).</li>
            </ul>
            <Code>{`services:
  web:
    image: myapp:1.0.0
    restart: unless-stopped
    ports: ["8080:80"]
    env_file: [.env]          # OffDock writes .env at deploy time
    networks: [offdock-external]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost/health"]
      interval: 10s
      timeout: 3s
      retries: 5

networks:
  offdock-external:
    external: true`}</Code>
            <p>Per-project DNS servers, search domains, and extra hosts (set in Deploy Settings) are injected into every service automatically at deploy time — your stored YAML stays clean.</p>
          </Section>

          <Section id="envs" title="Environment variables & secrets">
            <p>Env vars are versioned per project and encrypted at rest (AES-256-GCM, key derived from the host machine-id). Mark sensitive values as <strong>secret</strong>; the API returns <code>********</code> for them and never exposes the plaintext.</p>
            <ul>
              <li>OffDock writes a <code>.env</code> file into the project directory at deploy time, decrypting secrets only then.</li>
              <li>Re-saving the same values (including unchanged masked secrets) does not create a new version.</li>
              <li>Values with newlines/quotes are safely escaped in the generated <code>.env</code>.</li>
              <li>Reference them in compose via <code>env_file</code> or <code>${'{'}VAR{'}'}</code> interpolation.</li>
            </ul>
          </Section>

          <Section id="resources" title="Resource management (limits, restart, health)">
            <p>Control resource usage directly in compose; OffDock applies it verbatim:</p>
            <Code>{`services:
  api:
    image: myapi:1.0.0
    restart: unless-stopped
    deploy:
      resources:
        limits:   { cpus: "1.0", memory: 512M }
        reservations: { memory: 128M }
    mem_swappiness: 0
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }`}</Code>
            <p>Use the System page's <strong>Optimize</strong> to reclaim memory/disk (compact DB, drop caches, optional <code>docker system prune</code> — never touches volumes).</p>
          </Section>

          <Section id="deploy" title="Deploy, rollback & versioning">
            <p>Each deploy uses a specific compose + env version pair. Successful deploys are auto-tagged; you can also create named, protected tags.</p>
            <ul>
              <li><strong>Rollback</strong> to any tag, past deployment, or explicit version pair from the Deploy page.</li>
              <li>Enable <strong>Rollback on failure</strong> in Deploy Settings to auto-revert to the last good version if a deploy fails its health check.</li>
              <li>Deploys are serialized per project (no concurrent races).</li>
            </ul>
          </Section>

          <Section id="backup" title="Backup, restore & recovery">
            <p>The System → Backups section creates archives containing the database, project files, certs, nginx vhosts, optionally <code>config.yaml</code> (encryptable), and <strong>Docker volume data</strong> — the actual container data.</p>
            <ul>
              <li>Schedule daily backups with retention and an optional off-box copy directory (USB/NFS).</li>
              <li>Restore from the UI (dry-run preview first) or on the host: <code>sudo bash install.sh --restore archive.tar.gz</code>.</li>
              <li>Volume backup/restore uses a helper image — keep <code>alpine</code> (or busybox) loaded.</li>
            </ul>
          </Section>

          <Section id="maintenance" title="Maintenance: reconcile & optimize">
            <p>After a host reboot, Docker reinstall, or nginx purge, OffDock self-heals automatically on startup and on demand via System → Maintenance → <strong>Run Reconcile</strong>:</p>
            <ul>
              <li>Ensures the Docker daemon is up.</li>
              <li>Re-runs <code>compose up</code> for every project marked running.</li>
              <li>Re-applies all active nginx vhosts and proxy hosts from the database.</li>
            </ul>
            <p>Protected packages (Docker, nginx) are held via <code>apt-mark hold</code> so <code>apt --fix-broken install</code> can never remove them. Install new <code>.deb</code> files safely from System → Host Packages, which simulates first and refuses any operation that would remove a protected package.</p>
          </Section>
        </div>
      </div>
    </div>
  )
}
