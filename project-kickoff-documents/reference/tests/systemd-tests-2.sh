#!/usr/bin/env bash
# x1-validator-private-rpc: systemd tests, part 2 of 2 (after a reboot).
# Run as root in the same VM, after systemd-tests-1.sh and a reboot.
set -u
. /root/payload/common.sh
. "$STATE"

echo "== after the reboot"
settle
check "nginx started at boot" "active" "$(systemctl is-active nginx)"
check "boot with the saved password: unlocked" "unlocked" "$(gate)"
check "the stored certificate came back" "yes" "$(issuer | grep -q Pebble && echo yes || echo no)"
echo "nginx start at boot: $(systemd-analyze blame --no-pager 2>/dev/null | grep -m1 'nginx.service' | sed 's/^ *//')"

echo "== a wrong saved password"
printf '%s' 'not the password' | systemd-creds encrypt --name=x1-validator-services-password - "$CRED"
systemctl restart nginx; settle
check "wrong saved password: nginx runs locked" "active locked" "$(systemctl is-active nginx) $(gate)"
check "the decrypt step's error reaches the journal" "yes" \
    "$(yes_no journalctl -u nginx --no-pager -q --grep 'wrong password or damaged vault')"

echo "== unlock wins over a failing saved password"
install -d -m 0700 /run/x1-validator-private-rpc
(umask 077; printf '%s' "$KEY" > "$HANDOFF")
systemctl restart nginx; settle
check "the hand-off file unlocks nginx" "unlocked" "$(gate)"

echo "== forget the password"
rm -f "$CRED"
systemctl restart nginx; settle
check "a drop-in naming a missing credential stops nginx from starting" "failed" "$(systemctl is-active nginx)"
grep -v '^LoadCredentialEncrypted=' "$PAY/reference/x1-validator-private-rpc.conf" > "$DROPIN"
systemctl daemon-reload
systemctl reset-failed nginx
systemctl start nginx; settle
check "without the credential line, nginx starts locked" "active locked" "$(systemctl is-active nginx) $(gate)"

summary
