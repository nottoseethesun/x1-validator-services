# Examples

`apply` writes each of these files for you, with your own values. They're here to read. Each opens with a short header that says what it is, and the commands below show where each one goes.

Replace the placeholders with your own values:

- `x1-rpc.example.com`: your rpc's hostname
- `203.0.113.10`: the validator's public ipv4 address
- `VALIDATOR_USER`: the account that runs the validator

Run the copy commands from this feature's folder, `~/x1-validator-services/x1-validator-private-rpc`.

| Example | What it is |
| --- | --- |
| `nginx/nginx.conf.example` | nginx's configuration for the private rpc |
| `systemd/nginx-start.example` | The start wrapper, which starts nginx with the api key |
| `systemd/x1-validator-private-rpc.conf.example` | The systemd drop-in that starts nginx through the wrapper |
| `logrotate/x1-validator-private-rpc.example` | The rotation of the private rpc's nginx logs |
| `apt/nginx.sources.example` | nginx.org's apt repository |
| `apt/99nginx.example` | The apt pin that prefers nginx.org's packages |
| `cron/x1-validator-private-rpc-ensure.cron.example` | The crontab line that runs `ensure` every minute |
| `git-hooks/post-merge.example` | x1console's git hook, which runs `ensure` after an update |

## nginx

The configuration needs the key check beside it, which the tool ships as is, and a log folder that only root and nginx can open:

```bash
sudo install -D -m 0644 examples/nginx/nginx.conf.example /etc/nginx/x1-validator-private-rpc/nginx.conf
sudo install -D -m 0644 src/njs/x1-validator-private-rpc.js /etc/nginx/x1-validator-private-rpc/x1-validator-private-rpc.js
sudo install -d -m 0750 -g nginx /var/log/x1-validator-private-rpc
```

## systemd

Without a saved password, delete the drop-in's last three lines: systemd refuses to start nginx when the credential file the drop-in names is missing.

```bash
sudo install -D -m 0755 examples/systemd/nginx-start.example /usr/local/libexec/x1-validator-private-rpc/nginx-start
sudo install -D -m 0644 examples/systemd/x1-validator-private-rpc.conf.example /etc/systemd/system/nginx.service.d/x1-validator-private-rpc.conf
sudo systemctl daemon-reload
```

## logrotate

```bash
sudo install -m 0644 examples/logrotate/x1-validator-private-rpc.example /etc/logrotate.d/x1-validator-private-rpc
```

## apt

The source names nginx.org's signing key at `/etc/apt/keyrings/nginx-archive-keyring.gpg`, which must hold the two keys the tool pins. `apply` checks both fingerprints before it writes that keyring. On a release other than Ubuntu 24.04, change `noble` to the release's code name.

```bash
sudo install -m 0644 examples/apt/nginx.sources.example /etc/apt/sources.list.d/nginx.sources
sudo install -m 0644 examples/apt/99nginx.example /etc/apt/preferences.d/99nginx
```

## cron

Run `crontab -e` as the validator's account, and paste the example's last line. First make the two folders its header names.

## git hook

```bash
install -m 0755 examples/git-hooks/post-merge.example ~/x1console/.git/hooks/post-merge
```
