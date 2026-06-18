import { useState } from 'react'
import clsx from 'clsx'
import {
  BookOpen, ChevronRight, Container, FolderTree,
  Globe, HelpCircle, Layers, Radio,
  Cpu, Users, Zap, Key,
  type LucideIcon,
} from 'lucide-react'
import { Page, PageHeader } from '../components/ui'

// ─── Section data ──────────────────────────────────────────────────────────────

interface Section {
  id: string
  label: string
  icon: LucideIcon
  content: () => JSX.Element
}

// ─── Shared primitives ─────────────────────────────────────────────────────────

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold text-slate-100 mb-3">{children}</h2>
}
function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-slate-200 mt-5 mb-2">{children}</h3>
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-slate-400 leading-relaxed mb-3">{children}</p>
}
function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-xs bg-slate-800 text-blue-300 px-1.5 py-0.5 rounded">{children}</code>
}
function Pre({ children }: { children: string }) {
  return (
    <pre className="bg-slate-950/80 border border-slate-800 rounded-lg p-3 text-[11px] text-slate-300 font-mono overflow-x-auto whitespace-pre leading-5 mb-3">
      {children}
    </pre>
  )
}
function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-300 text-xs mb-3">
      <Zap className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>{children}</span>
    </div>
  )
}
function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs mb-3">
      <HelpCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>{children}</span>
    </div>
  )
}
function Steps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-1.5 mb-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 text-sm text-slate-400">
          <span className="w-5 h-5 rounded-full bg-blue-500/20 border border-blue-500/30 text-blue-300 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
            {i + 1}
          </span>
          <span dangerouslySetInnerHTML={{ __html: item }} />
        </li>
      ))}
    </ol>
  )
}

// ─── Section content ───────────────────────────────────────────────────────────

function GettingStarted() {
  return (
    <>
      <H2>Getting Started</H2>
      <P>
        OffDock is an offline-first Docker deployment manager. A single binary with an
        embedded React UI manages containers, compose stacks, env-vars, nginx configs,
        and full-stack observability — entirely on air-gapped machines.
      </P>

      <H3>First login</H3>
      <Steps items={[
        'Navigate to the OffDock URL (default port 7070).',
        'You\'ll be redirected to <strong>/setup</strong> on first run.',
        'Create your admin account and set a strong password.',
        'Log in and you\'re on the Dashboard.',
      ]} />

      <H3>Roles</H3>
      <P>Three roles control access:</P>
      <div className="space-y-1.5 mb-3">
        {[
          { role: 'superadmin', desc: 'Full access — users, settings, system updates, OAuth SSO, audit log.' },
          { role: 'admin', desc: 'Manage projects, deploy, edit nginx, manage env vars and files.' },
          { role: 'viewer', desc: 'Read-only: view dashboards, logs, traces. Cannot deploy or edit.' },
        ].map(({ role, desc }) => (
          <div key={role} className="flex gap-3 text-sm">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-blue-300 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded h-fit mt-0.5 shrink-0">{role}</span>
            <span className="text-slate-400">{desc}</span>
          </div>
        ))}
      </div>

      <H3>Directory layout on the host</H3>
      <Pre>{`/usr/local/bin/offdock          ← binary
/etc/offdock/config.yaml        ← config (never overwritten by updates)
/var/offdock/data/              ← all *.db files (custom binary store)
/var/offdock/logs/offdock.log   ← log file (also captured by journald)
/var/offdock/certs/             ← TLS PEM bundles
/var/offdock/projects/<id>/     ← docker-compose.yml + .env files
/var/offdock/otel/              ← OTel tracer agents (node, php, python, ruby)`}</Pre>
    </>
  )
}

function ProjectsDeploy() {
  return (
    <>
      <H2>Projects &amp; Deployments</H2>
      <P>
        A <strong>project</strong> wraps a docker-compose stack with versioned configs,
        env vars, nginx config, and a deploy history. OffDock runs compose stacks in
        a zero-downtime cutover: it starts a parallel <em>_next</em> stack, waits for
        all containers to pass healthchecks, then stops the old stack.
      </P>

      <H3>Create a project</H3>
      <Steps items={[
        'Click <strong>+</strong> on the Dashboard or visit /projects/new.',
        'Give the project a name. The name becomes the compose project prefix.',
        'Add a docker-compose.yml on the <strong>Compose</strong> tab.',
        'Add environment variables on the <strong>Env</strong> tab (mark secrets as ●).',
        'Configure deploy settings on the <strong>Deploy</strong> tab.',
        'Click <strong>Deploy</strong>.',
      ]} />

      <H3>Deploy settings</H3>
      <div className="space-y-1.5 mb-3 text-sm text-slate-400">
        <div><Code>Health-check timeout</Code> — how long to wait for containers to become healthy (default 120 s).</div>
        <div><Code>Stable-for</Code> — how long a container must be in "running" state before it is considered healthy.</div>
        <div><Code>Pull images on deploy</Code> — run <Code>docker compose pull</Code> before up (requires registry access).</div>
        <div><Code>Enable OpenTelemetry</Code> — auto-injects OTel tracer agents for Java, Node.js, PHP, Python, Ruby.</div>
      </div>

      <H3>Environment variables</H3>
      <P>
        Env vars are versioned. Every save creates a new version — you can view history
        and restore any version from the <strong>History</strong> tab. Values are AES-encrypted
        at rest. Secret values (marked ●) are never returned in plaintext; enter <Code>••••••••</Code>
        to keep the existing value when saving.
      </P>

      <H3>Cloning a project</H3>
      <P>
        Use the clone button (⋯ menu) to create a new project with a copy of the
        latest compose config and env vars. Useful for staging/production branching.
      </P>
    </>
  )
}

function AppTracesContent() {
  return (
    <>
      <H2>App Traces (OpenTelemetry)</H2>
      <P>
        OffDock includes a built-in OTLP receiver and trace store. Containers can send
        spans to OffDock without any external Jaeger/Tempo instance. Traces are stored
        in OffDock's DB and displayed on the <strong>App Traces</strong> page with a
        Jaeger-compatible waterfall view.
      </P>

      <H3>Auto-injection (recommended)</H3>
      <P>
        Enable <strong>OpenTelemetry</strong> in Deploy Settings before deploying.
        OffDock auto-detects the runtime from the service's image name and injects
        the appropriate tracer agent — no code changes needed.
      </P>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3 text-xs">
        {[
          { lang: 'Java', detail: 'opentelemetry-javaagent.jar via JAVA_TOOL_OPTIONS', covers: 'Spring Boot, Quarkus, Micronaut, plain Java — all auto-instrumented.' },
          { lang: 'Node.js', detail: 'tracer.js via NODE_OPTIONS=--require', covers: 'http/https/fetch calls + express/fastify request handlers.' },
          { lang: 'PHP', detail: 'tracer.php via PHP_INI_SCAN_DIR', covers: 'Every incoming HTTP request.' },
          { lang: 'Python', detail: 'sitecustomize.py via PYTHONPATH', covers: 'http.client (covers requests, urllib3, httpx, etc.).' },
          { lang: 'Ruby', detail: 'tracer.rb via RUBYOPT=-r', covers: 'Net::HTTP (covers Faraday, HTTParty, open-uri, etc.).' },
        ].map(({ lang, detail, covers }) => (
          <div key={lang} className="bg-slate-900/60 border border-slate-800 rounded-lg p-2.5">
            <div className="font-semibold text-slate-200 mb-1">{lang}</div>
            <div className="text-slate-500 mb-0.5">{detail}</div>
            <div className="text-slate-400">{covers}</div>
          </div>
        ))}
      </div>
      <Tip>Tracer agents are in <Code>/var/offdock/otel/</Code> on the host, mounted read-only into each container.</Tip>

      <H3>Manual — simple JSON span API</H3>
      <P>
        Any language can send spans with a single HTTP POST — no SDK, no dependencies.
        The server auto-generates <Code>trace_id</Code> and <Code>span_id</Code> if absent.
      </P>
      <Pre>{`POST http://host.docker.internal:7070/v1/span
Content-Type: application/json

{
  "service":  "my-app",
  "name":     "processOrder",
  "start_ms": 1718000000000,
  "end_ms":   1718000000250,
  "status":   "ok",
  "tags":     {"order.id": "12345", "user.id": "42"}
}

→ {"trace_id":"...","span_id":"..."}`}</Pre>
      <P>
        For batch sends: <Code>POST /v1/spans</Code> with a JSON array.
        To chain spans, pass <Code>"parent_id"</Code> using the returned <Code>span_id</Code>.
      </P>

      <H3>OTLP endpoint (existing SDKs)</H3>
      <P>
        If your app already uses the OpenTelemetry SDK, point it at OffDock:
      </P>
      <Pre>{`OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:7070
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf   # or http/json
OTEL_SERVICE_NAME=my-service`}</Pre>
      <Tip>The OTel status endpoint (<Code>GET /api/v1/otel/status</Code>) returns the current endpoint URL with the actual host IP.</Tip>

      <H3>Retention</H3>
      <P>
        By default OffDock keeps the 50,000 most recent spans. Configure retention
        under <strong>Settings → Retention</strong>. Run <strong>Prune all</strong>
        from the App Traces page to immediately delete all spans.
      </P>
    </>
  )
}

function NetTracesContent() {
  return (
    <>
      <H2>Net Traces (tcpdump)</H2>
      <P>
        The <strong>Net Traces</strong> page captures and decodes live TCP traffic for any
        running container — without modifying the container or its code. It uses
        <Code>tcpdump</Code> on the container's Docker bridge interface.
      </P>

      <H3>Requirements</H3>
      <div className="space-y-1.5 mb-3">
        {[
          { label: 'tcpdump installed', cmd: 'which tcpdump', fix: 'sudo apt-get install -y tcpdump' },
          { label: 'OffDock runs as root or has CAP_NET_RAW', cmd: 'systemctl status offdock', fix: 'Ensure the systemd unit has AmbientCapabilities=CAP_NET_RAW' },
          { label: 'Container uses bridge networking', cmd: 'docker inspect --format \'{{.HostConfig.NetworkMode}}\' <name>', fix: 'Remove --network host; use the default bridge or a named bridge network' },
        ].map(({ label, cmd, fix }) => (
          <div key={label} className="bg-slate-900/60 border border-slate-800 rounded-lg p-2.5 text-xs">
            <div className="font-semibold text-slate-200 mb-1">✓ {label}</div>
            <div className="text-slate-500 font-mono mb-0.5">Check: {cmd}</div>
            <div className="text-slate-400">Fix: {fix}</div>
          </div>
        ))}
      </div>

      <H3>Supported protocols</H3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3 text-xs">
        {[
          { name: 'HTTP/1.x', port: '80, 8080, any', detail: 'Method, path, host, status, latency' },
          { name: 'PostgreSQL', port: '5432', detail: 'Full SQL text, parameter binding, rows affected' },
          { name: 'MySQL', port: '3306', detail: 'Full SQL text (COM_QUERY, COM_STMT_PREPARE)' },
          { name: 'MSSQL/TDS', port: '1433', detail: 'SQL Batch, UTF-16LE decoded' },
          { name: 'Redis', port: '6379', detail: 'Commands (GET/SET/DEL/…), AUTH redacted' },
          { name: 'MongoDB', port: '27017', detail: 'OP_MSG: find/insert/update/delete/aggregate' },
        ].map(({ name, port, detail }) => (
          <div key={name} className="bg-slate-900/60 border border-slate-800 rounded-lg p-2.5">
            <div className="font-semibold text-slate-200">{name}</div>
            <div className="text-slate-500 mb-0.5">Port: {port}</div>
            <div className="text-slate-400">{detail}</div>
          </div>
        ))}
      </div>

      <Warn>TLS-encrypted database connections are not visible at the network layer. Use plain TCP connections inside the Docker network, or rely on the OTel tracer for encrypted databases.</Warn>

      <H3>Trace sessions</H3>
      <P>
        Every trace stream is auto-saved as a session when the stream closes (client
        disconnect or container stop). Sessions are retained for up to 500 most recent
        by default. Use the <strong>Sessions</strong> tab to replay any past trace.
      </P>
    </>
  )
}

function NginxContent() {
  return (
    <>
      <H2>Nginx Reverse Proxy</H2>
      <P>
        OffDock manages nginx configs atomically — it writes to a temp file and
        renames it, then runs <Code>nginx -t</Code> before reloading so a broken
        config never goes live.
      </P>

      <H3>Per-project nginx</H3>
      <P>
        Each project has an <strong>Nginx</strong> tab where you configure the domain,
        upstream host/port, SSL, custom directives, and access logging. The config is
        regenerated on every deploy.
      </P>

      <H3>Standalone proxy hosts (Reverse Proxy page)</H3>
      <P>
        The <strong>Reverse Proxy</strong> page manages nginx hosts that are
        independent of any project — useful for proxying external services or
        static containers. Supports:
      </P>
      <div className="space-y-1 mb-3 text-sm text-slate-400">
        <div>• Multiple <strong>domains + aliases</strong> on one server block</div>
        <div>• <strong>SSL/TLS</strong> with a combined PEM file or separate cert+key</div>
        <div>• <strong>Extra location blocks</strong> (path-based routing to multiple upstreams)</div>
        <div>• WebSocket support per-location</div>
        <div>• <strong>Gzip</strong> compression toggle</div>
        <div>• <strong>Custom nginx directives</strong> (sandboxed — include/alias/root/lua blocked)</div>
      </div>

      <H3>Default catch-all</H3>
      <P>
        OffDock installs a catch-all server block that returns <Code>444</Code> for any
        request that doesn't match a configured domain — prevents nginx from serving
        requests to unknown virtual hosts.
      </P>

      <H3>SSL</H3>
      <P>
        Upload a combined PEM (cert + key concatenated) or specify separate cert and key
        paths. For Let's Encrypt: concatenate <Code>fullchain.pem</Code> +
        <Code>privkey.pem</Code>. Store PEM files in <Code>/var/offdock/certs/</Code>.
      </P>
    </>
  )
}

function EnvContent() {
  return (
    <>
      <H2>Environment Variables</H2>
      <P>
        Each project has a versioned env var store. Every save creates a new version;
        old versions are kept for auditing and can be restored at any time.
      </P>

      <H3>Secrets</H3>
      <P>
        Mark a variable as a <strong>secret</strong> to encrypt it at rest (AES-256).
        Secret values are shown as <Code>••••••••</Code> in the UI. To update a secret
        enter the new value; to keep the existing value leave the field as-is.
      </P>

      <H3>At deploy time</H3>
      <P>
        OffDock writes all env vars for the current version to a <Code>.env</Code> file
        in the project directory. Docker Compose reads this file automatically.
        If OpenTelemetry is enabled, <Code>OTEL_*</Code> vars are appended automatically.
      </P>

      <H3>Version history</H3>
      <P>
        The <strong>History</strong> tab shows all versions with timestamps and authors.
        Click <strong>Restore</strong> to create a new version that is a copy of any
        past version (including secrets — the encrypted values are preserved exactly).
      </P>

      <Warn>Env vars are per-project. Changing a value takes effect on the next deploy — running containers are not restarted automatically.</Warn>
    </>
  )
}

function FilesContent() {
  return (
    <>
      <H2>File Explorer</H2>
      <P>
        Browse, edit, create, rename, and delete files anywhere on the host filesystem.
        Designed for editing compose files, certs, nginx configs, and app data.
      </P>

      <H3>Supported operations</H3>
      <div className="space-y-1 mb-3 text-sm text-slate-400">
        <div>• <strong>Browse</strong> — click directories to navigate, breadcrumb to jump up</div>
        <div>• <strong>Edit</strong> — inline code editor with syntax highlighting for common types</div>
        <div>• <strong>Create file / folder</strong> — use the + buttons in the toolbar</div>
        <div>• <strong>Rename / move</strong> — right-click context menu</div>
        <div>• <strong>Delete</strong> — right-click context menu (no undo!)</div>
        <div>• <strong>Download</strong> — click the download icon on any file</div>
        <div>• <strong>Upload</strong> — drag-and-drop or the upload button</div>
      </div>

      <H3>Protected paths</H3>
      <P>
        Writes are blocked on sensitive paths to prevent accidental damage:
      </P>
      <div className="space-y-0.5 text-xs font-mono text-slate-500 mb-3">
        {['/etc/offdock/', '/var/offdock/data/', '/var/offdock/certs/', '/usr/local/bin/offdock', '/etc/passwd', '/etc/shadow'].map(p => (
          <div key={p} className="text-red-400/70">{p}</div>
        ))}
      </div>
      <Tip>To edit <Code>/etc/offdock/config.yaml</Code> use the <strong>System</strong> page config editor, which validates the YAML before saving.</Tip>
    </>
  )
}

function SystemContent() {
  return (
    <>
      <H2>System Administration</H2>
      <P>The <strong>System</strong> page (superadmin only) covers updates, health, logs, and DB maintenance.</P>

      <H3>Updating OffDock</H3>
      <Steps items={[
        'Upload the new <code class="font-mono text-xs bg-slate-800 text-blue-300 px-1 rounded">offdock-offline-YYYY-MM-DD.tar.gz</code> bundle via System → Update.',
        'OffDock validates the bundle, replaces the binary, and restarts the service (~3 s downtime).',
        'The old binary is saved as <code class="font-mono text-xs bg-slate-800 text-blue-300 px-1 rounded">offdock.bak</code> for rollback.',
      ]} />

      <H3>Rollback</H3>
      <P>
        If the new binary doesn't start, restore from the backup:
      </P>
      <Pre>{`# Via UI:  System → Update → Rollback
# Manually:
mv /usr/local/bin/offdock.bak /usr/local/bin/offdock
systemctl restart offdock`}</Pre>

      <H3>Compacting the database</H3>
      <P>
        The append-log DB grows over time. <strong>Compact DB</strong> rewrites each
        collection file keeping only live records. Run it if disk usage is unexpectedly
        high (especially after mass-deleting traces or audit events).
      </P>
      <Pre>{`POST /api/v1/system/compact
→ {"status":"ok","bytes_before":...,"bytes_after":...,"bytes_freed":...}`}</Pre>

      <H3>Application logs</H3>
      <P>
        Live log streaming is available under System → App Logs (or the <strong>App Logs</strong>
        sidebar item). Logs are also available via journald:
      </P>
      <Pre>{`journalctl -u offdock -f
# Or the log file directly:
tail -f /var/offdock/logs/offdock.log`}</Pre>

      <H3>Service management</H3>
      <Pre>{`systemctl status offdock
systemctl restart offdock
systemctl stop offdock`}</Pre>
    </>
  )
}

function OAuthContent() {
  return (
    <>
      <H2>OAuth2 / AO ID SSO</H2>
      <P>
        OffDock supports RP-initiated OIDC SSO via AO ID (or any standard OIDC provider).
        When enabled, a <strong>Continue with AO ID</strong> button appears on the login page.
        OAuth-provisioned users start with the Viewer role and can be promoted in the Users page.
      </P>

      <H3>Setup in AO ID</H3>
      <Steps items={[
        'Log in to the AO ID admin panel.',
        'Create a new application (type: Web).',
        'Set the <strong>Redirect URI</strong> to <code class="font-mono text-xs bg-slate-800 text-blue-300 px-1 rounded">https://your-offdock-host/api/v1/auth/oauth/callback</code>.',
        'Set <strong>Allowed logout URLs</strong> to <code class="font-mono text-xs bg-slate-800 text-blue-300 px-1 rounded">https://your-offdock-host/login?logged_out=1</code> (or your configured Post-Logout Redirect URI).',
        'Note the <strong>Client ID</strong> (and Client Secret if using confidential client).',
        'Set the Issuer to the AO ID base URL (e.g. <code class="font-mono text-xs bg-slate-800 text-blue-300 px-1 rounded">https://auth.ao.az</code>).',
      ]} />

      <H3>Setup in OffDock</H3>
      <Steps items={[
        'Go to <strong>Settings → AO ID OAuth2</strong> (superadmin only).',
        'Toggle <strong>Enable SSO login</strong>.',
        'Enter the <strong>Issuer URL</strong>, <strong>Client ID</strong>, and optionally the Client Secret.',
        'Click <strong>Auto-fill</strong> next to Redirect URI.',
        'Click <strong>Auto-fill</strong> next to Post-Logout Redirect URI (must match what you registered in AO ID).',
        'Click <strong>Save changes</strong>. The SSO button appears on the login page immediately.',
      ]} />

      <H3>Post-logout redirect</H3>
      <P>
        When a user clicks <strong>Sign out</strong>, OffDock revokes the local session
        and redirects to the IdP's logout endpoint. The IdP then redirects back to the
        configured <strong>Post-Logout Redirect URI</strong>. If this URI is not
        registered in the IdP's allowed logout URLs, the IdP will ignore it and redirect
        to its own default post-logout page instead.
      </P>
      <Warn>The Post-Logout Redirect URI must exactly match a URL registered in AO ID's <strong>Allowed logout URLs</strong> list. Use the Auto-fill button to generate the correct URL, then copy it to AO ID.</Warn>

      <H3>Claim mapping</H3>
      <P>
        OffDock reads three claims from the IdP's <Code>/oauth2/userinfo</Code> response:
        username (<Code>ldap_username</Code>), email (<Code>email</Code>), and full name (<Code>display_name</Code>).
        These defaults match AO IDP's fixed userinfo shape. Change the claim names under
        <strong> Settings → Claim Mapping</strong> if using a different IdP.
      </P>

      <H3>Self-signed IdP certificate</H3>
      <P>
        Set <Code>TLS skip verify</Code> or provide a CA cert file path under
        Settings → TLS if your AO ID server uses a self-signed or internal-CA certificate.
      </P>
    </>
  )
}

function TroubleshootingContent() {
  return (
    <>
      <H2>Troubleshooting</H2>

      <H3>Service won't start</H3>
      <Pre>{`journalctl -u offdock -n 50 --no-pager
tail -50 /var/offdock/logs/offdock.log`}</Pre>

      <H3>Net Tracing shows "disconnected"</H3>
      <div className="space-y-1.5 mb-3 text-sm text-slate-400">
        <div>1. Container must be running: <Code>docker inspect --format {'{{.State.Running}}'} {'<name>'}</Code></div>
        <div>2. Container must use bridge networking (not <Code>--network host</Code>)</div>
        <div>3. <Code>tcpdump</Code> must be installed: <Code>which tcpdump</Code></div>
        <div>4. OffDock must run as root or have <Code>CAP_NET_RAW</Code></div>
      </div>

      <H3>OTel traces not appearing</H3>
      <div className="space-y-1.5 mb-3 text-sm text-slate-400">
        <div>• Check the App Traces page status indicator — the endpoint URL is shown there.</div>
        <div>• Verify <Code>OTEL_EXPORTER_OTLP_ENDPOINT</Code> points to <Code>http://host.docker.internal:7070</Code></div>
        <div>• Verify <Code>host.docker.internal</Code> resolves inside the container (it's injected automatically by OffDock on deploy, but not for manually run containers).</div>
        <div>• Check that OTel tracer files exist on the host: <Code>ls /var/offdock/otel/</Code></div>
      </div>

      <H3>Deploy stuck in "Starting"</H3>
      <div className="space-y-1.5 mb-3 text-sm text-slate-400">
        <div>• Check container logs on the <strong>Logs</strong> tab for startup errors.</div>
        <div>• Increase <strong>Health-check timeout</strong> in Deploy Settings.</div>
        <div>• Ensure all images are loaded: <Code>docker images | grep {'<project>'}</Code></div>
      </div>

      <H3>SMTP fails with 5.7.4</H3>
      <P>
        Exchange on-prem advertises <Code>LOGIN</Code> auth, not <Code>PLAIN</Code>. OffDock
        tries LOGIN first. If the problem persists, set <Code>smtp_mode: starttls</Code>
        and check TLS settings. Use an IP address for <Code>smtp_host</Code> to avoid DNS issues.
      </P>

      <H3>OAuth logout doesn't redirect back</H3>
      <P>
        The <strong>Post-Logout Redirect URI</strong> must be registered in AO ID's
        <strong> Allowed logout URLs</strong> list. Go to Settings → AO ID OAuth2 and
        verify the Post-Logout Redirect URI, then register the same URL in AO ID.
      </P>

      <H3>Disk growing unexpectedly</H3>
      <Pre>{`# Check DB sizes:
ls -lh /var/offdock/data/

# Compact via API (frees tombstoned records):
curl -X POST -b 'offdock_token=...' http://localhost:7070/api/v1/system/compact

# Or via UI: System → Compact DB`}</Pre>

      <H3>JWT secret lost</H3>
      <P>
        If <Code>/etc/offdock/config.yaml</Code> is lost, all existing sessions become
        invalid. Generate a new secret and restart:
      </P>
      <Pre>{`head -c 48 /dev/urandom | base64
# Paste into jwt_secret: in /etc/offdock/config.yaml
systemctl restart offdock`}</Pre>
    </>
  )
}

// ─── Section registry ──────────────────────────────────────────────────────────

const SECTIONS: Section[] = [
  { id: 'getting-started', label: 'Getting Started',       icon: BookOpen,   content: GettingStarted },
  { id: 'projects',        label: 'Projects & Deploy',     icon: Container,  content: ProjectsDeploy },
  { id: 'app-traces',      label: 'App Traces (OTel)',      icon: Layers,     content: AppTracesContent },
  { id: 'net-traces',      label: 'Net Traces (tcpdump)',   icon: Radio,      content: NetTracesContent },
  { id: 'nginx',           label: 'Nginx / Reverse Proxy', icon: Globe,      content: NginxContent },
  { id: 'env',             label: 'Environment Variables', icon: Key,        content: EnvContent },
  { id: 'files',           label: 'File Explorer',         icon: FolderTree, content: FilesContent },
  { id: 'system',          label: 'System Admin',          icon: Cpu,        content: SystemContent },
  { id: 'oauth',           label: 'OAuth2 / SSO',          icon: Users,      content: OAuthContent },
  { id: 'troubleshooting', label: 'Troubleshooting',       icon: HelpCircle, content: TroubleshootingContent },
]

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function HelpPage() {
  const [active, setActive] = useState('getting-started')
  const current = SECTIONS.find(s => s.id === active) ?? SECTIONS[0]
  const Content = current.content

  return (
    <Page>
      <PageHeader
        title="Usage Guide"
        subtitle="Documentation for all OffDock features"
        icon={BookOpen}
      />

      <div className="flex gap-0 flex-1 min-h-0 overflow-hidden -mx-6 mt-2">
        {/* Sidebar nav */}
        <nav className="w-52 shrink-0 border-r border-slate-800/50 overflow-y-auto py-2 px-2 hidden sm:block">
          {SECTIONS.map(s => {
            const Icon = s.icon
            const isActive = s.id === active
            return (
              <button
                key={s.id}
                onClick={() => setActive(s.id)}
                className={clsx(
                  'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all text-left mb-0.5',
                  isActive
                    ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                    : 'text-slate-500 hover:text-slate-200 hover:bg-slate-800/50 border border-transparent',
                )}
              >
                <Icon className={clsx('w-3.5 h-3.5 shrink-0', isActive ? 'text-blue-400' : 'text-slate-600')} />
                {s.label}
              </button>
            )
          })}
        </nav>

        {/* Mobile section picker */}
        <div className="sm:hidden w-full px-4 pt-2 pb-0">
          <div className="flex overflow-x-auto gap-1 pb-2 mb-3 border-b border-slate-800/50">
            {SECTIONS.map(s => {
              const Icon = s.icon
              const isActive = s.id === active
              return (
                <button
                  key={s.id}
                  onClick={() => setActive(s.id)}
                  className={clsx(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all whitespace-nowrap shrink-0',
                    isActive
                      ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                      : 'text-slate-500 hover:text-slate-200 border border-slate-800',
                  )}
                >
                  <Icon className="w-3 h-3" />
                  {s.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 min-w-0">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 text-xs text-slate-600 mb-4">
            <BookOpen className="w-3 h-3" />
            <span>Usage Guide</span>
            <ChevronRight className="w-3 h-3" />
            <span className="text-slate-400">{current.label}</span>
          </div>

          {/* Section content */}
          <div className="max-w-2xl">
            <Content />
          </div>

          {/* Prev / Next */}
          <div className="flex gap-3 mt-8 max-w-2xl pt-4 border-t border-slate-800/50">
            {SECTIONS[SECTIONS.findIndex(s => s.id === active) - 1] && (() => {
              const prev = SECTIONS[SECTIONS.findIndex(s => s.id === active) - 1]
              const PrevIcon = prev.icon
              return (
                <button
                  onClick={() => setActive(prev.id)}
                  className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-200 transition-colors"
                >
                  <ChevronRight className="w-3.5 h-3.5 rotate-180" />
                  <PrevIcon className="w-3.5 h-3.5" />
                  {prev.label}
                </button>
              )
            })()}
            <span className="flex-1" />
            {SECTIONS[SECTIONS.findIndex(s => s.id === active) + 1] && (() => {
              const next = SECTIONS[SECTIONS.findIndex(s => s.id === active) + 1]
              const NextIcon = next.icon
              return (
                <button
                  onClick={() => setActive(next.id)}
                  className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-200 transition-colors"
                >
                  {next.label}
                  <NextIcon className="w-3.5 h-3.5" />
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              )
            })()}
          </div>
        </div>
      </div>
    </Page>
  )
}
