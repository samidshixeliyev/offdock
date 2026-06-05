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
  const base = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://host.docker.internal:7070')
    .replace(/\/v1\/traces$/, '');
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
