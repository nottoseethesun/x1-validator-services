# Examples

`apply` writes each of these files for you, with your own values. They're here to read. Each but the list of hashes opens with a short header that says what it is. The list has none, since `apply` writes it as hash lines alone. The commands below show where each one goes.

Replace the placeholders with your own values:

- `x1-rpc.example.com`: your rpc's hostname
- `203.0.113.10`: the validator's public ipv4 address
- `HASH`: an api key's SHA-256 hash, in hex

Run the copy commands from this feature's folder, `~/x1-validator-services/x1-validator-private-rpc`.

| Example | What it is |
| --- | --- |
| `nginx/nginx.conf.example` | `nginx`'s configuration for the private rpc |
| `nginx/hashed-api-keys.map.example` | `nginx`'s list of the api keys' hashes, one line per key |
| `systemd/x1-validator-private-rpc.conf.example` | The `systemd` drop-in that starts `nginx` with the tool's configuration and its own read-only `/dev` |
| `logrotate/x1-validator-private-rpc.example` | The rotation of the private rpc's `nginx` logs |
| `apt/nginx.sources.example` | nginx.org's `apt` repository |
| `apt/99nginx.example` | The `apt` pin that prefers nginx.org's packages |
| `cron/x1-validator-private-rpc-ensure.cron.example` | The `crontab` line that runs `ensure` every minute |
| `cron/x1-validator-private-rpc-api-key-count.cron.example` | The `crontab` line that checks every few hours that `nginx` holds an api key |
| `git-hooks/post-merge.example` | The tool's `git` hook in `x1console`'s checkout, which runs `ensure` after an update |

## `nginx`

The configuration needs three things beside it:

- the key check, which the tool ships as is
- the list of the api keys' hashes, which it includes
- a log folder that only root and `nginx` can open

Without the list, `nginx` refuses to start.

```bash
sudo install -D -m 0644 examples/nginx/nginx.conf.example /etc/nginx/x1-validator-private-rpc/nginx.conf
sudo install -D -m 0644 src/njs/x1-validator-private-rpc.js /etc/nginx/x1-validator-private-rpc/x1-validator-private-rpc.js
sudo install -D -m 0644 examples/nginx/hashed-api-keys.map.example /etc/nginx/x1-validator-private-rpc/hashed-api-keys.map
sudo install -d -m 0750 -g nginx /var/log/x1-validator-private-rpc
```

The list's `HASH` is a placeholder, which no key matches. Each line holds one key's SHA-256 hash. This makes a key, shows it, and prints its line:

```bash
key="$(openssl rand -hex 32)"; echo "$key"; printf '%s 1;\n' "$(printf '%s' "$key" | sha256sum | cut -d ' ' -f 1)"
```

## `systemd`

```bash
sudo install -D -m 0644 examples/systemd/x1-validator-private-rpc.conf.example /etc/systemd/system/nginx.service.d/x1-validator-private-rpc.conf
sudo systemctl daemon-reload
```

## `logrotate`

```bash
sudo install -m 0644 examples/logrotate/x1-validator-private-rpc.example /etc/logrotate.d/x1-validator-private-rpc
```

## `apt`

The source names nginx.org's signing key at `/etc/apt/keyrings/nginx-archive-keyring.gpg`, which must hold the two keys the tool pins. `apply` checks both fingerprints before it writes that keyring. On a release other than Ubuntu 24.04, change `noble` to the release's code name.

```bash
sudo install -m 0644 examples/apt/nginx.sources.example /etc/apt/sources.list.d/nginx.sources
sudo install -m 0644 examples/apt/99nginx.example /etc/apt/preferences.d/99nginx
```

## `cron`

Run `crontab -e` as the validator's account, and paste each example's last line. First make the two folders the `ensure` example's header names.

## `git` hook

```bash
install -m 0755 examples/git-hooks/post-merge.example ~/x1console/.git/hooks/post-merge
```
