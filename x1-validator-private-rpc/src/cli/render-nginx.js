/**
 * @file x1-validator-private-rpc/src/cli/render-nginx.js
 * @description
 * Writes nginx's main configuration for the private rpc: one worker at a
 * lower priority than the validator, listening on the public address
 * and port 443 alone, with a certificate from nginx's ACME module through
 * the tls-alpn-01 challenge, so port 80 stays closed. Every request goes
 * through the njs key check, which hashes the key at the start of the
 * path, and nginx's map looks the hash up in nginx's list of hashes,
 * which it includes. A request whose hash isn't there gets a 403. Keyed
 * requests go to the rpc, or to its websocket port when they ask for an
 * upgrade. The logs show `<key>` in place of anything in the url that
 * looks like a key, wherever the client put it, so a key in the query
 * string or after a prefix, or a mistyped one, never writes the key
 * there. The njs module does the masking. The keyed location writes no
 * error log at all, since each of nginx's error lines carries the request
 * line, and with it the key.
 *
 * The text grew from the hand-off's tested configuration. It adds the
 * hash lookup and its table sizes, and a rate limit on keyed requests:
 * one budget that every key shares. Requests without a key never reach
 * it, since they get their 403 first. nginx logs a request over the
 * limit as an error, which the keyed location doesn't write, so the key
 * stays out of the logs there too. It also adds a time limit on the old
 * worker after a reload, which closes a removed key's open websocket, and
 * a shorter one for a new connection to send its request's header.
 * docs/architecture.md says why both are needed.
 *
 * examples/nginx/nginx.conf.example records the text for the placeholder
 * hostname and address, with no acmeEmail. These limits are fixed text,
 * not settings: request bodies of at most 10 KB in the keyed location, held
 * in memory, no response ever written to a temporary file, and the two
 * time limits.
 */

import { GATE_PAGE_PATH } from "../lib/gate-page.js";
import {
  MAP_HASH_BUCKET_SIZE,
  MAP_HASH_MAX_SIZE,
} from "../lib/key-hash-map.js";

/**
 * How long the old worker may keep what's still open after a reload,
 * websockets included, before nginx closes it.
 */
export const WORKER_SHUTDOWN_TIMEOUT_SECONDS = 10;

/**
 * How long a connection has, from its opening, to finish its tls
 * handshake and send its request's header, where nginx's default is 60.
 */
export const REQUEST_HEADER_TIMEOUT_SECONDS = 5;

/**
 * @typedef {object} NginxValues
 * @property {string} hostname  The rpc's hostname.
 * @property {string} publicIp  The address nginx listens on.
 * @property {number} rpcPort  The validator's rpc port. Its websocket
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
    (staging === true
      ? `\n${issuer(
          "letsencrypt-staging",
          settings.acmeStagingDirectoryUrl,
          settings.acmeStagingStatePath,
          settings.acmeEmail,
        )}`
      : "");
  return `# x1-validator-private-rpc: nginx for a private X1 validator rpc.
#
# Written by x1-validator-private-rpc. The nginx service starts nginx with
# this configuration, through the tool's systemd drop-in. The packaged
# /etc/nginx/nginx.conf stays untouched and unused.
#
# For a manual setup, replace x1-rpc.example.com with your hostname (one
# place) and 203.0.113.10 with the validator's public ipv4 address (two places).

user nginx;
worker_processes 1;
worker_priority ${settings.nginxWorkerPriority};
pid /run/nginx.pid;
error_log ${logDir}/nginx-error.log notice;

# After a reload, the old worker closes what it still holds open within
# ${WORKER_SHUTDOWN_TIMEOUT_SECONDS} seconds. A websocket's key is checked only when it opens, so this
# is what ends a removed key's websocket. Its client reconnects, and
# meets the new list.
worker_shutdown_timeout ${WORKER_SHUTDOWN_TIMEOUT_SECONDS}s;

load_module modules/ngx_http_js_module.so;
load_module modules/ngx_http_acme_module.so;

events {
    worker_connections 1024;
}

http {
    server_tokens off;
    default_type application/octet-stream;

    # A connection has ${REQUEST_HEADER_TIMEOUT_SECONDS} seconds from its opening to finish its tls
    # handshake and send its request's header, and each later request on
    # it has ${REQUEST_HEADER_TIMEOUT_SECONDS} seconds of its own. That stops only the crudest way to fill
    # nginx's connections, as the tool's docs/architecture.md explains.
    client_header_timeout ${REQUEST_HEADER_TIMEOUT_SECONDS}s;

    # The system's dns resolver, used to find the certificate authority.
    resolver ${resolver} ipv6=off;

${issuers}
    js_engine qjs;
    js_import x1rpc from ${settings.njsModulePath};
    js_set $x1_rpc_key_hash x1rpc.keyHash;
    js_set $x1_rpc_path x1rpc.forwardPath;
    # The url the access log shows: <key> in place of anything that looks
    # like a key, wherever the client put it, in either case, and even a
    # character short or long.
    js_set $x1_rpc_logged_uri x1rpc.loggedUri;

    # Buckets big enough for 64-character hashes, so the list's table
    # builds at once for any number of keys the tool allows.
    map_hash_bucket_size ${MAP_HASH_BUCKET_SIZE};
    map_hash_max_size ${MAP_HASH_MAX_SIZE};

    # 1 when the key's hash is in nginx's list, 0 otherwise.
    map $x1_rpc_key_hash $x1_rpc_key_ok {
        default 0;
        include ${settings.hashedApiKeysMapPath};
    }

    map $http_upgrade $x1_rpc_backend {
        websocket 127.0.0.1:${rpcPort + 1};
        default   127.0.0.1:${rpcPort};
    }

    map $http_upgrade $x1_rpc_connection {
        default upgrade;
        ''      close;
    }

    log_format x1_rpc '$time_iso8601 $remote_addr $request_method '
                      '"$x1_rpc_logged_uri" $status $body_bytes_sent $request_time';

    # One budget that every key's requests share, refilled ${rate} times a second.
    limit_req_zone $server_name zone=x1_rpc:1m rate=${rate}r/s;

    server {
        listen ${publicIp}:443 ssl;
        http2 on;
        server_name ${hostname};

        acme_certificate ${staging === true ? "letsencrypt-staging" : "letsencrypt"};
        ssl_certificate $acme_certificate;
        ssl_certificate_key $acme_certificate_key;
        ssl_certificate_cache max=2;

        access_log ${logDir}/nginx-access.log x1_rpc;

        # Local-only page: says ok, so the tool knows nginx answers.
        location = ${GATE_PAGE_PATH} {
            allow ${publicIp};
            deny all;
            access_log off;
            js_content x1rpc.gatePage;
        }

        location / {
            # No error log: nginx's error lines carry the request line, key and all.
            error_log /dev/null;
            # Request bodies of at most 10 KB, held in memory. A larger one gets 413.
            client_max_body_size 10k;
            client_body_buffer_size 10k;
            # ${rate} keyed requests a second, plus a burst of ${rate} more. The rest get 429.
            limit_req zone=x1_rpc burst=${rate} nodelay;
            limit_req_status 429;
            if ($x1_rpc_key_ok = 0) {
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
