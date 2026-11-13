/**
 * @file x1-validator-private-rpc/util/validate-nginx-upgrade/render-test-config.js
 * @description
 * Writes out the short-lived nginx configuration the upgrade check runs
 * with. It loads both modules and keeps the api key in nginx's
 * environment, as the real configuration does, so the upgrade exercises
 * the same parts. It listens on 127.0.0.1 alone, never on the public
 * address, and serves only the gate page, which says whether nginx holds
 * a usable key.
 */

/**
 * Writes the test configuration.
 * @param {{port: number, njsModulePath: string}} values  The port on
 *   127.0.0.1 to listen on, and the installed key check.
 * @returns {string} The configuration's text.
 */
export function renderTestNginxConfig({ port, njsModulePath }) {
  return `# x1-validator-private-rpc: the upgrade check's short-lived configuration.
# It listens on 127.0.0.1 alone and serves only the gate page.
user nginx;
worker_processes 1;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log notice;

load_module modules/ngx_http_js_module.so;
load_module modules/ngx_http_acme_module.so;

env X1_RPC_KEY;

events {
    worker_connections 64;
}

http {
    access_log off;
    js_import x1rpc from ${njsModulePath};

    server {
        listen 127.0.0.1:${port};

        location = /x1-rpc-gate {
            allow 127.0.0.1;
            deny all;
            js_content x1rpc.gatePage;
        }

        location / {
            return 404;
        }
    }
}
`;
}
