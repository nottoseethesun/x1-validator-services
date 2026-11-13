# x1-validator-private-rpc: shared settings and helpers for the systemd tests.
# Sourced by systemd-tests-1.sh and systemd-tests-2.sh, inside the test VM.

PAY=/root/payload
PUBLIC_IP=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
HOST=x1-rpc.example.com
VUSER=validator
NODE_DIR=/home/$VUSER/.nvm/versions/node/v20.0.0
NODE=$NODE_DIR/bin/node
CLI=/home/$VUSER/x1-validator-private-rpc/src/cli.js
VAULT=/home/$VUSER/.config/x1-validator-services/vault.json
CONF_DIR=/etc/nginx/x1-validator-private-rpc
CONF=$CONF_DIR/nginx.conf
WRAPPER=/usr/local/libexec/x1-validator-private-rpc/nginx-start
DROPIN=/etc/systemd/system/nginx.service.d/x1-validator-private-rpc.conf
CRED=/etc/credstore.encrypted/x1-validator-services-password
HANDOFF=/run/x1-validator-private-rpc/api-key
LOGS=/var/log/x1-validator-private-rpc
STATE=/root/x1-test-state
PASSWORD='correct horse battery staple'
pass=0
fail=0

check() { # name, expected, actual
    if [ "$2" = "$3" ]; then
        pass=$((pass + 1)); printf 'ok    %s\n' "$1"
    else
        fail=$((fail + 1)); printf 'FAIL  %s: expected [%s], got [%s]\n' "$1" "$2" "$3"
    fi
}
yes_no() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
gate() { curl -sk --max-time 20 --resolve "$HOST:443:$PUBLIC_IP" "https://$HOST/x1-rpc-gate" | tr -d '\n'; }
keyed() { curl -sk --max-time 20 -o /dev/null -w '%{http_code}' --resolve "$HOST:443:$PUBLIC_IP" "https://$HOST/$KEY/health"; }
issuer() { openssl s_client -connect "$PUBLIC_IP:443" -servername "$HOST" </dev/null 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null; }
nginx_listeners() { ss -ltnpH | grep '"nginx"' | awk '{print $4}' | sort -u | tr '\n' ' ' | sed 's/ $//'; }
settle() { # wait until nginx's state stops changing
    for _ in $(seq 1 180); do
        case "$(systemctl is-active nginx)" in activating|deactivating|reloading) sleep 1 ;; *) break ;; esac
    done
    sleep 2
}
wait_cert() {
    for _ in $(seq 1 120); do
        case "$(issuer)" in *Pebble*) return 0 ;; esac
        sleep 1
    done
    return 1
}
summary() { printf '\n%d passed, %d failed\n' "$pass" "$fail"; }
