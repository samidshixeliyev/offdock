<?php
/**
 * OffDock auto-tracer for PHP — zero Composer dependencies, fully offline.
 *
 * Loaded via php.ini: auto_prepend_file = /otel/php/tracer.php
 * (Injected automatically by OffDock when OpenTelemetry is enabled)
 *
 * What it does automatically:
 *   - Continues the DISTRIBUTED trace: reads the incoming W3C `traceparent`
 *     header so this PHP request appears as a child of the calling service —
 *     true end-to-end traces across a gateway → PHP → … chain.
 *   - Emits a rich request span (method, route, status, sizes, client, ua…).
 *   - Captures uncaught exceptions and fatal errors as exception attributes
 *     (type, message, stacktrace) and marks the span as errored.
 *
 * Opt-in (one line) for DB query spans, no extension required:
 *   $pdo = offdock_pdo('mysql:host=db;dbname=app', 'user', 'pass');
 *   // every $pdo->query()/exec()/prepare()->execute() now emits a child span
 *   // with the full SQL statement, nested under the request — like Dynatrace.
 *
 * Manual spans / context propagation:
 *   offdock_traceparent();                  // forward on outgoing HTTP calls
 *   offdock_span('work', $startMs, [...]);  // custom child span
 *
 * Sends spans to OffDock at POST /v1/span (no external collector needed).
 */

defined('_OFFDOCK_TRACER') or define('_OFFDOCK_TRACER', true);

$_OTEL_BASE    = rtrim(getenv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') ?: getenv('OTEL_EXPORTER_OTLP_ENDPOINT') ?: 'http://host.docker.internal:7070', '/');
$_OTEL_BASE    = preg_replace('#/v1/traces$#', '', $_OTEL_BASE);
$_OTEL_ENDPOINT = $_OTEL_BASE . '/v1/span';
// Use OTEL_SERVICE_NAME, then hostname — never HTTP_HOST (attacker-controlled).
$_OTEL_SERVICE  = getenv('OTEL_SERVICE_NAME') ?: (gethostname() ?: 'php-service');
$_OTEL_START    = microtime(true);

// ─── Distributed context: continue the incoming W3C trace if present ──────────
$_OTEL_TRACE_ID = '';
$_OTEL_PARENT_ID = '';
$_otel_tp = $_SERVER['HTTP_TRACEPARENT'] ?? '';
if ($_otel_tp && preg_match('/^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i', $_otel_tp, $_m)) {
    $_OTEL_TRACE_ID  = strtolower($_m[1]);
    $_OTEL_PARENT_ID = strtolower($_m[2]);
}
if ($_OTEL_TRACE_ID === '') {
    $_OTEL_TRACE_ID = bin2hex(random_bytes(16));
}
$_OTEL_SPAN_ID = bin2hex(random_bytes(8));

// Expose the current context so the app can propagate it on outgoing calls.
$GLOBALS['_OFFDOCK_TRACEPARENT'] = "00-{$_OTEL_TRACE_ID}-{$_OTEL_SPAN_ID}-01";
putenv("OFFDOCK_TRACEPARENT={$GLOBALS['_OFFDOCK_TRACEPARENT']}");
$_SERVER['OFFDOCK_TRACEPARENT'] = $GLOBALS['_OFFDOCK_TRACEPARENT'];

// Track an uncaught exception / fatal so the request span can record it.
$GLOBALS['_OFFDOCK_EXC'] = null;

/**
 * The W3C traceparent header value for THIS request — pass it on outgoing
 * HTTP calls (curl: CURLOPT_HTTPHEADER ['traceparent: '.offdock_traceparent()])
 * so downstream services join the same end-to-end trace.
 */
function offdock_traceparent(): string {
    return $GLOBALS['_OFFDOCK_TRACEPARENT'] ?? '';
}

function _offdock_send_span(array $span): void {
    global $_OTEL_ENDPOINT;
    $body = json_encode($span, JSON_UNESCAPED_SLASHES);
    if ($body === false) return;

    // Non-blocking async socket so tracing never slows the app.
    try {
        $url   = parse_url($_OTEL_ENDPOINT);
        $host  = $url['host'] ?? 'host.docker.internal';
        $port  = $url['port'] ?? (($url['scheme'] ?? 'http') === 'https' ? 443 : 80);
        $path  = ($url['path'] ?? '/v1/span');
        $errno = 0; $errstr = '';
        // @-suppressed: fsockopen emits an E_WARNING (not a Throwable) when the
        // collector is unreachable, which try/catch can't catch — never leak it
        // into the traced app.
        $sock  = @fsockopen($host, (int)$port, $errno, $errstr, 0.5);
        if (!$sock) return;
        stream_set_timeout($sock, 1);
        $req = "POST {$path} HTTP/1.1\r\n"
             . "Host: {$host}\r\n"
             . "Content-Type: application/json\r\n"
             . "Content-Length: " . strlen($body) . "\r\n"
             . "Connection: close\r\n\r\n"
             . $body;
        fwrite($sock, $req);
        fclose($sock);
    } catch (Throwable $e) {
        // Never crash the app due to tracing.
    }
}

/**
 * Emit a child span under the current request. Low-level building block used by
 * the DB helper; apps can call it directly for custom work units.
 */
function offdock_span(string $name, float $startMs, array $tags = [], string $status = 'ok', string $kind = 'internal'): void {
    global $_OTEL_TRACE_ID, $_OTEL_SPAN_ID, $_OTEL_SERVICE;
    _offdock_send_span([
        'trace_id'  => $_OTEL_TRACE_ID,
        'span_id'   => bin2hex(random_bytes(8)),
        'parent_id' => $_OTEL_SPAN_ID,
        'service'   => $_OTEL_SERVICE,
        'name'      => $name,
        'kind'      => $kind,
        'start_ms'  => (int)$startMs,
        'end_ms'    => (int)(microtime(true) * 1000),
        'status'    => $status,
        'tags'      => $tags,
    ]);
}

function _offdock_db_span(string $sql, string $system, float $startMs, string $status, ?string $err = null): void {
    $op = strtoupper(strtok(ltrim($sql), " \t\n(") ?: 'QUERY');
    $tags = [
        'db.system'    => $system ?: 'sql',
        'db.statement' => $sql,
        'db.operation' => $op,
    ];
    if ($err !== null && $err !== '') {
        $tags['exception.message'] = $err;
    }
    offdock_span($op, $startMs, $tags, $status, 'client');
}

// ─── Opt-in DB instrumentation (no extension) ─────────────────────────────────
// `offdock_pdo(...)` returns a PDO whose queries each emit a child DB span.

// NOTE on signatures: PHP 8.1+ gives internal methods "tentative return types",
// so overriding PDO/PDOStatement methods without a matching return type emits an
// E_DEPRECATED ("return type should be compatible with …"). We add
// #[\ReturnTypeWillChange] to silence it — and we deliberately DECLARE NO return
// type (no `int|false` / `PDOStatement|false` unions) so the file also parses on
// PHP 7.4 (union types are 8.0+). On PHP 7.x the `#[...]` line is just a comment.
class OffDockPDOStatement extends PDOStatement {
    public $_offdockSystem = 'sql';
    protected function __construct() {}
    #[\ReturnTypeWillChange]
    public function execute($params = null) {
        $start = microtime(true) * 1000;
        $status = 'ok'; $err = null;
        try {
            $r = parent::execute($params);
        } catch (Throwable $e) {
            _offdock_db_span($this->queryString, $this->_offdockSystem, $start, 'error', $e->getMessage());
            throw $e;
        }
        if ($r === false) {
            $status = 'error';
            $info = $this->errorInfo();
            $err = isset($info[2]) ? (string)$info[2] : null;
        }
        _offdock_db_span($this->queryString, $this->_offdockSystem, $start, $status, $err);
        return $r;
    }
}

class OffDockPDO extends PDO {
    public $_offdockSystem = 'sql';
    public function __construct($dsn, $user = null, $pass = null, $options = null) {
        parent::__construct($dsn, $user, $pass, $options ?: []);
        $this->_offdockSystem = strtolower((string)$this->getAttribute(PDO::ATTR_DRIVER_NAME)) ?: 'sql';
        $this->setAttribute(PDO::ATTR_STATEMENT_CLASS, [OffDockPDOStatement::class]);
    }
    #[\ReturnTypeWillChange]
    public function query($query, ...$args) {
        $start = microtime(true) * 1000;
        try {
            $r = parent::query($query, ...$args);
        } catch (Throwable $e) {
            _offdock_db_span($query, $this->_offdockSystem, $start, 'error', $e->getMessage());
            throw $e;
        }
        _offdock_db_span($query, $this->_offdockSystem, $start, $r === false ? 'error' : 'ok');
        return $r;
    }
    #[\ReturnTypeWillChange]
    public function exec($statement) {
        $start = microtime(true) * 1000;
        try {
            $r = parent::exec($statement);
        } catch (Throwable $e) {
            _offdock_db_span($statement, $this->_offdockSystem, $start, 'error', $e->getMessage());
            throw $e;
        }
        _offdock_db_span($statement, $this->_offdockSystem, $start, $r === false ? 'error' : 'ok');
        return $r;
    }
    #[\ReturnTypeWillChange]
    public function prepare($query, $options = []) {
        $stmt = parent::prepare($query, $options);
        if ($stmt instanceof OffDockPDOStatement) {
            $stmt->_offdockSystem = $this->_offdockSystem;
        }
        return $stmt;
    }
}

/** Drop-in PDO replacement that auto-traces every query. */
function offdock_pdo($dsn, $user = null, $pass = null, $options = null): OffDockPDO {
    return new OffDockPDO($dsn, $user, $pass, $options);
}

// ─── Error / exception capture ────────────────────────────────────────────────
$_offdock_prev_handler = set_exception_handler(function (Throwable $e) {
    $GLOBALS['_OFFDOCK_EXC'] = [
        'type'  => get_class($e),
        'msg'   => $e->getMessage(),
        'stack' => $e->getTraceAsString(),
    ];
    // Re-raise via the previous handler if any, else default behaviour.
    if (!empty($GLOBALS['_offdock_prev_handler']) && is_callable($GLOBALS['_offdock_prev_handler'])) {
        call_user_func($GLOBALS['_offdock_prev_handler'], $e);
    }
});
$GLOBALS['_offdock_prev_handler'] = $_offdock_prev_handler;

// ─── Request span on shutdown ─────────────────────────────────────────────────
register_shutdown_function(function () {
    global $_OTEL_START, $_OTEL_TRACE_ID, $_OTEL_SPAN_ID, $_OTEL_PARENT_ID, $_OTEL_SERVICE;
    $end    = microtime(true);
    $method = $_SERVER['REQUEST_METHOD'] ?? 'CLI';
    $uri    = $_SERVER['REQUEST_URI']    ?? ($_SERVER['SCRIPT_FILENAME'] ?? 'cli');
    $path   = strtok($uri, '?');
    $status = http_response_code() ?: 200;

    $tags = [
        'http.method'      => $method,
        'http.route'       => $path,
        'http.target'      => $uri,
        'http.url'         => $uri,
        'http.status_code' => (string)$status,
        'http.scheme'      => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http',
        'http.flavor'      => $_SERVER['SERVER_PROTOCOL'] ?? '',
        'server.address'   => $_SERVER['SERVER_NAME'] ?? ($_SERVER['SERVER_ADDR'] ?? ''),
    ];
    if (!empty($_SERVER['HTTP_USER_AGENT']))   $tags['http.user_agent'] = $_SERVER['HTTP_USER_AGENT'];
    if (!empty($_SERVER['REMOTE_ADDR']))       $tags['client.address']  = $_SERVER['REMOTE_ADDR'];
    if (!empty($_SERVER['CONTENT_LENGTH']))    $tags['http.request_content_length'] = (string)$_SERVER['CONTENT_LENGTH'];

    $spanStatus = ($status >= 500) ? 'error' : 'ok';

    // Fatal error (E_ERROR/E_PARSE/etc.) captured at shutdown.
    $fatal = error_get_last();
    if ($fatal && in_array($fatal['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true)) {
        $GLOBALS['_OFFDOCK_EXC'] = $GLOBALS['_OFFDOCK_EXC'] ?? [
            'type'  => 'FatalError',
            'msg'   => $fatal['message'] ?? 'fatal error',
            'stack' => ($fatal['file'] ?? '') . ':' . ($fatal['line'] ?? ''),
        ];
    }
    if (!empty($GLOBALS['_OFFDOCK_EXC'])) {
        $exc = $GLOBALS['_OFFDOCK_EXC'];
        $tags['exception.type']       = (string)($exc['type'] ?? 'Error');
        $tags['exception.message']    = (string)($exc['msg'] ?? '');
        $tags['exception.stacktrace'] = (string)($exc['stack'] ?? '');
        $spanStatus = 'error';
    }

    $span = [
        'trace_id' => $_OTEL_TRACE_ID,
        'span_id'  => $_OTEL_SPAN_ID,
        'service'  => $_OTEL_SERVICE,
        'name'     => $method . ' ' . $path,
        'kind'     => 'server',
        'start_ms' => (int)($_OTEL_START * 1000),
        'end_ms'   => (int)($end * 1000),
        'status'   => $spanStatus,
        'tags'     => $tags,
    ];
    if ($_OTEL_PARENT_ID !== '') {
        $span['parent_id'] = $_OTEL_PARENT_ID;
    }
    _offdock_send_span($span);
});
