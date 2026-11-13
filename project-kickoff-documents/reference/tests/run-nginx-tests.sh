#!/usr/bin/env bash
# x1-validator-private-rpc: end-to-end test of the reference nginx setup.
#
# Runs the reference nginx.conf, the njs key check and the start wrapper
# against stand-ins for the rpc, with Let's Encrypt's Pebble test server as
# the certificate authority. Run it as root in a disposable Ubuntu 24.04
# machine or container, never on a validator. It adds one line to /etc/hosts.
#
# Needs: nginx, nginx-module-njs and nginx-module-acme from nginx.org;
# python3 with the websockets package; iproute2 (ss); curl; openssl;
# the Pebble binary and the test/certs folder of the Pebble repository.
#
# Usage: run-nginx-tests.sh PUBLIC_IP PEBBLE_BIN PEBBLE_CERTS_DIR
#   PUBLIC_IP must be a non-loopback ipv4 address on this machine.
set -u

PUBLIC_IP=${1:?usage: run-nginx-tests.sh PUBLIC_IP PEBBLE_BIN PEBBLE_CERTS_DIR}
PEBBLE_BIN=${2:?usage: run-nginx-tests.sh PUBLIC_IP PEBBLE_BIN PEBBLE_CERTS_DIR}
PEBBLE_CERTS=${3:?usage: run-nginx-tests.sh PUBLIC_IP PEBBLE_BIN PEBBLE_CERTS_DIR}
HERE=$(cd "$(dirname "$0")" && pwd)
REF=$(cd "$HERE/.." && pwd)
HOST=x1-rpc.example.com
WORK=$(mktemp -d /var/tmp/x1-rpc-test.XXXX)
STATE=$(mktemp -d /var/cache/nginx/acme-test.XXXX)
chmod 755 "$WORK"
mkdir -p "$WORK/logs" "$WORK/run" "$WORK/creds"
KEY=$(openssl rand -hex 32)
pass=0
fail=0

check() { # name, expected, actual
    if [ "$2" = "$3" ]; then
        pass=$((pass + 1)); printf 'ok    %s\n' "$1"
    else
        fail=$((fail + 1)); printf 'FAIL  %s: expected [%s], got [%s]\n' "$1" "$2" "$3"
    fi
}
req() { # curl options..., prints the status code; the body goes to $WORK/body
    curl -s --noproxy '*' --cacert "$WORK/pebble-roots.pem" \
        --resolve "$HOST:443:$PUBLIC_IP" -o "$WORK/body" -w '%{http_code}' "$@"
}
backend_path() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["path"])' "$WORK/body" 2>/dev/null; }
gate() { req "$@" "https://$HOST/x1-rpc-gate" >/dev/null; tr -d '\n' < "$WORK/body"; }
start_nginx() { env -i PATH=/usr/sbin:/usr/bin:/bin "$@" "$WORK/nginx-start"; sleep 1; }
stop_nginx() { [ -f "$WORK/nginx.pid" ] && kill -QUIT "$(cat "$WORK/nginx.pid")"; sleep 2; }
nginx_listeners() { ss -ltnupH | grep '"nginx"' | awk '{print $5}' | sort -u | tr '\n' ' ' | sed 's/ $//'; }
orders() { grep -c 'POST /order-plz' "$WORK/pebble.log"; }

grep -q " $HOST\$" /etc/hosts || echo "$PUBLIC_IP $HOST" >> /etc/hosts

# Render the reference files for this machine.
cp "$REF/nginx/x1-validator-private-rpc.js" "$WORK/"
sed -e "s|203.0.113.10|$PUBLIC_IP|g" \
    -e "s|/var/log/x1-validator-private-rpc/|$WORK/logs/|g" \
    -e "s|/etc/nginx/x1-validator-private-rpc/x1-validator-private-rpc.js|$WORK/x1-validator-private-rpc.js|" \
    -e "s|pid /run/nginx.pid;|pid $WORK/nginx.pid;|" \
    -e "s|uri https://acme-v02.api.letsencrypt.org/directory;|uri https://127.0.0.1:14000/dir;\n        ssl_trusted_certificate $PEBBLE_CERTS/pebble.minica.pem;|" \
    -e "s|state_path /var/cache/nginx/acme-letsencrypt;|state_path $STATE;|" \
    "$REF/nginx/nginx.conf" > "$WORK/nginx.conf"
printf '#!/bin/sh\n# stands in for "node cli.js decrypt-key --password-stdin": prints its input\ncat\n' > "$WORK/stub-node"
chmod 755 "$WORK/stub-node"
sed -e "s|__VALIDATOR_USER__|nobody|" -e "s|__NODE_BIN__|$WORK/stub-node|" -e "s|__TOOL_CLI__|cli.js|" \
    -e "s|__NGINX_CONF__|$WORK/nginx.conf|" -e "s|__KEY_HANDOFF__|$WORK/run/api-key|" \
    "$REF/systemd/nginx-start" > "$WORK/nginx-start"
chmod 755 "$WORK/nginx-start"
cat > "$WORK/pebble.json" <<EOF
{ "pebble": {
  "listenAddress": "127.0.0.1:14000", "managementListenAddress": "127.0.0.1:15000",
  "certificate": "$PEBBLE_CERTS/localhost/cert.pem", "privateKey": "$PEBBLE_CERTS/localhost/key.pem",
  "httpPort": 80, "tlsPort": 443, "ocspResponderURL": "", "externalAccountBindingRequired": false,
  "retryAfter": {"authz": 3, "order": 5}, "keyAlgorithm": "ecdsa",
  "profiles": {"default": {"description": "default", "validityPeriod": 7776000}} } }
EOF

check "nginx accepts the reference config" "0" "$(nginx -t -c "$WORK/nginx.conf" >/dev/null 2>&1; echo $?)"

env -i PATH=/usr/bin:/bin PEBBLE_VA_NOSLEEP=1 PEBBLE_WFE_NONCEREJECT=0 \
    "$PEBBLE_BIN" -config "$WORK/pebble.json" > "$WORK/pebble.log" 2>&1 &
PEBBLE_PID=$!
python3 "$HERE/rpc_standin.py" 8899 rpc "$WORK/backend.log" & RPC_PID=$!
python3 "$HERE/ws_standin.py" "$WORK/backend.log" & WS_PID=$!
sleep 2

# Start the way the unlock command does: the key in a hand-off file.
printf '%s\n' "$KEY" > "$WORK/run/api-key"
start_nginx
check "the wrapper deletes the hand-off file" "0" "$(find "$WORK/run" -type f | wc -l)"

issuer=""
for _ in $(seq 1 30); do
    issuer=$(openssl s_client -connect "$PUBLIC_IP:443" -servername "$HOST" </dev/null 2>/dev/null |
        openssl x509 -noout -issuer 2>/dev/null)
    case "$issuer" in *Pebble*) break ;; esac
    sleep 1
done
check "certificate issued through port 443 alone (tls-alpn-01)" "yes" "$(case "$issuer" in *Pebble*) echo yes ;; *) echo no ;; esac)"
{ curl -sk --noproxy '*' https://127.0.0.1:15000/roots/0; curl -sk --noproxy '*' https://127.0.0.1:15000/intermediates/0; } > "$WORK/pebble-roots.pem"

check "nginx listens only on the public address, port 443" "$PUBLIC_IP:443" "$(nginx_listeners)"
check "nothing listens on port 80" "0" "$(ss -ltnH | awk '{print $4}' | grep -c ':80$')"

check "no key: 403" "403" "$(req "https://$HOST/")"
check "wrong key: 403" "403" "$(req "https://$HOST/$(printf 'a%.0s' $(seq 1 64))")"
check "key with extra characters: 403" "403" "$(req "https://$HOST/${KEY}x")"
check "key: 200" "200" "$(req "https://$HOST/$KEY")"
check "key: forwarded as /" "/" "$(backend_path)"
check "key/health: forwarded as /health" "200 /health" "$(req "https://$HOST/$KEY/health") $(backend_path)"
check "query string kept" "200 /?a=1" "$(req "https://$HOST/$KEY?a=1") $(backend_path)"
check "json-rpc POST over http/2" "200 /" "$(req --http2 -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' "https://$HOST/$KEY") $(backend_path)"
check "websocket with key reaches 8900" 'echo:{"method":"slotSubscribe"}' \
    "$(python3 "$HERE/ws_client.py" "wss://$HOST/$KEY" "$PUBLIC_IP")"
check "websocket without key: 403" "yes" \
    "$(python3 "$HERE/ws_client.py" "wss://$HOST/nope" "$PUBLIC_IP" | grep -q 'HTTP 403' && echo yes || echo no)"
check "gate page from the server's own address" "unlocked" "$(gate)"
check "gate page from any other address: 403" "403" "$(req --interface 127.0.0.1 "https://$HOST/x1-rpc-gate")"

# Request bodies: 10 KB at most. Responses: streamed, never written to disk.
head -c 10240 /dev/zero | tr '\0' 'a' > "$WORK/body-10k"
head -c 10241 /dev/zero | tr '\0' 'a' > "$WORK/body-over-10k"
check "a 10 KB request body is forwarded" "200" "$(req -X POST --data-binary @"$WORK/body-10k" "https://$HOST/$KEY")"
seen=$(wc -l < "$WORK/backend.log")
check "a request body over 10 KB gets 413" "413" "$(req -X POST --data-binary @"$WORK/body-over-10k" "https://$HOST/$KEY")"
check "the rpc never sees that request" "$seen" "$(wc -l < "$WORK/backend.log")"
curl -s --noproxy '*' --cacert "$WORK/pebble-roots.pem" --resolve "$HOST:443:$PUBLIC_IP" --limit-rate 2M \
    -o /dev/null -w '%{size_download}' "https://$HOST/$KEY/big" > "$WORK/big-size" & BIG_PID=$!
sleep 3
spilled=0
for w in $(pgrep -P "$(cat "$WORK/nginx.pid")"); do
    for fd in /proc/"$w"/fd/*; do
        case "$(readlink "$fd")" in *proxy_temp*) spilled=$((spilled + 1)) ;; esac
    done
done
wait "$BIG_PID"
check "a 16 MB response to a slow client uses no temporary file" "0" "$spilled"
check "the whole 16 MB response arrives" "16777216" "$(cat "$WORK/big-size")"

kill -HUP "$(cat "$WORK/nginx.pid")"; sleep 1
check "reload keeps the key" "200" "$(req "https://$HOST/$KEY/health")"
old=$(cat "$WORK/nginx.pid"); kill -USR2 "$old"; sleep 2; kill -QUIT "$old"; sleep 2
check "binary upgrade keeps the key" "200" "$(req "https://$HOST/$KEY/health")"

stop_nginx
printf '%s' "$KEY" > "$WORK/creds/x1-validator-services-password"
start_nginx CREDENTIALS_DIRECTORY="$WORK/creds"
check "saved-password start unlocks" "unlocked" "$(gate)"
check "restart reuses the stored certificate" "1" "$(orders)"

kill "$RPC_PID" "$WS_PID"; sleep 1
check "rpc down: 502" "502" "$(req "https://$HOST/$KEY/health")"

stop_nginx
start_nginx
check "no key: starts locked" "locked" "$(gate)"
check "locked: keyed request gets 403" "403" "$(req "https://$HOST/$KEY/health")"
stop_nginx
kill "$PEBBLE_PID"; wait 2>/dev/null

check "the key appears in no log" "0" "$(grep -rc "$KEY" "$WORK/logs" | awk -F: '{s+=$2} END {print s+0}')"
check "the access log shows <key> instead" "yes" "$(grep -q '"/<key>/health"' "$WORK/logs/nginx-access.log" && echo yes || echo no)"

printf '\n%d passed, %d failed. Work folder: %s\n' "$pass" "$fail" "$WORK"
[ "$fail" -eq 0 ]
