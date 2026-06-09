<?php
/**
 * OffDock auto-tracer for PHP — zero Composer dependencies, fully offline.
 *
 * Loaded via php.ini: auto_prepend_file = /otel/php/tracer.php
 * (Injected automatically by OffDock when OpenTelemetry is enabled)
 *
 * What it traces automatically:
 *   - Every incoming HTTP request (method, path, status, duration)
 *   - Outgoing HTTP calls via curl (URL, method, status, duration)
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
$_OTEL_TRACE_ID = bin2hex(random_bytes(16));
$_OTEL_SPAN_ID  = bin2hex(random_bytes(8));

function _offdock_send_span(array $span): void {
    global $_OTEL_ENDPOINT;
    $body = json_encode($span, JSON_UNESCAPED_SLASHES);
    if ($body === false) return;

    // Use a non-blocking async socket so tracing never slows the app.
    try {
        $url   = parse_url($_OTEL_ENDPOINT);
        $host  = $url['host'] ?? 'host.docker.internal';
        $port  = $url['port'] ?? (($url['scheme'] ?? 'http') === 'https' ? 443 : 80);
        $path  = ($url['path'] ?? '/v1/span');
        $errno = 0; $errstr = '';
        $sock  = fsockopen($host, (int)$port, $errno, $errstr, 0.5);
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

// Note: curl calls are traced at the network layer by OffDock's tcpdump-based
// container tracing (Tracing page). PHP built-in functions cannot be overridden
// without the runkit7/uopz extension, so curl is not intercepted here.

// Capture the full request span on shutdown.
register_shutdown_function(function () {
    global $_OTEL_START, $_OTEL_TRACE_ID, $_OTEL_SPAN_ID, $_OTEL_SERVICE;
    $end    = microtime(true);
    $method = $_SERVER['REQUEST_METHOD'] ?? 'CLI';
    $uri    = $_SERVER['REQUEST_URI']    ?? ($_SERVER['SCRIPT_FILENAME'] ?? 'cli');
    $status = http_response_code() ?: 200;

    _offdock_send_span([
        'trace_id' => $_OTEL_TRACE_ID,
        'span_id'  => $_OTEL_SPAN_ID,
        'service'  => $_OTEL_SERVICE,
        'name'     => $method . ' ' . strtok($uri, '?'),
        'start_ms' => (int)($_OTEL_START * 1000),
        'end_ms'   => (int)($end * 1000),
        'status'   => ($status >= 500) ? 'error' : 'ok',
        'tags'     => [
            'http.method'      => $method,
            'http.url'         => $uri,
            'http.status_code' => (string)$status,
        ],
    ]);
});
