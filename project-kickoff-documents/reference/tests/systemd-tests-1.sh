#!/usr/bin/env bash
# x1-validator-private-rpc: systemd tests, part 1 of 2 (before a reboot).
#
# Run as root inside a disposable Ubuntu 24.04 VM with systemd, never on a
# validator. Expects the payload at /root/payload: nginx.org's three .deb
# files, Node.js 20.0.0's tarball, Pebble and its test certificates, the
# reference files, the rpc stand-in and the decrypt stand-in (cli/).
set -u
. /root/payload/common.sh
KEY=$(openssl rand -hex 32)
printf 'KEY=%s\n' "$KEY" > "$STATE"
grep -q " $HOST\$" /etc/hosts || echo "$PUBLIC_IP $HOST" >> /etc/hosts
echo "public address: $PUBLIC_IP"

echo "== install nginx with the service masked"
systemctl mask nginx >/dev/null 2>&1
dpkg -i "$PAY"/debs/*.deb > /root/dpkg.log 2>&1
check "the three packages are installed" "3" "$(dpkg -l nginx nginx-module-njs nginx-module-acme 2>/dev/null | grep -c '^ii')"
check "the mask survives the install" "masked" "$(systemctl is-enabled nginx 2>&1)"
check "nginx did not start" "inactive" "$(systemctl is-active nginx)"
check "no nginx process exists" "no" "$(yes_no pgrep -x nginx)"
check "nothing listens on port 80" "0" "$(ss -ltnH | awk '{print $4}' | grep -c ':80$')"

echo "== the validator's account, Node.js 20.0.0 and the vault"
id "$VUSER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$VUSER"
mkdir -p "$NODE_DIR" "$(dirname "$CLI")"
tar xJf "$PAY/node-v20.0.0-linux-x64.tar.xz" -C "$NODE_DIR" --strip-components=1
cp "$PAY/cli/cli.js" "$PAY/cli/package.json" "$(dirname "$CLI")/"
chown -R "$VUSER:$VUSER" "/home/$VUSER"
chmod 750 "/home/$VUSER"
printf '%s\n%s' "$PASSWORD" "$KEY" | runuser -u "$VUSER" -- "$NODE" "$CLI" make-vault
check "Node.js version" "v20.0.0" "$("$NODE" -v)"
check "the vault has mode 600" "600" "$(stat -c %a "$VAULT")"
check "the vault holds no plaintext key" "0" "$(grep -c "$KEY" "$VAULT")"

echo "== Pebble and the rpc stand-in"
cat > /root/pebble.json <<EOF
{ "pebble": {
  "listenAddress": "127.0.0.1:14000", "managementListenAddress": "127.0.0.1:15000",
  "certificate": "$PAY/pebble/certs/localhost/cert.pem", "privateKey": "$PAY/pebble/certs/localhost/key.pem",
  "httpPort": 80, "tlsPort": 443, "ocspResponderURL": "", "externalAccountBindingRequired": false,
  "retryAfter": {"authz": 3, "order": 5}, "keyAlgorithm": "ecdsa",
  "profiles": {"default": {"description": "default", "validityPeriod": 7776000}} } }
EOF
systemd-run -q --unit=pebble-test --setenv=PEBBLE_VA_NOSLEEP=1 --setenv=PEBBLE_WFE_NONCEREJECT=0 \
    "$PAY/pebble/pebble" -config /root/pebble.json
systemd-run -q --unit=rpc-standin python3 "$PAY/rpc_standin.py" 8899 rpc /root/backend.log
sleep 3

echo "== the tool's files"
install -d "$CONF_DIR" /usr/local/libexec/x1-validator-private-rpc "$(dirname "$DROPIN")" "$LOGS"
cp "$PAY/reference/x1-validator-private-rpc.js" "$CONF_DIR/"
sed -e "s|203.0.113.10|$PUBLIC_IP|g" \
    -e "s|uri https://acme-v02.api.letsencrypt.org/directory;|uri https://127.0.0.1:14000/dir;\n        ssl_trusted_certificate $PAY/pebble/certs/pebble.minica.pem;|" \
    "$PAY/reference/nginx.conf" > "$CONF"
sed -e "s|__VALIDATOR_USER__|$VUSER|" -e "s|__NODE_BIN__|$NODE|" -e "s|__TOOL_CLI__|$CLI|" \
    -e "s|__NGINX_CONF__|$CONF|" -e "s|__KEY_HANDOFF__|$HANDOFF|" \
    "$PAY/reference/nginx-start" > "$WRAPPER"
chmod 755 "$WRAPPER"
grep -v '^LoadCredentialEncrypted=' "$PAY/reference/x1-validator-private-rpc.conf" > "$DROPIN"
cp "$PAY/reference/logrotate-x1-validator-private-rpc" /etc/logrotate.d/x1-validator-private-rpc
systemctl daemon-reload
check "nginx -t accepts the configuration" "0" "$(nginx -t -c "$CONF" >/dev/null 2>&1; echo $?)"
check "systemd starts nginx through the wrapper" "1" "$(systemctl show -p ExecStart nginx | grep -c nginx-start)"
systemctl unmask nginx >/dev/null 2>&1
systemd-analyze verify nginx.service > /root/verify.log 2>&1
check "systemd-analyze verify finds nothing" "0" "$(wc -l < /root/verify.log)"
systemctl enable nginx >/dev/null 2>&1
check "nginx is enabled for boot" "enabled" "$(systemctl is-enabled nginx)"

echo "== unlock through the hand-off file"
install -d -m 0700 /run/x1-validator-private-rpc
(umask 077; printf '%s' "$KEY" > "$HANDOFF")
systemctl start nginx; settle
check "nginx is active" "active" "$(systemctl is-active nginx)"
check "the wrapper deleted the hand-off file" "no" "$(yes_no test -e "$HANDOFF")"
check "certificate issued through port 443 alone" "yes" "$(yes_no wait_cert)"
check "gate after unlock" "unlocked" "$(gate)"
check "keyed request" "200" "$(keyed)"
check "nginx listens only on the public address" "$PUBLIC_IP:443" "$(nginx_listeners)"
check "nothing listens on port 80" "0" "$(ss -ltnH | awk '{print $4}' | grep -c ':80$')"

echo "== reload and restart"
systemctl reload nginx; settle
check "systemctl reload keeps the key" "unlocked" "$(gate)"
systemctl restart nginx; settle
check "a restart with no key or saved password starts locked" "locked" "$(gate)"
check "nginx is still active while locked" "active" "$(systemctl is-active nginx)"
check "the journal says why" "yes" "$(yes_no journalctl -u nginx --no-pager -q --grep 'no usable api key')"
check "locked: the keyed request gets 403" "403" "$(keyed)"

echo "== save the password with systemd-creds"
install -d -m 0700 /etc/credstore.encrypted
printf '%s' "$PASSWORD" | systemd-creds encrypt --name=x1-validator-services-password - "$CRED"
echo "credential file: $(stat -c '%a %U' "$CRED"), $(stat -c %s "$CRED") bytes"
check "the credential file holds no plaintext password" "0" "$(grep -ac "$PASSWORD" "$CRED")"
cp "$PAY/reference/x1-validator-private-rpc.conf" "$DROPIN"
systemctl daemon-reload
start=$(date +%s); systemctl restart nginx; settle; end=$(date +%s)
echo "restart with decryption: $((end - start)) s, under full emulation without kvm"
check "saved password: unlocked" "unlocked" "$(gate)"
check "keyed request" "200" "$(keyed)"
check "the credentials folder lives in memory" "yes" \
    "$(yes_no sh -c 'findmnt -no FSTYPE /run/credentials/nginx.service | grep -Eq "ramfs|tmpfs"')"
check "the validator's account cannot read the saved password" "no" \
    "$(yes_no runuser -u "$VUSER" -- cat /run/credentials/nginx.service/x1-validator-services-password)"
check "the password is in no journal" "0" "$(journalctl --no-pager -q | grep -c "$PASSWORD")"
check "the key is in no journal" "0" "$(journalctl --no-pager -q | grep -c "$KEY")"

echo "== log rotation"
for _ in 1 2 3; do keyed >/dev/null; done
logrotate -f /etc/logrotate.d/x1-validator-private-rpc
check "logrotate rotated the access log" "yes" "$(yes_no test -e "$LOGS/nginx-access.log.1")"
keyed >/dev/null; sleep 1
check "nginx writes to the new access log" "yes" "$(yes_no test -s "$LOGS/nginx-access.log")"
check "no log holds the key" "0" "$(cat "$LOGS"/* 2>/dev/null | grep -c "$KEY")"

summary
