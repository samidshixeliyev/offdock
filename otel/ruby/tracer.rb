# OffDock auto-tracer for Ruby — zero dependencies, fully offline.
#
# Loaded via: RUBYOPT=-r /otel/ruby/tracer.rb
# (Injected automatically by OffDock when OpenTelemetry is enabled in deploy settings)
#
# What it traces automatically:
#   - Outgoing HTTP/HTTPS calls via Net::HTTP (used by Faraday, httparty, open-uri, etc.)
#
# Sends spans to OffDock at POST /v1/span (no external collector needed).

require 'net/http'
require 'json'
require 'socket'
require 'uri'

module OffDockTracer
  _raw = (
    ENV['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ||
    ENV['OTEL_EXPORTER_OTLP_ENDPOINT'] ||
    'http://host.docker.internal:7070'
  ).chomp('/')
  _raw = _raw.chomp('/v1/traces')
  _uri = URI.parse(_raw + '/v1/span')

  SPAN_HOST = _uri.host || 'host.docker.internal'
  SPAN_PORT = _uri.port || 7070
  SPAN_PATH = _uri.path.empty? ? '/v1/span' : _uri.path
  SERVICE   = ENV.fetch('OTEL_SERVICE_NAME', 'ruby-service')

  def self.send_span(span)
    Thread.new do
      begin
        body = span.to_json
        s = TCPSocket.new(SPAN_HOST, SPAN_PORT)
        s.write(
          "POST #{SPAN_PATH} HTTP/1.0\r\n" \
          "Host: #{SPAN_HOST}\r\n" \
          "Content-Type: application/json\r\n" \
          "Content-Length: #{body.bytesize}\r\n" \
          "Connection: close\r\n\r\n" \
          "#{body}"
        )
        s.read(4096) rescue nil
        s.close
      rescue StandardError
        # Never crash the app due to tracing.
      end
    end
  end

  module HTTPPatch
    def request(req, body = nil, &block)
      # Don't trace calls to the OffDock span endpoint itself.
      return super if address == OffDockTracer::SPAN_HOST

      require 'securerandom'
      start_ms = (Time.now.to_f * 1000).to_i
      tid = SecureRandom.hex(16)
      sid = SecureRandom.hex(8)

      begin
        response = super
        status   = response.code.to_i
        ok       = status < 500
      rescue StandardError => e
        status = 0
        ok     = false
        raise
      ensure
        end_ms  = (Time.now.to_f * 1000).to_i
        scheme  = use_ssl? ? 'https' : 'http'
        url     = "#{scheme}://#{address}:#{port}#{req.path}"
        OffDockTracer.send_span(
          trace_id: tid,
          span_id:  sid,
          service:  OffDockTracer::SERVICE,
          name:     "#{req.method} #{url}",
          start_ms: start_ms,
          end_ms:   end_ms,
          status:   ok ? 'ok' : 'error',
          tags: {
            'http.method'      => req.method,
            'http.url'         => url,
            'http.status_code' => status.to_s,
          }
        )
      end
    end
  end
end

Net::HTTP.prepend(OffDockTracer::HTTPPatch)
