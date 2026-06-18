"""
OffDock auto-tracer for Python — zero dependencies, fully offline.

Loaded via: PYTHONPATH=/otel/python:$PYTHONPATH  (Python auto-imports sitecustomize.py)
(Injected automatically by OffDock when OpenTelemetry is enabled in deploy settings)

What it traces automatically:
  - Outgoing HTTP/HTTPS calls via http.client
    (covers requests, urllib, urllib3, and any library built on http.client)

Sends spans to OffDock at POST /v1/span (no external collector needed).
"""
import os
import time
import json
import threading
import http.client as _hc
import urllib.parse as _up

_raw = (
    os.environ.get('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') or
    os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT') or
    'http://host.docker.internal:7070'
).rstrip('/')
if _raw.endswith('/v1/traces'):
    _raw = _raw[:-10]

_p = _up.urlparse(_raw)
_SPAN_HOST  = _p.hostname or 'host.docker.internal'
_SPAN_PORT  = _p.port or 7070
_SPAN_PATH  = '/v1/span'
_SPAN_HTTPS = _p.scheme == 'https'
_SERVICE    = os.environ.get('OTEL_SERVICE_NAME', 'python-service')

_orig_request      = _hc.HTTPConnection.request
_orig_getresponse  = _hc.HTTPConnection.getresponse


def _send(span):
    try:
        body = json.dumps(span).encode()
        ConnCls = _hc.HTTPSConnection if _SPAN_HTTPS else _hc.HTTPConnection
        c = ConnCls.__new__(ConnCls)
        _hc.HTTPConnection.__init__(c, _SPAN_HOST, _SPAN_PORT, timeout=2)
        _orig_request(c, 'POST', _SPAN_PATH, body, {
            'Content-Type': 'application/json',
            'Content-Length': str(len(body)),
        })
        _orig_getresponse(c).read()
        c.close()
    except Exception:
        pass


def _patched_request(self, method, url, body=None, headers=None, **kwargs):
    # Don't trace calls to the OffDock span endpoint itself.
    if getattr(self, 'host', '') == _SPAN_HOST:
        return _orig_request(self, method, url, body, headers or {}, **kwargs)
    import secrets
    self.__offdock__ = {
        'start': time.time(),
        'method': method,
        'url': url,
        'tid': secrets.token_hex(16),
        'sid': secrets.token_hex(8),
    }
    return _orig_request(self, method, url, body, headers or {}, **kwargs)


def _patched_getresponse(self):
    resp = _orig_getresponse(self)
    t = getattr(self, '__offdock__', None)
    if t is not None:
        del self.__offdock__
        scheme = 'https' if isinstance(self, _hc.HTTPSConnection) else 'http'
        port = getattr(self, 'port', 80) or 80
        full_url = f"{scheme}://{getattr(self, 'host', '')}:{port}{t['url']}"
        ok = resp.status < 500
        threading.Thread(
            target=_send,
            args=({
                'trace_id': t['tid'],
                'span_id':  t['sid'],
                'service':  _SERVICE,
                'name':     f"{t['method']} {full_url}",
                'start_ms': int(t['start'] * 1000),
                'end_ms':   int(time.time() * 1000),
                'status':   'ok' if ok else 'error',
                'tags': {
                    'http.method':      t['method'],
                    'http.url':         full_url,
                    'http.status_code': str(resp.status),
                },
            },),
            daemon=True,
        ).start()
    return resp


_hc.HTTPConnection.request     = _patched_request
_hc.HTTPConnection.getresponse = _patched_getresponse
