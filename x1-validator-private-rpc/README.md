# x1-validator-private-rpc

## Overview

x1console starts an X1 validator with its full rpc open on port 8899, on every network interface, and advertised to the network. So anyone on the internet can query it, and each query competes with voting for the machine.

x1-validator-private-rpc makes the rpc private, and puts it behind an https url that carries an api key, such as `https://x1-rpc.example.com/KEY`:

- `apply` adds `--private-rpc` to x1console's start script, so the rpc listens on 127.0.0.1 alone from the validator's next start, and is no longer advertised.
- It puts nginx, from nginx.org, in front of the rpc, on the validator's public address and port 443 alone. nginx forwards only requests whose path starts with the key, and refuses every other one with a 403 before it reaches the validator. Keyed requests beyond a rate limit you can set get 429 Too Many Requests. nginx gets and renews its certificate from Let's Encrypt through port 443, so port 80 stays closed.
- The key is encrypted with your x1-validator-services password. You can save the password, so nginx unlocks itself after a restart, or type it with `unlock` each time.
- Every minute, `ensure` keeps it that way. It puts the flag back after an x1console update. It alerts you on Telegram when the rpc turns public, the flag can't go back, nginx is down or locked, or the certificate needs attention.
- `turn-off-private-rpc` makes the rpc public again, from the validator's next start, and leaves everything else in place. `turn-on-private-rpc` makes it private again.
- `undo-apply` takes it all back, nginx included, until the machine is as `apply` found it.

The tool never restarts the validator, and nothing it adds listens on the loopback address.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Install](#install)
  - [Check That nginx Upgrades Keep Working](#check-that-nginx-upgrades-keep-working)
  - [Point the Hostname at the Validator](#point-the-hostname-at-the-validator)
  - [Set the Hostname](#set-the-hostname)
  - [Run apply](#run-apply)
  - [Restart the Validator](#restart-the-validator)
  - [Cronitor Heartbeat](#cronitor-heartbeat)
- [Run](#run)
- [Update](#update)
- [Uninstall](#uninstall)
- [Usage](#usage)
  - [After a Restart of nginx](#after-a-restart-of-nginx)
  - [After an x1console Update](#after-an-x1console-update)
  - [Turn the Private Rpc Off and On](#turn-the-private-rpc-off-and-on)
  - [Alerts](#alerts)
- [Configure](#configure)
- [Test](#test)
- [Api Key Security](#api-key-security)
- [Development](#development)

---

## Prerequisites

- An X1 validator set up by x1console, on Ubuntu 24.04 or later, with x1console's Node.js 20.0.0.
- The project's code on the validator, as the project's [Install](../README.md#install) section describes.
- The validator's account, with sudo.
- The validator's public ipv4 address on one of its own interfaces. Servers behind address translation aren't supported.
- Port 443 free on the validator, not closed by a ufw rule, and no nginx installed there.
- A domain you own, where you can add a dns record.
- For the alerts, x1console's Telegram alerts, set up in x1console.

---

## Install

> **Run `npm` from the project root.** Every `npm` command runs in the project root, one level up from this directory (`cd ..`), where the project's single `node_modules` lives.
>
> **Never point the validator's own solana cli at the gated rpc.** On the validator, don't set the cli's rpc url, whether through x1console's network menu or `solana config set --url`, to anything that contains the gated rpc's hostname (`x1-rpc.example.com` in these docs). Autopilot's health check uses that url, and the gated rpc can stop answering, for example after a reboot, until you unlock it. Autopilot answers a failed check by deleting the ledger and restarting the validator.

### Check That nginx Upgrades Keep Working

Run this first, before anything else of the tool is installed. It proves on this machine that a regular apt upgrade of nginx keeps the gated rpc working. It installs nginx.org's previous release, runs it under systemd the way the tool will, upgrades it with apt, and checks that systemd followed the new nginx and that the api key carried over. Then it removes everything it added. It never touches Tachyon, port 443 or the firewall.

It takes a few minutes. Run it inside tmux, so that a dropped ssh connection can't stop it halfway and leave nginx installed. If the connection drops, log in again and run `tmux attach` to get back to it. Run it as the validator's account, from the project root. It asks for your sudo password:

```bash
tmux
cd ~/x1-validator-services
node x1-validator-private-rpc/util/validate-nginx-upgrade/index.js
```

It ends with `Passed`, or with the reasons it failed. If it ever can't remove something it added, it lists that step with a `By hand:` command that does the same. Run those commands in the order listed, then run it again. To stop it early, press Ctrl-C: it finishes the step it's on, then removes everything it added. Type `exit` afterwards to leave tmux. Go on with the install only once it passes.

### Point the Hostname at the Validator

Add one `A` record at your dns provider: a new name under your domain, such as `x1-rpc.example.com`, with the validator's public ipv4 address. [Manual Domain Setup](docs/manual-domain-setup.md) shows how, for form-based and raw zone-file editors, and how to check the record.

### Set the Hostname

From the project root, copy the example settings. Then set `hostname`, `publicIp` and `acmeEmail` to your own:

```bash
cp x1-validator-private-rpc/app-config/app-defaults-for-user-configurable/private-rpc.example.json \
   x1-validator-private-rpc/app-config/user-configurable/private-rpc.json
```

Or delete `publicIp`, to use the address the X1 network sees for your validator. Delete `acmeEmail` if you want no contact address at Let's Encrypt. [Configure](#configure) says more.

### Run apply

First have a look at what `apply` would do. The dry run changes nothing:

```bash
cd ~/x1-validator-services
node x1-validator-private-rpc/src/cli.js apply --dry-run
```

Then run it inside tmux, as with the upgrade check. The first run gets its certificate from Let's Encrypt's staging service, which no client trusts, so a mistake costs none of Let's Encrypt's limited real certificates:

```bash
tmux
node x1-validator-private-rpc/src/cli.js apply --acme-staging
```

`apply` checks the machine first, and changes nothing until it has found every problem it can. Then it goes through its stages, asking before each one:

- nginx from nginx.org
- the firewall rule for port 443
- the api key and your password
- nginx's configuration and start
- the start-script flag
- the git hook and cron job that run `ensure`

It asks for a new x1-validator-services password, typed twice, with at least as many characters as the `passwordMinLength` setting says. It then tells what your machine's TPM2 chip means for a saved password, and asks whether to save it. `--yes` answers yes to the stage questions and the cron job's, but you still type the password and choose whether to save it.

Once the staging run has finished, run `apply` again without the flag, for the real certificate. It changes only nginx's configuration, and asks for your password to start nginx with the key:

```bash
node x1-validator-private-rpc/src/cli.js apply
```

Every stage first checks whether its work is done, so running `apply` again is safe. It skips what's in place. If it stops partway, run it again, and it picks up from there.

### Restart the Validator

The validator takes `--private-rpc` at its next start. `apply` never restarts it. In x1console, choose 2. Validator, then 1. Start/Restart Validator, at a moment when the Validator screen shows no leader slot coming soon. The keyed url works before the restart too, since the rpc still listens on every interface until then.

After the restart, check from another machine. The first should fail to connect, and the second should answer `ok`:

```bash
curl -m 5 http://203.0.113.10:8899/health
curl -s https://x1-rpc.example.com/KEY/health
```

Replace `203.0.113.10` with the validator's address, and the url with yours, which `url` prints in full.

### Cronitor Heartbeat

`ensure` runs every minute, from the cron job `apply` installs. It puts `--private-rpc` back after an x1console update, and sends the tool's Telegram alerts. If its cron job ever stops working, for example because this folder moved or its settings have a typo, all of that stops without a word. So at the end of each run, `ensure` checks in with Cronitor, and Cronitor alerts you when the check-ins stop. While all is well, Cronitor sends nothing.

The heartbeat is optional. Without a url, `ensure` doesn't check in. To set it up, first create a Cronitor account, as the project's [Cronitor Alerts](../README.md#cronitor-alerts) section describes. Then:

1. In Cronitor, create a job monitor, named for example `X1 Validator Private Rpc - ensure`, with these settings:
   - schedule `* * * * *`, every minute, like the cron line
   - a grace period of 60 seconds
   - an alert after three consecutive missed runs, so one lost check-in doesn't set it off
2. Copy the monitor's telemetry url, which looks like `https://cronitor.link/p/YOUR_CRONITOR_API_KEY/YOUR_MONITOR_KEY`. Treat it as a credential: anyone who has it can check in for you and hide an outage.
3. Add it to the project root's `.env` (see [Credentials](../README.md#credentials)):

   ```text
   X1_PRIVATE_RPC_CRONITOR_URL=https://cronitor.link/p/YOUR_CRONITOR_API_KEY/YOUR_MONITOR_KEY
   ```

4. Test it. Run `crontab -e`, and put a `#` in front of the line that runs `ensure`. Within about five minutes, Cronitor should alert you on Telegram. Then remove the `#`. Once the check-ins resume, Cronitor sends a recovery notice.

---

## Run

Run the tool as the validator's account, from the project root:

```bash
cd ~/x1-validator-services
node x1-validator-private-rpc/src/cli.js --help
```

To type it by name from anywhere, link it into `~/.local/bin`, which Ubuntu's default profile puts on your PATH from your next login. Then `x1-validator-private-rpc COMMAND` does the same as `node x1-validator-private-rpc/src/cli.js COMMAND`:

```bash
mkdir -p ~/.local/bin
ln -s ~/x1-validator-services/x1-validator-private-rpc/src/cli.js ~/.local/bin/x1-validator-private-rpc
```

Nothing needs keeping running by hand: nginx runs under systemd, and cron runs `ensure` every minute. Run a command when you need one:

| Command | What it does |
| --- | --- |
| `apply` | Sets everything up, asking before each stage. `--dry-run` only shows what it would do, and `--acme-staging` gets a staging certificate. |
| `ensure` | Puts `--private-rpc` back after an update, checks the setup, and sends the alerts. `--quiet` prints only what changed. |
| `unlock` | Asks for the password, and restarts nginx with the key. |
| `url` | Asks for the password, and prints the full https and websocket urls. |
| `turn-off-private-rpc` | Takes `--private-rpc` out of the start script, after asking, and keeps `ensure` from putting it back. `--yes` skips the question. |
| `turn-on-private-rpc` | Puts `--private-rpc` back, for `ensure` to keep there again. |
| `undo-apply` | Undoes everything `apply` changed, newest first, and leaves what was there before. `--dry-run` only shows the steps. |

Each command answers `--help`. Exit code 0 means success, or every check ok. Exit code 1 means a stage failed, a check found a problem, you answered no and the command stopped, or another error. The output says which.

---

## Update

From the project root, get the new code and its packages, then run `apply`. It rewrites any file the new version writes differently, its own git hook and cron line included. It also turns private rpc back on, if you turned it off:

```bash
cd ~/x1-validator-services
git pull
npm ci --omit=dev --ignore-scripts
node x1-validator-private-rpc/src/cli.js apply
```

nginx and its modules update with the system's other packages, through `apt upgrade`, which the upgrade check above proved safe.

---

## Uninstall

`undo-apply` undoes everything `apply` changed, newest first, until the machine is as `apply` found it. `apply` records each setting it changes, with its old value, in `app-data/what-apply-changed.json`, and `undo-apply` puts back only those. A setting that was there before `apply`, such as a firewall rule you added, stays. Look first, then run it:

If you set up the [Cronitor heartbeat](#cronitor-heartbeat), pause or delete its monitor first. Once the cron line goes, the check-ins stop, and Cronitor alerts you.

```bash
cd ~/x1-validator-services
node x1-validator-private-rpc/src/cli.js undo-apply --dry-run
node x1-validator-private-rpc/src/cli.js undo-apply
```

It removes each of these that `apply` made:

- the cron line and its folders
- the git hook
- the start-script flag and its backups
- nginx's service, files, logs and certificates
- the saved password and the api key, after asking, with the vault and the folders made for them, once nothing else is in them
- the firewall rule
- nginx and its modules, with the account their package made
- nginx.org's apt repository
- the mask on nginx.service

If a step fails, it says so. A failed or declined step stays on record, and running `undo-apply` again retries it. Once nothing is left, it removes `app-data/`, with the record in it.

A later `apply` starts from scratch, and gets a new certificate. Let's Encrypt issues at most five for one hostname in seven days. To make the rpc public for a while and keep everything else, use `turn-off-private-rpc` instead, as [Turn the Private Rpc Off and On](#turn-the-private-rpc-off-and-on) shows.

The running validator keeps a private rpc until its next start. Restart it from x1console, as in [Restart the Validator](#restart-the-validator), to open the rpc again.

---

## Usage

### After a Restart of nginx

Without a saved password, nginx starts locked after a reboot or a restart of nginx, and answers every request with a 403. `ensure` sends an alert, and `unlock` opens it again:

```bash
node x1-validator-private-rpc/src/cli.js unlock
```

### After an x1console Update

x1console's Update X1 Console runs `git stash`, which takes `--private-rpc` out of the start script. The git hook puts it back as the update finishes, or the cron job within a minute, and `ensure` says so in an alert. The running validator keeps a private rpc until its next start, which takes the flag. Without the cron job, run `ensure` yourself after each update, and before Update X1 Validator, which restarts the validator.

### Turn the Private Rpc Off and On

`turn-off-private-rpc` takes `--private-rpc` out of the start script, after asking, so the rpc listens on every interface again from the validator's next start. Everything else stays: nginx keeps serving the keyed url, and `ensure` keeps checking nginx and its certificate. But `ensure` no longer puts the flag back, and no longer checks that the rpc is private, until `turn-on-private-rpc` puts the flag back:

```bash
node x1-validator-private-rpc/src/cli.js turn-off-private-rpc
node x1-validator-private-rpc/src/cli.js turn-on-private-rpc
```

Neither restarts the validator. Restart it as in [Restart the Validator](#restart-the-validator), for the change to take effect. `apply` turns private rpc on too, whenever it runs.

### Alerts

`ensure` sends its alerts on Telegram through x1console's bot, as plain text, naming your hostname and the event, never a secret. A problem alerts once when it starts, and again when it ends.

| Alert | When | Repeats |
| --- | --- | --- |
| The rpc is public | The rpc listens on an address other than 127.0.0.1 | Every `exposedReminderMinutes` |
| The flag is missing | The start script lacks `--private-rpc`, and `ensure` couldn't put it back | Every `exposedReminderMinutes` |
| nginx is down | nginx isn't active | No |
| nginx is locked | nginx has no key, so it refuses every request | No |
| The certificate needs attention | Under `certificateWarningDays` left, or the tls check fails | Daily |
| The flag is back | `ensure` put `--private-rpc` back after an update | No |

While private rpc is off, `ensure` doesn't check the flag or where the rpc listens, so the first two alerts stay quiet. An alert Telegram doesn't take goes out at the next run. Without x1console's Telegram files, `ensure` only logs.

Three checks send no alert: the running validator's flag, the paths in the start wrapper, the script systemd starts nginx with, and what listens on ports 80 and 443. Their problems show in `ensure`'s output, its log and its exit code.

---

## Configure

Your settings go in `app-config/user-configurable/private-rpc.json`. Its [README](app-config/user-configurable/README.md) says what the file holds, and where every setting is described. One you may want to change is `rateLimitRequestsPerSecond`, nginx's limit on keyed requests. Run `apply` again after a change, to rewrite nginx's configuration.

The Cronitor url is a credential, so it goes in the project root's `.env` instead, as [Cronitor Heartbeat](#cronitor-heartbeat) shows.

[examples/](examples/README.md) holds an example of each file `apply` renders, with placeholders for your values.

---

## Test

Run tests from the project root (`cd ..`). Only the system test, `npm run test:system`, needs LXD. It runs the tool for real, in a throwaway Ubuntu 24.04 container on your development machine, never on a validator. The project's [engineering reference](../docs/engineering.md#the-system-test) says what it checks.

Set up LXD once, on Ubuntu, then log out and back in so the group change takes effect:

```bash
sudo snap install lxd
sudo lxd init --auto
sudo usermod -aG lxd "$USER"
```

Then run the test. It takes about ten minutes, and the container needs internet access:

```bash
npm run test:system
```

---

## Api Key Security

- **The vault.** The key is encrypted with your x1-validator-services password, the way LP Ranger's command-line version stores private keys: AES-256-GCM, with its key from PBKDF2-SHA-512 at 600,000 iterations. The vault is `~/.config/x1-validator-services/vault.json`, readable by your account alone, in a folder that future validator services can share.
- **nginx's memory alone.** nginx holds the key in its environment, never in its configuration. `unlock` hands it over through a memory-only file that the start wrapper reads and deletes at once. The key is never a command's argument, so no other user sees it in a process list.
- **No key in the logs.** nginx's logs show `<key>` in place of anything that looks like a key, a mistyped one included. Only root and nginx can read them. The location that forwards keyed requests logs critical errors alone.
- **A saved password.** systemd encrypts it, with the machine's TPM2 chip when it has a usable one. Without a chip, the key that decrypts it sits on the same disk, so a copy of the disk gives it up. `apply` says which case applies before it asks.
- **A lost password** can't be recovered from the vault. Run `undo-apply`, and let it delete the key, and the saved password too, if you saved one. Then run `apply`, which makes a new key under a new password, and give your clients the new url.
- **The url** shows the key in full only when you ask, with `url`.

---

## Development

For an overview of how the tool works, see **[`docs/architecture.md`](docs/architecture.md)**. It covers the parts the tool arranges on the validator, the path of a request and of the key, and who restarts what.

For engineering details, see **[`docs/engineering.md`](docs/engineering.md)**. It covers the modules, apply's record, every file the tool reads and writes, the order its commands do things in, and the tests.

For how the whole project is checked, see the project's [`docs/engineering.md`](../docs/engineering.md), and for every `npm` command, [`docs/npm-project-commands.md`](../docs/npm-project-commands.md).
