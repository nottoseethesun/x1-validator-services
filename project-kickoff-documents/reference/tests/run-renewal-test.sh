#!/usr/bin/env bash
# x1-validator-private-rpc: certificate renewal test for the reference setup.
#
# Has Pebble issue certificates that live LIFETIME seconds, then watches nginx
# for WATCH seconds. Passes when nginx renews more than once, every renewal
# comes before the previous certificate expires, nginx never restarts, and
# the stored certificate is the one being served. Run it as root in a
# disposable machine or container, never on a validator. It adds one line to
# /etc/hosts. Needs the same packages as run-nginx-tests.sh.
#
# Usage: run-renewal-test.sh PUBLIC_IP PEBBLE_BIN PEBBLE_CERTS_DIR [LIFETIME] [WATCH]
#   LIFETIME defaults to 120 seconds, WATCH to four lifetimes.
set -u

PUBLIC_IP=${1:?usage: run-renewal-test.sh PUBLIC_IP PEBBLE_BIN PEBBLE_CERTS_DIR [LIFETIME] [WATCH]}
PEBBLE_BIN=${2:?usage: run-renewal-test.sh PUBLIC_IP PEBBLE_BIN PEBBLE_CERTS_DIR [LIFETIME] [WATCH]}
PEBBLE_CERTS=${3:?usage: run-renewal-test.sh PUBLIC_IP PEBBLE_BIN PEBBLE_CERTS_DIR [LIFETIME] [WATCH]}
LIFETIME=${4:-120}
WATCH=${5:-$((LIFETIME * 4))}
HERE=$(cd "$(dirname "$0")" && pwd)
REF=$(cd "$HERE/.." && pwd)
HOST=x1-rpc.example.com
WORK=$(mktemp -d /var/tmp/x1-rpc-renewal.XXXX)
STATE=$(mktemp -d /var/cache/nginx/acme-renewal.XXXX)
chmod 755 "$WORK"
mkdir -p "$WORK/logs"
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
serial() {
    openssl s_client -connect "$PUBLIC_IP:443" -servername "$HOST" </dev/null 2>/dev/null |
        openssl x509 -noout -serial 2>/dev/null
}

grep -q " $HOST\$" /etc/hosts || echo "$PUBLIC_IP $HOST" >> /etc/hosts
cp "$REF/nginx/x1-validator-private-rpc.js" "$WORK/"
sed -e "s|203.0.113.10|$PUBLIC_IP|g" \
    -e "s|/var/log/x1-validator-private-rpc/|$WORK/logs/|g" \
    -e "s|/etc/nginx/x1-validator-private-rpc/x1-validator-private-rpc.js|$WORK/x1-validator-private-rpc.js|" \
    -e "s|pid /run/nginx.pid;|pid $WORK/nginx.pid;|" \
    -e "s|nginx-error.log notice;|nginx-error.log info;|" \
    -e "s|uri https://acme-v02.api.letsencrypt.org/directory;|uri https://127.0.0.1:14000/dir;\n        ssl_trusted_certificate $PEBBLE_CERTS/pebble.minica.pem;|" \
    -e "s|state_path /var/cache/nginx/acme-letsencrypt;|state_path $STATE;|" \
    "$REF/nginx/nginx.conf" > "$WORK/nginx.conf"
cat > "$WORK/pebble.json" <<EOF
{ "pebble": {
  "listenAddress": "127.0.0.1:14000", "managementListenAddress": "127.0.0.1:15000",
  "certificate": "$PEBBLE_CERTS/localhost/cert.pem", "privateKey": "$PEBBLE_CERTS/localhost/key.pem",
  "httpPort": 80, "tlsPort": 443, "ocspResponderURL": "", "externalAccountBindingRequired": false,
  "retryAfter": {"authz": 3, "order": 5}, "keyAlgorithm": "ecdsa",
  "profiles": {"default": {"description": "short-lived", "validityPeriod": $LIFETIME}} } }
EOF

env -i PATH=/usr/bin:/bin PEBBLE_VA_NOSLEEP=1 PEBBLE_WFE_NONCEREJECT=0 \
    "$PEBBLE_BIN" -config "$WORK/pebble.json" > "$WORK/pebble.log" 2>&1 &
PEBBLE_PID=$!
sleep 2
env -i PATH=/usr/sbin:/usr/bin:/bin X1_RPC_KEY="$KEY" /usr/sbin/nginx -c "$WORK/nginx.conf"
sleep 1
MASTER=$(cat "$WORK/nginx.pid")
printf 'watching for %s s; certificates live %s s\n' "$WATCH" "$LIFETIME"

serials=""
end=$(($(date +%s) + WATCH))
while [ "$(date +%s)" -lt "$end" ]; do
    s=$(serial)
    case " $serials " in *" $s "*) ;; *) [ -n "$s" ] && serials="$serials $s" ;; esac
    sleep 3
done

check "nginx renewed more than once" "yes" "$([ "$(echo $serials | wc -w)" -ge 3 ] && echo yes || echo no)"
longest=$(grep 'certificate issued' "$WORK/logs/nginx-error.log" | awk '{print $2}' | python3 -c '
import sys
from datetime import datetime
ts = [datetime.strptime(l.strip(), "%H:%M:%S") for l in sys.stdin if l.strip()]
print(max([(b - a).seconds for a, b in zip(ts, ts[1:])] or [0]))')
check "every renewal came before the previous certificate expired" "yes" \
    "$([ "$longest" -lt "$LIFETIME" ] && echo yes || echo no)"
check "nginx never restarted" "$MASTER" "$(cat "$WORK/nginx.pid")"
check "the gate stayed unlocked" "unlocked" \
    "$(curl -sk --noproxy '*' --resolve "$HOST:443:$PUBLIC_IP" "https://$HOST/x1-rpc-gate" | tr -d '\n')"
check "the stored certificate is the one served" "$(serial)" \
    "$(openssl x509 -in "$(ls "$STATE"/*.crt | head -1)" -noout -serial)"

/usr/sbin/nginx -c "$WORK/nginx.conf" -s quit
kill "$PEBBLE_PID"; wait 2>/dev/null
printf '\n%d passed, %d failed. Certificates seen: %s. Work folder: %s\n' \
    "$pass" "$fail" "$(echo $serials | wc -w)" "$WORK"
[ "$fail" -eq 0 ]
