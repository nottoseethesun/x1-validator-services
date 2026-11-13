#!/usr/bin/env bash
# x1-validator-private-rpc: assemble the folder that systemd-tests-1.sh and
# systemd-tests-2.sh expect at /root/payload inside the test VM.
#
# Usage: make-vm-payload.sh OUT_DIR DEB_DIR NODE_TARBALL PEBBLE_BIN PEBBLE_CERTS_DIR
#   DEB_DIR      nginx.org's nginx, nginx-module-njs and nginx-module-acme .deb files
#   NODE_TARBALL node-v20.0.0-linux-x64.tar.xz from nodejs.org, checksum checked
#   PEBBLE_BIN   the Pebble binary; PEBBLE_CERTS_DIR its repository's test/certs
set -eu
OUT=$1 DEBS=$2 NODE_TARBALL=$3 PEBBLE_BIN=$4 PEBBLE_CERTS=$5
REF=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$OUT/debs" "$OUT/pebble" "$OUT/cli" "$OUT/reference"
cp "$DEBS"/*.deb "$OUT/debs/"
cp "$NODE_TARBALL" "$OUT/node-v20.0.0-linux-x64.tar.xz"
cp "$PEBBLE_BIN" "$OUT/pebble/pebble"
cp -r "$PEBBLE_CERTS" "$OUT/pebble/certs"
cp "$REF/tests/cli.js" "$REF/tests/package.json" "$OUT/cli/"
cp "$REF/tests/rpc_standin.py" "$REF/tests/common.sh" "$REF/tests/systemd-tests-1.sh" "$REF/tests/systemd-tests-2.sh" "$OUT/"
cp "$REF/nginx/nginx.conf" "$REF/nginx/x1-validator-private-rpc.js" "$OUT/reference/"
cp "$REF/systemd/nginx-start" "$REF/systemd/x1-validator-private-rpc.conf" "$OUT/reference/"
cp "$REF/logrotate/x1-validator-private-rpc" "$OUT/reference/logrotate-x1-validator-private-rpc"
echo "payload ready in $OUT; copy it to /root/payload in the VM"
