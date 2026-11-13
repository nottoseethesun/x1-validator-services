# Reference Files for the Hand-off

These files come with `x1-validator-private-rpc-handoff.md`. They are the exact configuration, key check, start wrapper and logrotate rule that passed the tests below. The project's renderers must produce the same text for the placeholder values, with no `acmeEmail`, and its tests must cover the same behavior.

## Contents

| File | Becomes in the project | Tested |
| --- | --- | --- |
| `nginx/nginx.conf` | The output of the nginx config renderer, and `examples/nginx/nginx.conf.example` | Yes |
| `nginx/x1-validator-private-rpc.js` | The njs key check, shipped as is | Yes, in nginx and under Node.js |
| `systemd/nginx-start` | The start wrapper template; the tool fills in the five `__NAME__` values | Yes, under systemd 255 |
| `systemd/x1-validator-private-rpc.conf` | The systemd drop-in for `nginx.service` | Yes, under systemd 255 |
| `logrotate/x1-validator-private-rpc` | The logrotate rule, and its example | Yes, under systemd 255 |
| `tests/run-nginx-tests.sh` | The end-to-end suite, to be ported to `node:test` | 31 checks |
| `tests/run-renewal-test.sh` | The renewal test, to be ported to `node:test` | 5 checks |
| `tests/systemd-tests-1.sh`, `tests/systemd-tests-2.sh`, `tests/common.sh` | The systemd suite, to be ported to `node:test` | 42 checks |
| `tests/make-vm-payload.sh` | A helper that assembles what the systemd suite needs | Used for the test run |
| `tests/cli.js`, `tests/package.json` | A stand-in for the tool's `decrypt-key` command, with LP Ranger's encryption scheme | Used by the systemd suite |
| `tests/rpc_standin.py`, `tests/ws_standin.py`, `tests/ws_client.py` | Stand-ins for Tachyon's rpc and websocket servers, to be ported to Node.js | Used by the suites |

## What Was Tested

The tests ran on 2026-11-11 with nginx 1.30.6, nginx-module-njs 1.0.2 and nginx-module-acme 0.4.2, all from nginx.org's apt repository. Pebble 2.10.3, Let's Encrypt's test certificate authority, issued the certificates, with its `tlsPort` set to 443.

- `run-nginx-tests.sh` and `run-renewal-test.sh` ran in a disposable Ubuntu 24.04 container, as root. All their checks passed.
- The systemd suite ran in an Ubuntu 24.04 virtual machine with systemd 255, made from Ubuntu's own cloud image, under full emulation. Part 1 ran on a fresh machine and part 2 after a reboot. All 42 checks passed.
- All three suites ran again from this folder's final files, the systemd suite on a new virtual machine, and passed again.

Together they cover:

- the certificate, issued through port 443 alone, with nothing listening on port 80;
- renewal, before each certificate expires and without a restart;
- nginx listening on the public address only;
- the key check, for http/1.1, http/2 and websockets;
- request bodies of at most 10 KB, held in memory, and responses streamed to the client, never written to disk;
- the local-only gate page;
- reloads and binary upgrades, which keep the key;
- the package install with the service masked, so its default site never runs;
- the start wrapper under systemd: the unlock hand-off file, a saved password, a wrong saved password and no key;
- the saved password in systemd's memory-only credentials folder, unreadable to the validator's account;
- a start at boot with the saved password;
- log rotation, and logs and journals that never contain the key or the password.

Not tested: Let's Encrypt itself, which must reach the server on port 443 from the internet; real Tachyon websocket subscriptions; a machine with a TPM2 chip; and ipv6.

## How to Run Them

Use a throwaway machine, container or virtual machine, never a validator. The scripts bind port 443 on the address you give them and add one line to `/etc/hosts`.

For the container suites:

```bash
sudo apt install nginx nginx-module-njs nginx-module-acme   # from nginx.org's repository
sudo apt install python3-pip iproute2 curl openssl
sudo pip install --break-system-packages 'websockets>=15'   # Ubuntu's own package is too old
git clone --depth 1 --branch v2.10.3 https://github.com/letsencrypt/pebble
# download the matching pebble-linux-amd64.tar.gz release asset and unpack it
sudo tests/run-nginx-tests.sh 192.0.2.2 ./pebble-linux-amd64/linux/amd64/pebble ./pebble/test/certs
sudo tests/run-renewal-test.sh 192.0.2.2 ./pebble-linux-amd64/linux/amd64/pebble ./pebble/test/certs 120 480
```

Replace `192.0.2.2` with a non-loopback ipv4 address of the test machine. Each script prints one line per check and exits non-zero if any check fails.

For the systemd suite, start an Ubuntu 24.04 virtual machine from Ubuntu's cloud image, with ssh access. Then:

```bash
tests/make-vm-payload.sh ./payload ./debs ./node-v20.0.0-linux-x64.tar.xz \
    ./pebble-linux-amd64/linux/amd64/pebble ./pebble/test/certs
# copy ./payload to /root/payload in the VM, then, in the VM:
sudo bash /root/payload/systemd-tests-1.sh
sudo systemctl reboot
# after the reboot, in the VM:
sudo bash /root/payload/systemd-tests-2.sh
```

`./debs` holds the three .deb files from nginx.org (`apt-get download nginx nginx-module-njs nginx-module-acme`), and the Node.js tarball comes from nodejs.org, checked against its `SHASUMS256.txt`.
