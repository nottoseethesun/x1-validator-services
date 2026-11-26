# Examples

x1-validator-private-rpc's `apply` command, which makes the validator's rpc private and puts it behind `nginx`, as the feature's [README](../README.md) describes, writes each of the files below on the validator, with your own values. This folder holds an example of each, written for placeholder values, for you to read:

| Example | What it is |
| --- | --- |
| `nginx/nginx.conf.example` | `nginx`'s configuration for the private rpc |
| `nginx/hashed-api-keys.map.example` | `nginx`'s list of the api keys' hashes, one line per key |
| `systemd/x1-validator-private-rpc.conf.example` | The `systemd` drop-in that starts `nginx` with the tool's configuration and its own read-only `/dev`, after making its log folder when it's missing |
| `apt/nginx.sources.example` | nginx.org's `apt` repository |
| `apt/99nginx.example` | The `apt` pin that prefers nginx.org's packages |
| `cron/x1-validator-private-rpc-ensure.cron.example` | The `crontab` line that runs `ensure` every minute. `ensure` is the tool's command that keeps the rpc private: it puts `--private-rpc` back into `x1console`'s start script after an `x1console` update takes it out, and sends the tool's Telegram alerts. |
| `cron/x1-validator-private-rpc-api-key-count.cron.example` | The `crontab` line that checks every few hours that `nginx`'s list of the api keys' hashes isn't empty |
| `git-hooks/post-merge.example` | The tool's `git` hook in `x1console`'s checkout, which runs `ensure` after an update |

The placeholders:

- `x1-rpc.example.com`: your rpc's hostname
- `203.0.113.10`: the validator's public ipv4 address
- `HASH`: an api key's SHA-256 hash, in hex
- `v24.X.Y`: the release of Node.js 24 that runs the tool, the newest that `nvm` holds. `nvm which 24` prints its `node`'s full path.

Each example but `nginx`'s list of hashes opens with a short header that says what it is. The list has none, since `apply` writes it as hash lines alone.

The sections below show where each file goes, for a set-up by hand. Replace the placeholders with your own values, and run the copy commands from this feature's folder, `~/x1-validator-services/x1-validator-private-rpc`. `apply` also installs the key check, the njs file `nginx` runs on each request. It has no example here, since the tool ships it as is. If `apply` finds an `nginx` configuration, a `systemd` drop-in or a key check that it didn't write, it stops, and says to move the file away. But a file that holds just what `apply` would write doesn't stop it, and a copy of the key check or of the drop-in made as the sections below show holds just that. `apply` then leaves the file as it is, and so does a later run of `undo-apply`, the tool's command that takes back only what `apply` changed. So don't leave such a copy on a machine where you'll run `apply`.

## `nginx`

The configuration needs two things beside it:

- the key check, which the tool ships as is
- the list of the api keys' hashes, which it includes

Without the list, `nginx` refuses to start. The logs go in `/var/log/nginx`, which nginx.org's package makes and rotates.

```bash
sudo install -D -m 0644 examples/nginx/nginx.conf.example /etc/nginx/x1-validator-private-rpc/nginx.conf
sudo install -D -m 0644 src/njs/x1-validator-private-rpc.js /etc/nginx/x1-validator-private-rpc/x1-validator-private-rpc.js
sudo install -D -m 0644 examples/nginx/hashed-api-keys.map.example /etc/nginx/x1-validator-private-rpc/hashed-api-keys.map
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

## `apt`

The source names nginx.org's signing key at `/etc/apt/keyrings/nginx-archive-keyring.gpg`. `apply` makes that keyring from nginx.org's key file: it checks that the file holds the two fingerprints the tool pins, listed in `src/lib/nginx-org.js`, then exports only those two keys into the keyring. For a set-up by hand, do the same with `gpg`:

1. Download `https://nginx.org/keys/nginx_signing.key`.
2. Check with `gpg --show-keys` that it holds both fingerprints.
3. Import it into a `gpg` folder of its own.
4. `gpg --export` only those two keys into the keyring.

On a release other than Ubuntu 24.04, change `noble` to the release's code name.

```bash
sudo install -m 0644 examples/apt/nginx.sources.example /etc/apt/sources.list.d/nginx.sources
sudo install -m 0644 examples/apt/99nginx.example /etc/apt/preferences.d/99nginx
```

## `cron`

Run `crontab -e` as the validator's account, and paste each example's last line. Each line makes the folders it writes in, when they're missing.

## `git` hook

```bash
install -m 0755 examples/git-hooks/post-merge.example ~/x1console/.git/hooks/post-merge
```
