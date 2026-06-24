'use strict';
const _crypto = (() => { try { return require('crypto'); } catch { return null; } })();
/**
 * OffDock auto-tracer for Node.js — zero dependencies, fully offline.
 *
 * Loaded via: NODE_OPTIONS=--require /otel/node/tracer.js
 * (Injected automatically by OffDock when OpenTelemetry is enabled in deploy settings)
 *
 * What it traces automatically:
 *   - Incoming HTTP server requests  (http.createServer)
 *   - Outgoing HTTP/HTTPS calls      (http.request, https.request, fetch)
 *
 * Sends spans to OffDock at POST /v1/span (no external collector needed).
 */

const http  = require('http');
const https = require('https');

const ENDPOINT = (() => {
  const base = (
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    'http://host.docker.internal:7070'
  ).replace(/\/v1\/traces$/, '');
  return base + '/v1/span';
})();
const SERVICE = process.env.OTEL_SERVICE_NAME || process.env.npm_package_name || 'node-service';

function genId(bytes) {
  const n = bytes || 8; // 8 bytes = 16 hex chars (span_id); use 16 for trace_id
  if (_crypto) return _crypto.randomBytes(n).toString('hex');
  // Fallback for very old Node (should never happen in practice).
  return Array.from({ length: n * 2 }, () => (Math.random() * 16 | 0).toString(16)).join('');
}
function genTraceId() { return genId(16); } // 128-bit trace id per W3C
function genSpanId()  { return genId(8);  } // 64-bit span id per W3C

function send(span) {
  try {
    const url    = new URL(ENDPOINT);
    const body   = Buffer.from(JSON.stringify(span));
    const opts   = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout:  3000,
    };
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(opts);
    req.on('error', () => {});
    req.on('timeout', () => { req.destroy(); }); // prevent socket leak on timeout
    req.write(body);
    req.end();
  } catch { /* never let tracing crash the app */ }
}

/** Patch outgoing http.request / https.request calls. */
function patchOutgoing(mod) {
  const orig = mod.request.bind(mod);
  mod.request = function (options, cb) {
    const start = Date.now();
    const tid   = genTraceId();
    const sid   = genSpanId();

    let method = 'HTTP';
    let urlStr  = '';
    try {
      if (typeof options === 'string') {
        urlStr = options;
        method = 'GET';
      } else if (options instanceof URL) {
        urlStr = options.href;
        method = options.method || 'GET';
      } else {
        const host = options.hostname || options.host || 'localhost';
        const path = options.path || '/';
        const port = options.port ? `:${options.port}` : '';
        urlStr = `${options.protocol || 'http:'}//${host}${port}${path}`;
        method = (options.method || 'GET').toUpperCase();
      }
    } catch { urlStr = String(options); }

    const req = orig(options, cb);

    req.on('response', (res) => {
      const status = res.statusCode >= 500 ? 'error' : 'ok';
      send({
        trace_id: tid, span_id: sid,
        service:  SERVICE,
        name:     `${method} ${urlStr}`,
        start_ms: start,
        end_ms:   Date.now(),
        status,
        tags: { 'http.method': method, 'http.url': urlStr, 'http.status_code': String(res.statusCode) },
      });
    });

    req.on('error', (err) => {
      send({
        trace_id: tid, span_id: sid,
        service:  SERVICE,
        name:     `${method} ${urlStr}`,
        start_ms: start,
        end_ms:   Date.now(),
        status:   'error',
        error:    err.message,
        tags: { 'http.method': method, 'http.url': urlStr },
      });
    });

    return req;
  };

  // Also patch the shorthand .get()
  mod.get = function (options, cb) {
    const req = mod.request(options, cb);
    req.end();
    return req;
  };
}

/** Patch http.createServer to trace incoming requests. */
function patchServer(mod) {
  const orig = mod.createServer.bind(mod);
  mod.createServer = function (options, listener) {
    // createServer(listener) or createServer(options, listener)
    const handler = typeof options === 'function' ? options : listener;
    const opts    = typeof options === 'function' ? {}      : options;

    const wrapped = function (req, res) {
      const start   = Date.now();
      const tid     = req.headers['x-trace-id'] || req.headers['traceparent']?.split('-')[1] || genTraceId();
      const sid     = genSpanId();
      const method  = (req.method || 'GET').toUpperCase();
      const urlStr  = req.url || '/';

      res.on('finish', () => {
        const status = res.statusCode >= 500 ? 'error' : 'ok';
        send({
          trace_id: tid, span_id: sid,
          service:  SERVICE,
          name:     `${method} ${urlStr}`,
          start_ms: start,
          end_ms:   Date.now(),
          status,
          tags: {
            'http.method':      method,
            'http.url':         urlStr,
            'http.status_code': String(res.statusCode),
          },
        });
      });

      if (typeof handler === 'function') handler(req, res);
    };

    return typeof options === 'function'
      ? orig(wrapped)
      : orig(opts, wrapped);
  };
}

// Apply patches — skip http/https to avoid tracing our own span submissions.
const _origRequest = { http: http.request, https: https.request };
patchOutgoing(http);
patchOutgoing(https);
patchServer(http);
patchServer(https);

// Suppress recursive traces to the OffDock span endpoint itself.
const _endpointHost = (() => { try { return new URL(ENDPOINT).hostname; } catch { return ''; } })();
(function shieldEndpoint(mod, origReq) {
  const patched = mod.request;
  mod.request = function (options) {
    const host = (typeof options === 'string' ? new URL(options).hostname
      : options instanceof URL ? options.hostname
      : options.hostname || options.host || '') || '';
    if (host === _endpointHost) return origReq.apply(mod, arguments);
    return patched.apply(mod, arguments);
  };
})(http,  _origRequest.http);
(function shieldEndpoint(mod, origReq) {
  const patched = mod.request;
  mod.request = function (options) {
    const host = (typeof options === 'string' ? new URL(options).hostname
      : options instanceof URL ? options.hostname
      : options.hostname || options.host || '') || '';
    if (host === _endpointHost) return origReq.apply(mod, arguments);
    return patched.apply(mod, arguments);
  };
})(https, _origRequest.https);

// Optional: patch global fetch (Node 18+)
if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const start  = Date.now();
    const tid    = genTraceId();
    const sid    = genSpanId();
    const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : String(input));
    const method = ((init && init.method) || 'GET').toUpperCase();
    try {
      const res = await origFetch.apply(this, arguments);
      send({
        trace_id: tid, span_id: sid,
        service: SERVICE, name: `${method} ${urlStr}`,
        start_ms: start, end_ms: Date.now(),
        status: res.status >= 500 ? 'error' : 'ok',
        tags: { 'http.method': method, 'http.url': urlStr, 'http.status_code': String(res.status) },
      });
      return res;
    } catch (err) {
      send({
        trace_id: tid, span_id: sid,
        service: SERVICE, name: `${method} ${urlStr}`,
        start_ms: start, end_ms: Date.now(),
        status: 'error', error: err.message,
        tags: { 'http.method': method, 'http.url': urlStr },
      });
      throw err;
    }
  };
}

// ─── Database instrumentation (zero-dependency) ───────────────────────────────
// We can't pull in @opentelemetry/instrumentation-* offline, so we hook
// Module._load and wrap the common DB drivers' query methods directly. Each
// emits a span carrying db.system + db.statement so they show up in OffDock's
// Database view. Everything is wrapped in try/catch — tracing never breaks the app.
(function instrumentDatabases() {
  let Module;
  try { Module = require('module'); } catch { return; }
  const origLoad = Module._load;
  if (typeof origLoad !== 'function' || origLoad.__offdock) return;

  // Emit a DB span. `exec` runs the original call and we time it, supporting
  // both promise-returning and callback-style driver APIs.
  function dbSpan(system, statement, op, exec) {
    const start = Date.now();
    const tid = genTraceId(), sid = genSpanId();
    const finish = (status, error) => {
      const tags = { 'db.system': system, 'db.statement': String(statement || '').slice(0, 4096) };
      if (op) tags['db.operation'] = op;
      send({
        trace_id: tid, span_id: sid, service: SERVICE,
        name: `${system} ${op || 'query'}`, kind: 'client',
        start_ms: start, end_ms: Date.now(),
        status: status || 'ok', error: error || undefined, tags,
      });
    };
    try {
      const ret = exec();
      if (ret && typeof ret.then === 'function') {
        return ret.then(v => { finish('ok'); return v; },
                         e => { finish('error', e && e.message); throw e; });
      }
      finish('ok');
      return ret;
    } catch (e) { finish('error', e && e.message); throw e; }
  }

  // Wrap a method so the last callback arg (if any) settles the span; otherwise
  // the returned promise/value is timed by dbSpan.
  function wrap(obj, method, system, stmtOf, opOf) {
    if (!obj || typeof obj[method] !== 'function' || obj[method].__offdock) return;
    const orig = obj[method];
    const wrapped = function (...args) {
      let statement = '', op = '';
      try { statement = stmtOf(args); op = opOf ? opOf(args, statement) : ''; } catch {}
      // Callback style: the driver invokes a trailing function(err, res).
      const cbIdx = args.length - 1;
      if (typeof args[cbIdx] === 'function') {
        const start = Date.now(), tid = genTraceId(), sid = genSpanId();
        const cb = args[cbIdx];
        args[cbIdx] = function (err) {
          try {
            send({
              trace_id: tid, span_id: sid, service: SERVICE,
              name: `${system} ${op || 'query'}`, kind: 'client',
              start_ms: start, end_ms: Date.now(),
              status: err ? 'error' : 'ok', error: err && err.message,
              tags: { 'db.system': system, 'db.statement': String(statement).slice(0, 4096), ...(op ? { 'db.operation': op } : {}) },
            });
          } catch {}
          return cb.apply(this, arguments);
        };
        return orig.apply(this, args);
      }
      return dbSpan(system, statement, op, () => orig.apply(this, args));
    };
    wrapped.__offdock = true;
    try { obj[method] = wrapped; } catch {}
  }

  const sqlStmt = a => (typeof a[0] === 'string' ? a[0] : (a[0] && (a[0].sql || a[0].text)) || '');
  const sqlOp = (_a, s) => (String(s).trim().split(/\s+/)[0] || '').toUpperCase();

  const patchers = {
    pg(m) {
      if (m.Client) wrap(m.Client.prototype, 'query', 'postgresql', sqlStmt, sqlOp);
      if (m.Pool) wrap(m.Pool.prototype, 'query', 'postgresql', sqlStmt, sqlOp);
    },
    mysql(m) { if (m.createConnection) hookFactory(m, 'mysql'); },
    mysql2(m) { if (m.createConnection) hookFactory(m, 'mysql'); },
    ioredis(m) {
      const proto = (m && (m.prototype || (m.default && m.default.prototype)));
      if (proto) wrap(proto, 'sendCommand', 'redis', a => {
        const c = a[0]; return c && c.name ? (c.name + (c.args ? ' ' + c.args.slice(0, 4).join(' ') : '')) : 'redis';
      }, a => (a[0] && a[0].name ? String(a[0].name).toUpperCase() : 'CMD'));
    },
    redis(m) {
      // node-redis v4 returns a client factory; patch its commandsQueue at use-time is hard,
      // so wrap the low-level sendCommand on the client prototype when exposed.
      const C = m && (m.RedisClient || (m.default && m.default.RedisClient));
      if (C && C.prototype) wrap(C.prototype, 'sendCommand', 'redis',
        a => Array.isArray(a[0]) ? a[0].join(' ') : String(a[0] || 'redis'),
        a => (Array.isArray(a[0]) && a[0][0] ? String(a[0][0]).toUpperCase() : 'CMD'));
    },
    mongodb(m) {
      const Col = m && m.Collection;
      if (!Col || !Col.prototype) return;
      for (const op of ['find', 'findOne', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'aggregate', 'countDocuments']) {
        wrap(Col.prototype, op, 'mongodb',
          function () { try { return op + ' ' + (this && this.collectionName ? this.collectionName : ''); } catch { return op; } },
          () => op.toUpperCase());
      }
    },
  };

  function hookFactory(m, system) {
    // mysql/mysql2: wrap query/execute on the connection objects returned by the factory.
    for (const f of ['createConnection', 'createPool']) {
      if (typeof m[f] !== 'function' || m[f].__offdock) continue;
      const orig = m[f];
      const wrapped = function () {
        const conn = orig.apply(this, arguments);
        try {
          if (conn) {
            wrap(conn, 'query', system, sqlStmt, sqlOp);
            wrap(conn, 'execute', system, sqlStmt, sqlOp);
          }
        } catch {}
        return conn;
      };
      wrapped.__offdock = true;
      try { m[f] = wrapped; } catch {}
    }
  }

  const load = function (request) {
    const m = origLoad.apply(this, arguments);
    try {
      const base = String(request).split('/')[0];
      if (patchers[base] && m && !m.__offdockDb) {
        patchers[base](m);
        try { Object.defineProperty(m, '__offdockDb', { value: true, enumerable: false }); } catch {}
      }
    } catch {}
    return m;
  };
  load.__offdock = true;
  Module._load = load;
})();
