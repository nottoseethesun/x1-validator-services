/**
 * @file x1-validator-private-rpc/src/cli/render-nginx.js
 * @description
 * Writes nginx's main configuration for the private rpc: one worker at a
 * lower priority than the validator, listening on the public address
 * and port 443 alone, with a certificate from nginx's ACME module through
 * the tls-alpn-01 challenge, so port 80 stays closed. Every request goes
 * through the njs key check. Keyed requests go to the rpc, or to its
 * websocket port when they ask for an upgrade. The logs show `<key>` in
 * place of anything in a path that looks like a key, as the client sent
 * it, so a doubled slash or a mistyped key never writes the key there.
 * The keyed location logs critical errors alone, so an rpc outage never
 * writes a request line.
 *
 * The text is the hand-off's tested configuration, plus a rate limit on
 * keyed requests: one budget for the key, which requests without the key
 * never reach, since they get their 403 first. nginx logs a request over
 * the limit at its error level, which the keyed location doesn't write,
 * so the key stays out of the logs there too.
 * examples/nginx/nginx.conf.example records the text for the placeholder
 * hostname and address, with no acmeEmail. The size limits on the rpc
 * route are fixed text, not settings: request bodies of at most 10 KB,
 * held in memory, and no response ever written to a temporary file.
 */

import { API_KEY_HEX_DIGITS } from "../lib/api-key.js";
import { GATE_PAGE_PATH } from "../lib/gate-page.js";

/**
 * How many hex digits in a row the log mask takes for a key: half a
 * key's, so a key typed a character short or long is masked too.
 */
const MASKED_HEX_DIGITS = API_KEY_HEX_DIGITS / 2;

/**
 * @typedef {object} NginxValues
 * @property {string} hostname  The rpc's hostname.
 * @property {string} publicIp  The address nginx listens on.
 * @property {number} rpcPort  The validator's rpc port; its websocket
 *   port is the next one.
 * @property {string} resolver  The system's dns resolver.
 * @property {boolean} staging  Whether the certificate comes from Let's
 *   Encrypt's staging service.
 * @property {object} settings  The tool's settings: the paths, the ACME
 *   directories, the tunables and acmeEmail.
 */

/**
 * Writes one ACME issuer block.
 * @param {string} name  The issuer's name.
 * @param {string} uri  Its ACME directory.
 * @param {string} statePath  Where nginx keeps its account and
 *   certificate.
 * @param {string|undefined} email  The contact address, if any.
 * @returns {string}
 */
function issuer(name, uri, statePath, email) {
  const contact =
    email === undefined || email === null ? "" : `        contact ${email};\n`;
  return `    acme_issuer ${name} {
        uri ${uri};
        challenge tls-alpn-01;
        state_path ${statePath};
${contact}        accept_terms_of_service;
    }
`;
}

/**
 * Writes nginx's main configuration.
 * @param {NginxValues} values  What the configuration needs.
 * @returns {string} The configuration's text.
 */
export function renderNginxConfig(values) {
  const { hostname, publicIp, rpcPort, resolver, staging, settings } = values;
  const logDir = settings.nginxLogDir;
  const rate = settings.rateLimitRequestsPerSecond;
  const issuers =
    issuer(
      "letsencrypt",
      settings.acmeDirectoryUrl,
      settings.acmeStatePath,
      settings.acmeEmail,
    ) +
    (staging
      ? `\n${issuer(
          "letsencrypt-staging",
          settings.acmeStagingDirectoryUrl,
          settings.acmeStagingStatePath,
          settings.acmeEmail,
        )}`
      : "");
  return `# x1-validator-private-rpc: nginx for a private X1 validator rpc.
#
# Written by x1-validator-private-rpc. The nginx service starts it through the
# tool's start wrapper, which puts the api key in the environment. The
# packaged /etc/nginx/nginx.conf stays untouched and unused.
#
# For a manual setup, replace x1-rpc.example.com with your hostname (one
# place) and 203.0.113.10 with the validator's public ipv4 address (two places).

user nginx;
worker_processes 1;
worker_priority ${settings.nginxWorkerPriority};
pid /run/nginx.pid;
error_log ${logDir}/nginx-error.log notice;

load_module modules/ngx_http_js_module.so;
load_module modules/ngx_http_acme_module.so;

# Keep the api key that the start wrapper puts in the environment.
env X1_RPC_KEY;

events {
    worker_connections 1024;
}

http {
    server_tokens off;
    default_type application/octet-stream;

    # The system's dns resolver, used to find the certificate authority.
    resolver ${resolver} ipv6=off;

${issuers}
    js_import x1rpc from ${settings.njsModulePath};
    js_set $x1_rpc_path x1rpc.forwardPath;

    map $http_upgrade $x1_rpc_backend {
        websocket 127.0.0.1:${rpcPort + 1};
        default   127.0.0.1:${rpcPort};
    }

    map $http_upgrade $x1_rpc_connection {
        default upgrade;
        ''      close;
    }

    # Logs show <key> in place of anything that looks like a key, as the
    # client sent it: after any number of slashes, in either case, and
    # even a character short or long.
    map $request_uri $x1_rpc_logged_uri {
        "~^/+[0-9A-Fa-f]{${MASKED_HEX_DIGITS},}(?<rest>.*)$" "/<key>$rest";
        default $request_uri;
    }

    log_format x1_rpc '$time_iso8601 $remote_addr $request_method '
                      '"$x1_rpc_logged_uri" $status $body_bytes_sent $request_time';

    # One budget for the key's requests, refilled ${rate} times a second.
    limit_req_zone $server_name zone=x1_rpc:1m rate=${rate}r/s;

    server {
        listen ${publicIp}:443 ssl;
        http2 on;
        server_name ${hostname};

        acme_certificate ${staging ? "letsencrypt-staging" : "letsencrypt"};
        ssl_certificate $acme_certificate;
        ssl_certificate_key $acme_certificate_key;
        ssl_certificate_cache max=2;

        access_log ${logDir}/nginx-access.log x1_rpc;

        # Local-only page: says whether nginx holds a usable key.
        location = ${GATE_PAGE_PATH} {
            allow ${publicIp};
            deny all;
            access_log off;
            js_content x1rpc.gatePage;
        }

        location / {
            # Critical errors only, so an rpc outage never logs a request.
            error_log ${logDir}/nginx-error-keyed.log crit;
            # Request bodies of at most 10 KB, held in memory; larger gets 413.
            client_max_body_size 10k;
            client_body_buffer_size 10k;
            # ${rate} keyed requests a second, plus a burst of ${rate} more; the rest get 429.
            limit_req zone=x1_rpc burst=${rate} nodelay;
            limit_req_status 429;
            if ($x1_rpc_path = "") {
                return 403;
            }
            rewrite ^ $x1_rpc_path break;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $x1_rpc_connection;
            proxy_read_timeout ${settings.websocketIdleTimeoutSeconds}s;
            # Never write a response to a temporary file on disk.
            proxy_max_temp_file_size 0;
            proxy_pass http://$x1_rpc_backend;
        }
    }
}
`;
}
