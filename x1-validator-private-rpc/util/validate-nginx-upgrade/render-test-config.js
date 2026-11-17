/**
 * @file x1-validator-private-rpc/util/validate-nginx-upgrade/render-test-config.js
 * @description
 * Writes out the short-lived nginx configuration the upgrade check runs
 * with. It loads both modules, and checks each request's key the way the
 * real configuration does: the key check hashes the key, under the same
 * JavaScript engine, and nginx's map looks the hash up in a list it
 * includes. So the upgrade exercises the same parts. It listens on
 * 127.0.0.1 alone, never on the public address. It serves the gate page,
 * which says ok, and answers a request with a listed key with ok too, in
 * place of the rpc. Any other request gets a 403.
 */

import { GATE_PAGE_PATH } from "../../src/lib/gate-page.js";
import {
  MAP_HASH_BUCKET_SIZE,
  MAP_HASH_MAX_SIZE,
} from "../../src/lib/key-hash-map.js";

/**
 * Writes the test configuration.
 * @param {{port: number, njsModulePath: string, mapPath: string}} values
 *   The port on 127.0.0.1 to listen on, the installed key check, and the
 *   list of the keys' hashes.
 * @returns {string} The configuration's text.
 */
export function renderTestNginxConfig({ port, njsModulePath, mapPath }) {
  return `# x1-validator-private-rpc: the upgrade check's short-lived configuration.
# It listens on 127.0.0.1 alone, and answers ok to a request with a listed key.
user nginx;
worker_processes 1;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log notice;

load_module modules/ngx_http_js_module.so;
load_module modules/ngx_http_acme_module.so;

events {
    worker_connections 64;
}

http {
    access_log off;
    js_engine qjs;
    js_import x1rpc from ${njsModulePath};
    js_set $x1_rpc_key_hash x1rpc.keyHash;

    map_hash_bucket_size ${MAP_HASH_BUCKET_SIZE};
    map_hash_max_size ${MAP_HASH_MAX_SIZE};
    map $x1_rpc_key_hash $x1_rpc_key_ok {
        default 0;
        include ${mapPath};
    }

    server {
        listen 127.0.0.1:${port};

        location = ${GATE_PAGE_PATH} {
            allow 127.0.0.1;
            deny all;
            js_content x1rpc.gatePage;
        }

        location / {
            if ($x1_rpc_key_ok = 0) {
                return 403;
            }
            return 200 "ok\\n";
        }
    }
}
`;
}
