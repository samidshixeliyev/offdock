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


# ─── Database instrumentation (zero-dependency) ───────────────────────────────
# No otel packages offline, so we hook __import__ and wrap the common DB drivers'
# execute methods. Each emits a span with db.system + db.statement so it lands in
# OffDock's Database view. Everything is guarded — tracing never breaks the app.
import builtins as _builtins
import secrets as _secrets

_orig_import = _builtins.__import__


def _db_span(system, statement, op, run):
    start = time.time()
    tid, sid = _secrets.token_hex(16), _secrets.token_hex(8)

    def _emit(status, error=None):
        tags = {'db.system': system, 'db.statement': str(statement)[:4096]}
        if op:
            tags['db.operation'] = op
        threading.Thread(target=_send, args=({
            'trace_id': tid, 'span_id': sid, 'service': _SERVICE,
            'name': f"{system} {op or 'query'}", 'kind': 'client',
            'start_ms': int(start * 1000), 'end_ms': int(time.time() * 1000),
            'status': status, 'error': error,
            'tags': tags,
        },), daemon=True).start()

    try:
        result = run()
        _emit('ok')
        return result
    except Exception as e:  # noqa: BLE001 — re-raised below
        _emit('error', str(e))
        raise


def _sql_op(stmt):
    try:
        return (str(stmt).strip().split() or [''])[0].upper()
    except Exception:
        return ''


def _wrap_cursor_execute(cursor_cls, system):
    for meth in ('execute', 'executemany'):
        orig = getattr(cursor_cls, meth, None)
        if orig is None or getattr(orig, '__offdock__', False):
            continue

        def make(orig_fn):
            def wrapper(self, operation, *a, **kw):
                return _db_span(system, operation, _sql_op(operation),
                                lambda: orig_fn(self, operation, *a, **kw))
            wrapper.__offdock__ = True
            return wrapper
        try:
            setattr(cursor_cls, meth, make(orig))
        except Exception:
            pass


def _wrap_dbapi_connect(module, system):
    orig_connect = getattr(module, 'connect', None)
    if orig_connect is None or getattr(orig_connect, '__offdock__', False):
        return

    def connect(*a, **kw):
        conn = orig_connect(*a, **kw)
        try:
            cur = conn.cursor()
            _wrap_cursor_execute(type(cur), system)
            try:
                cur.close()
            except Exception:
                pass
        except Exception:
            pass
        return conn
    connect.__offdock__ = True
    try:
        module.connect = connect
    except Exception:
        pass


def _patch_db_module(name, module):
    try:
        if name in ('psycopg2', 'psycopg'):
            _wrap_dbapi_connect(module, 'postgresql')
        elif name in ('pymysql', 'MySQLdb', 'mysql'):
            target = getattr(module, 'connector', module) if name == 'mysql' else module
            _wrap_dbapi_connect(target, 'mysql')
        elif name == 'sqlite3':
            _wrap_dbapi_connect(module, 'sqlite')
        elif name == 'pyodbc':
            _wrap_dbapi_connect(module, 'mssql')
        elif name in ('cx_Oracle', 'oracledb'):
            _wrap_dbapi_connect(module, 'oracle')
        elif name == 'redis':
            cls = getattr(module, 'Redis', None)
            if cls and not getattr(getattr(cls, 'execute_command', None), '__offdock__', False):
                orig = cls.execute_command

                def exec_cmd(self, *args, **kw):
                    cmd = ' '.join(str(x) for x in args[:5]) if args else 'redis'
                    op = str(args[0]).upper() if args else 'CMD'
                    return _db_span('redis', cmd, op, lambda: orig(self, *args, **kw))
                exec_cmd.__offdock__ = True
                cls.execute_command = exec_cmd
        elif name == 'pymongo':
            coll = getattr(getattr(module, 'collection', None), 'Collection', None)
            if coll:
                for op in ('find', 'find_one', 'insert_one', 'insert_many',
                           'update_one', 'update_many', 'delete_one', 'delete_many',
                           'aggregate', 'count_documents'):
                    orig = getattr(coll, op, None)
                    if orig is None or getattr(orig, '__offdock__', False):
                        continue

                    def make(orig_fn, opname):
                        def wrapper(self, *a, **kw):
                            stmt = f"{opname} {getattr(self, 'name', '')}"
                            return _db_span('mongodb', stmt, opname.upper(),
                                            lambda: orig_fn(self, *a, **kw))
                        wrapper.__offdock__ = True
                        return wrapper
                    try:
                        setattr(coll, op, make(orig, op))
                    except Exception:
                        pass
    except Exception:
        pass


_DB_MODULES = {'psycopg2', 'psycopg', 'pymysql', 'MySQLdb', 'mysql', 'sqlite3',
               'pyodbc', 'cx_Oracle', 'oracledb', 'redis', 'pymongo'}


def _patched_import(name, *a, **kw):
    module = _orig_import(name, *a, **kw)
    try:
        base = name.split('.')[0]
        if base in _DB_MODULES:
            import sys as _sys
            mod = _sys.modules.get(base, module)
            if not getattr(mod, '__offdock_db__', False):
                _patch_db_module(base, mod)
                try:
                    mod.__offdock_db__ = True
                except Exception:
                    pass
    except Exception:
        pass
    return module


_builtins.__import__ = _patched_import
