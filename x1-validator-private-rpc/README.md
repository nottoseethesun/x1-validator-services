# x1-validator-private-rpc

## Overview

`x1console` starts an X1 validator with its full rpc open on port 8899, on every network interface, and advertised to the network. So anyone on the internet can query it, and each query competes with voting for the machine's cpu and bandwidth.

x1-validator-private-rpc is currently made to work only with [`x1console`](https://github.com/BlackBeard085/x1console/tree/main).

x1-validator-private-rpc makes the rpc private, and puts it behind an https url that carries an api key, the keyed url, such as `https://x1-rpc.example.com/KEY`:

- `apply` adds `--private-rpc` to `x1console`'s start script, so the rpc listens on 127.0.0.1 alone from the validator's next start, and is no longer advertised.
- It puts `nginx`, from nginx.org, in front of the rpc, on the validator's public address and port 443 alone. `nginx` forwards only requests whose path starts with one of the keys, and refuses every other one with a 403 before it reaches the validator. Keyed requests beyond a rate limit you can set, which all keys share, get 429 Too Many Requests. `nginx` gets and renews its certificate from Let's Encrypt through port 443, so port 80 stays closed.
- `nginx` keeps only each key's SHA-256 hash, and checks a request by hashing the key it carries. A hash can't be worked back into its key, so `nginx`'s list of hashes is kept unencrypted, and `nginx` reads it with no password. So a restart of `nginx`, or a reboot, needs nobody to type one. Each key is shown once, when it's made: save it then. `apply` makes the first, `add-api-key` makes more, one per client if you like, and `remove-api-key` takes one away. Each key has a record, with when it was made and an optional email, encrypted with an x1-validator-services password you choose during `apply`.
- `ensure` keeps the rpc private. `x1console`'s Update X1 Console takes `--private-rpc`, the flag, out of the start script. When the update's `git pull` brings new commits, `git` runs the tool's `git` hook in `x1console`'s checkout, and the hook has `ensure` put the flag back at once. A `cron` job also runs `ensure` every minute, which puts the flag back after an update the hook misses. `ensure` alerts you on Telegram when the rpc turns public, the flag can't go back, `nginx` is down, or the certificate needs attention. Every few hours, a second `cron` job runs the key count check, `ensure-there-is-at-least-one-rpc-api-key`, which alerts you when `nginx`'s list holds no key.
- `turn-off-private-rpc` makes the rpc public again, from the validator's next start, and leaves everything else in place. `turn-on-private-rpc` makes it private again.
- `undo-apply` takes it all back, `nginx` included, until the machine is as `apply` found it.

The engineering reference's [Integration with `x1console`](docs/engineering.md#integration-with-x1console) details where the tool and `x1console` meet: the start script, the `git` hook and the Telegram set-up.

The tool never restarts the validator, and nothing it adds listens on the loopback address, where `x1console`'s scripts and its pinger reach the validator's rpc.

Your use of this tool, including all of its scripts and features, constitutes your agreement that you have read and understood the [Disclaimer](#disclaimer).

## Table of Contents

- [Overview](#overview)
- [Disclaimer](#disclaimer)
- [Prerequisites](#prerequisites)
  - [System Programs](#system-programs)
- [Install](#install)
  - [Check That `nginx` Upgrades Keep Working](#check-that-nginx-upgrades-keep-working)
  - [Point the Hostname at the Validator](#point-the-hostname-at-the-validator)
  - [Set the Hostname](#set-the-hostname)
  - [Run apply](#run-apply)
  - [Restart the Validator](#restart-the-validator)
  - [Cronitor Heartbeat](#cronitor-heartbeat)
- [Update](#update)
- [Uninstall](#uninstall)
- [Usage](#usage)
  - [Api Keys](#api-keys)
  - [Check](#check)
  - [After an `x1console` Update](#after-an-x1console-update)
  - [Turn the Private Rpc Off and On](#turn-the-private-rpc-off-and-on)
  - [Alerts](#alerts)
- [Configure](#configure)
- [Test](#test)
- [Api Key Security](#api-key-security)
- [Development](#development)

---

## Disclaimer

x1-validator-services is licensed under the Apache License, Version 2.0. The LICENSE file at the project's root holds its full text.

That license says the software is provided as is, without warranties or conditions of any kind, express or implied. That includes any warranties or conditions of title, non-infringement, merchantability or fitness for a particular purpose. You alone are responsible for deciding whether it's right to use or share it, and you take on any risks of doing so.

The license also says that no contributor is liable to you for damages, under any legal theory, whether in tort, negligence included, in contract or otherwise. That covers direct, indirect, special, incidental and consequential damages of any kind that come from the license, or from using the software or being unable to use it. Among them are lost goodwill, work stoppage, a computer's failure or malfunction, and any other commercial damages or losses. It holds even when a contributor was told such damages could happen.

Both hold unless the law requires otherwise, as it can for deliberate and grossly negligent acts, or unless otherwise agreed in writing.

This software could, although its authors have made all best efforts to the contrary, cause your validator to exhibit degraded performance or even stop working.

Each run that can change the system, the `nginx` upgrade check among them, shows this disclaimer before it does anything, in a dialog that `whiptail` draws, which takes over the terminal like the ones packages show as they install. The run goes on only once you choose Affirm, which affirms "I have read and understood the above Disclaimer." Decline, or Esc, stops it with nothing changed, and Ctrl-C does nothing there. Decline has the focus at first. The left and right arrows move between the two buttons, Tab also moves to the text, where the up and down arrows and PgUp and PgDn scroll it, and Enter chooses. `url`, `check-my-private-rpc`, `ensure-there-is-at-least-one-rpc-api-key` and the dry runs change nothing, so they don't show it. Neither does `ensure`, which `cron` and the tool's `git` hook run with nobody at the terminal.

---

## Prerequisites

- An X1 validator set up by `x1console`, on Ubuntu 24.04 or later, with `x1console`'s Node.js 20.0.0.
- The project's code on the validator, as the project's [Install](../README.md#install) section describes.
- The validator's account, with `sudo`.
- The validator's public ipv4 address on one of its own interfaces. Servers behind address translation aren't supported.
- Port 443 free on the validator, not closed by a `ufw` rule, and no `nginx` installed there.
- A domain you own, where you can add a dns record.
- For the alerts, `x1console`'s Telegram alerts, set up in `x1console`.

### System Programs

The tool works through a set of system programs, which the engineering reference's [Dependencies](docs/engineering.md#dependencies) section lists, with what the tool does with each. A stock Ubuntu 24.04 server has them all but two: `x1console` brings Node.js, and `apply` installs `nginx`. `apt` and `dpkg` come from the Debian distribution of Linux, and its family of distributions shares them. `ufw` comes from Ubuntu, one of that family, and the nginx.org packages that the tool installs are nginx.org's builds for Ubuntu. Ubuntu also installs `whiptail` with the system, and the tool draws its disclaimer's dialog with it. The tool will not work without these, and also, will not work without `systemd`. The rest are common to Linux systems that run `systemd`.

---

## Install

> **Never point the validator's own `solana` cli at the keyed url, or at the validator's own address.** On the validator, don't set the cli's rpc url to anything that contains the tool's hostname (`x1-rpc.example.com` in these docs) or the validator's public address, whether from `x1console`'s network menu or with `solana config set --url`. Autopilot's health check uses that url. Under `--private-rpc`, the rpc no longer answers on the validator's address. The keyed url can stop answering too, for example while `nginx` restarts, or once its last key is removed. Autopilot answers a failed check by deleting the ledger and restarting the validator. `apply` stops at its first check, changing nothing, while the cli's url names either.

### Check That `nginx` Upgrades Keep Working

Once the tool is installed, `nginx` updates with the system's other packages, whenever `apt upgrade` runs, as `x1console`'s Update X1 Validator does. This check proves on this machine that such an upgrade keeps the keyed url working. Run it first, before anything else of the tool is installed. It installs nginx.org's previous release, runs it under `systemd` the way the tool will, with a throwaway api key, and upgrades it with `apt`. nginx.org's upgrade starts a new `nginx` process and hands over to it, without a restart. `systemd` knows `nginx` by its main process, so it must follow that handover. The check makes sure it did: `systemd` still counts `nginx` as running, now as the new process, with no restart. It also makes sure the new `nginx` still lets the throwaway key through and turns a random one away. Last, it removes everything it added. It never touches Tachyon, port 443 or the firewall.

It takes a few minutes. Run it inside `tmux`, so that a dropped `ssh` connection can't stop it halfway and leave `nginx` installed. If the connection drops, log in again and run `tmux attach` to get back to it. Run it as the validator's account, from the project root. It asks for your `sudo` password:

```bash
tmux
cd ~/x1-validator-services
node x1-validator-private-rpc/util/validate-nginx-upgrade/index.js
```

It ends with `Passed`, or with the reasons it failed. If it ever can't remove something it added, it lists that step with a `By hand:` command that does the same. Run those commands in the order listed, then run it again. To stop it early, press Ctrl-C: it finishes the step it's on, then removes everything it added. Type `exit` afterwards to leave `tmux`. Go on with the install only once it passes.

### Point the Hostname at the Validator

Add one `A` record at your dns provider: a new name under your domain, such as `x1-rpc.example.com`, with the validator's public ipv4 address. [Manual Domain Setup](docs/manual-domain-setup.md) shows how, for form-based and raw zone-file editors, and how to check the record.

### Set the Hostname

From the project root, copy the example settings:

```bash
cp x1-validator-private-rpc/app-config/app-defaults-for-user-configurable/private-rpc.example.json \
   x1-validator-private-rpc/app-config/user-configurable/private-rpc.json
```

Then, in the copy, set `hostname` to the name from the last step, and `publicIp` to the validator's public ipv4 address, which `nginx` listens on. Or delete `publicIp`, to use the address the X1 network sees for your validator. Set `acmeEmail` to a contact address for Let's Encrypt, or delete it for none. [Configure](#configure) says more.

### Run apply

First have a look at what `apply` would do. The dry run changes nothing:

```bash
cd ~/x1-validator-services
node x1-validator-private-rpc/src/cli.js apply --dry-run
```

Then run it inside `tmux`, as with the upgrade check. The first run gets its certificate from Let's Encrypt's staging service, which no client trusts, so a mistake costs none of Let's Encrypt's limited real certificates:

```bash
tmux
node x1-validator-private-rpc/src/cli.js apply --acme-staging
```

`apply` first checks the machine, and changes nothing. If it finds problems, it lists them all and stops. Otherwise it goes through its stages, asking before each one:

- `nginx` from nginx.org
- the firewall rule for port 443
- the first api key and your password
- `nginx`'s configuration and start
- the start-script flag
- the `git` hook, and the `cron` jobs that run `ensure` and the key count check

At its stage for the first api key, `apply` asks for a new x1-validator-services password, typed twice, with at least as many characters as the `passwordMinLength` setting says. The password encrypts the api keys' records, never the keys, which the tool doesn't keep. Then it makes the first api key, and prints its two urls, https and wss, in full. **Save them now**: the tool keeps only the key's hash, and can't show the key again.

Then it asks whether to save the password, which `systemd` keeps encrypted. Nothing reads a saved password yet. It's there so that features to come can read the records unattended: billing, and rotation notices, which will email a key's client when the key is due to be replaced. `nginx` never needs it. Before it asks, it says whether `systemd` can tie a saved password to this machine's TPM2 chip, and what that means, as [Api Key Security](#api-key-security) explains.

`--yes` answers yes to each stage's question and to the question about the `cron` jobs. You still type the password, and answer the save question.

Once the staging run has finished, run `apply` again without `--acme-staging`, for the real certificate. It changes only `nginx`'s configuration, keeps the key, and asks for no x1-validator-services password:

```bash
node x1-validator-private-rpc/src/cli.js apply
```

Every stage first checks whether its work is done, so running `apply` again is safe. It skips what's in place. If it stops partway, run it again, and it picks up from there. If `nginx` refuses a new configuration, `apply` puts the old one back, so `nginx` runs as before. It keeps what `nginx` refused, and why, in `x1-validator-private-rpc/logs/error.log`. A key it made and showed stays, so the next run makes none. On a first install, if `apply` stops at the question about saving the password, say with Ctrl-C, no later run asks it again, so the password stays unsaved. If you stop `apply` before its flag stage, `ensure` doesn't add the flag either: it leaves the start script alone until `apply` has added it.

### Restart the Validator

The validator takes `--private-rpc` at its next start. `apply` never restarts it. In `x1console`, choose 2. Validator, then 1. Start/Restart Validator, at a moment when the Validator screen shows no leader slot coming soon. The keyed url works before the restart too: `nginx` forwards to the rpc on 127.0.0.1, and until the restart the rpc listens on every interface, 127.0.0.1 among them.

After the restart, check from another machine that the rpc no longer answers on the validator's address. This should fail to connect:

```bash
curl -m 5 http://203.0.113.10:8899/health
```

Replace `203.0.113.10` with the validator's address. Then check the keyed url with `check-my-private-rpc`, as [Check](#check) describes. It asks for the key without showing it, so the key stays out of your shell's history.

### Cronitor Heartbeat

`ensure` runs every minute, from the `cron` job `apply` installs. It puts `--private-rpc` back after an `x1console` update, and sends the tool's Telegram alerts. If its `cron` job ever stops working, for example because the project's folder moved or its settings have a typo, all of that stops without a word. So at the end of each run, `ensure` checks in with Cronitor, and Cronitor alerts you when the check-ins stop. While all is well, Cronitor sends nothing.

The heartbeat is optional. Without a url, `ensure` doesn't check in. To set it up, first create a Cronitor account, as the project's [Cronitor Alerts](../README.md#cronitor-alerts) section describes. Then:

1. In Cronitor, create a job monitor, named for example `X1 Validator Private Rpc - ensure`, with these settings:
   - schedule `* * * * *`, every minute, like the `cron` line
   - a grace period of 60 seconds
   - an alert after three consecutive missed runs, so one lost check-in doesn't set it off
2. Copy the monitor's telemetry url, which looks like `https://cronitor.link/p/YOUR_CRONITOR_API_KEY/YOUR_MONITOR_KEY`. Treat it as a credential: anyone who has it can check in for you and hide an outage.
3. Add it to the project root's `.env` (see [Credentials](../README.md#credentials)):

   ```text
   X1_PRIVATE_RPC_CRONITOR_URL=https://cronitor.link/p/YOUR_CRONITOR_API_KEY/YOUR_MONITOR_KEY
   ```

4. Test it. Run `crontab -e`, and put a `#` in front of the line that runs `ensure`. Within about five minutes, Cronitor should alert you on Telegram. Then remove the `#`. Once the check-ins resume, Cronitor sends a recovery notice.

---

## Update

From the project root, get the new code and its packages, then run `apply`. It rewrites every file it gave `nginx`, and the tool's `cron` lines, wherever the new version writes them differently. It rewrites the tool's `git` hook when the hook names an old path to Node.js or to the tool. nginx.org's `apt` files stay as the first `apply` left them. It also turns private rpc back on, if you turned it off:

```bash
cd ~/x1-validator-services
git pull
npm ci --omit=dev --ignore-scripts
node x1-validator-private-rpc/src/cli.js apply
```

If you had turned private rpc off, run `turn-off-private-rpc` again once `apply` is done, since `apply` turned it back on.

`nginx` and its modules update with the system's other packages, whenever `apt upgrade` runs, as `x1console`'s Update X1 Validator does. The upgrade check above proved that safe.

---

## Uninstall

`undo-apply` undoes everything `apply` changed, newest first, until the machine is as `apply` found it. `apply` records each change it makes on the machine, such as a file or a firewall rule it adds, with what was there before, in `x1-validator-private-rpc/app-data/what-apply-changed.json`. `undo-apply` takes back only those changes. What was there before `apply`, such as a firewall rule you added, stays.

To make the rpc public for a while and keep everything else, use `turn-off-private-rpc` instead, as [Turn the Private Rpc Off and On](#turn-the-private-rpc-off-and-on) shows. `turn-off-private-rpc` keeps the certificate. `undo-apply` deletes it with `nginx`, so each later `apply` needs a new one, and Let's Encrypt issues at most five for one hostname in seven days.

If you set up the [Cronitor heartbeat](#cronitor-heartbeat), pause or delete its monitor first. Once the `cron` line goes, the check-ins stop, and Cronitor alerts you.

Look at what `undo-apply` would do first, then run it:

```bash
cd ~/x1-validator-services
node x1-validator-private-rpc/src/cli.js undo-apply --dry-run
node x1-validator-private-rpc/src/cli.js undo-apply
```

First it asks one question: whether to delete every api key, and the saved password with them when `apply` saved it. The keys and the saved password go together, since the password opens nothing but the keys' records. So a no keeps both. A later `apply` then hands `nginx` the same keys, and your clients' urls keep working. After a yes, a later `apply` makes a new first key under a new password, and every client needs a new url. Then it removes each of these that `apply` made:

- the `cron` lines and their folders
- the `git` hook
- the start-script flag and its backups
- `nginx`'s service, files and certificates, with its list of the api keys' hashes, whatever the answer
- the saved password, unless you kept it, and the folders made for it and for the api keys' file, once nothing else is in them
- the firewall rule
- `nginx` and its modules, with `nginx`'s logs and the account their package made
- nginx.org's `apt` repository
- the mask on `nginx.service`, which keeps the package's default site from running until `nginx` is gone

If you removed `nginx` yourself with `apt remove`, its configuration, certificates and logs may still be there, in `/etc/nginx`, `/var/cache/nginx` and `/var/log/nginx`. `undo-apply` leaves them, and says that `sudo apt purge nginx` would delete those folders, with anything else in them, if you want them gone.

If a step fails, it says so, and the step stays listed in `x1-validator-private-rpc/app-data/what-apply-changed.json`. After a no to the question, the saved password stays listed too, when `apply` saved it, with its folder and the folders that hold the api keys' file. Running `undo-apply` again retries every step still listed, and asks the question again while the api keys' file is there. Once nothing is left, it removes `app-data/`, with that file in it.

The running validator keeps a private rpc until its next start. Restart it from `x1console`, as in [Restart the Validator](#restart-the-validator), to open the rpc again.

---

## Usage

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

Nothing needs keeping running by hand: `nginx` runs under `systemd`, and `cron` runs `ensure` every minute and the key count check every few hours. Run a command when you need one:

| Command | What it does |
| --- | --- |
| `apply` | Sets everything up, asking before each stage. `--dry-run` only shows what it would do, and `--acme-staging` gets a staging certificate. |
| `ensure` | Puts `--private-rpc` back after an update, checks the setup, and sends the alerts. `--quiet` prints only what changed and the alerts sent. |
| `add-api-key` | Asks for the password and an optional email, makes an api key, and prints its urls, the only time any command shows it. `--count` makes several. |
| `remove-api-key` | Asks for an api key, which you paste, and removes it, so `nginx` refuses it. Removing the last key asks first. |
| `url` | Prints the url's two forms, with `KEY` in place of a key, and how many keys `nginx`'s list holds. |
| `ensure-there-is-at-least-one-rpc-api-key` | Checks that `nginx`'s list holds a key, and sends an alert when it doesn't. A `cron` job runs it every `apiKeyCountCheckHours` hours. `--quiet` prints only the alert. |
| `turn-off-private-rpc` | Takes `--private-rpc` out of the start script, after asking, and keeps `ensure` from putting it back. `--yes` skips the question. |
| `turn-on-private-rpc` | Puts `--private-rpc` back, for `ensure` to keep there again. |
| `undo-apply` | Undoes everything `apply` changed, newest first, and leaves what was there before. `--dry-run` only shows the steps. |

Each command answers `--help`, which ends with what each exit code means.

### Api Keys

Each client can have a key of its own. `add-api-key` first asks for your x1-validator-services password, which encrypts each key's record: when the key was made, and an email, for the rotation notices and billing to come. Then it asks for one email, which every key it makes gets, and shows what you type. Press Enter for none. Then it makes one key, or as many as `--count` says, up to the `maxApiKeys` setting, and prints each key's https and wss urls. That's the only time the tool shows a key: it keeps only the key's SHA-256 hash, so save the urls then.

```bash
node x1-validator-private-rpc/src/cli.js add-api-key --count 2
```

`remove-api-key` asks for a key, which you paste at a prompt that shows nothing, and removes it. It asks no x1-validator-services password. `nginx` refuses that key from then on, once it has reloaded. Removing the last key asks first, since `nginx` then refuses every request, and the key count check alerts you every few hours until `add-api-key` makes another:

```bash
node x1-validator-private-rpc/src/cli.js remove-api-key
```

Since `remove-api-key` needs the key itself, a key you no longer have stays valid until `undo-apply` deletes every key. A new or removed key takes effect once `nginx` has read its list again, which takes a moment, up to a second or two with very many keys. Each time it does, every open websocket closes within 10 seconds, and its client reconnects. A restart of `nginx`, or a reboot, changes nothing: `nginx` reads the list at its start, with no password.

Only one command changes the keys at a time. While `apply`, `undo-apply` or another key command is changing them, `add-api-key` and `remove-api-key` refuse, change nothing, and say to run them again.

Both commands may ask for your account's `sudo` password, after their own questions and before they change anything, so a wrong or cancelled one changes nothing. `remove-api-key` takes the key out of `nginx`'s list first, and out of `hashed-api-keys.json`, the file of the keys' hashes and their records, last. If it stops in between, for any reason, run it again before any other key command or `apply`. `add-api-key`, another `remove-api-key` and `apply` each write `nginx`'s list from the file, which still holds the key, so the removed key would work again. The architecture's [The Keys' Path](docs/architecture.md#the-keys-path) says more.

### Check

`check-my-private-rpc` tries your keyed url once, the way a client would. It asks for the rpc's hostname and the api key, and doesn't show the key as you type it. Then it sends the rpc a run of queries through `nginx`, one right after another, and prints a table of the answers. It ends with a green ✔ when every query worked, or a red ✘ and what went wrong.

Run it from the project root, on the validator or on any machine where the project is installed:

```bash
node x1-validator-private-rpc/util/check-my-private-rpc/index.js
```

The url `apply` or `add-api-key` printed holds both answers: the hostname, and after it the key. The `checkQueryCount` setting sets how many queries the check sends.

### After an `x1console` Update

An Update X1 Console takes `--private-rpc` out of the start script, and the tool puts it back on its own, through its `git` hook or its `cron` job. Meanwhile the running validator keeps its private rpc, since it read its flags when it started. Only a restart while the flag is out would start it with a public rpc.

Update X1 Console runs `git stash`, then `git pull`. The flag is the tool's own edit to an `x1console` file. Nobody commits that edit, so the stash takes it out. When the pull merges new commits, `git` runs the tool's `git` hook, which puts the flag back before the update finishes. A pull with nothing new merges nothing, so `git` runs no hook. In that case, the `cron` job's `ensure` puts the flag back. It waits until the script has gone unchanged for `startScriptQuietSeconds`, 30 seconds as shipped, so that it never edits the script in the middle of an update. Since the `cron` job runs once a minute, the flag is back 30 to 90 seconds after the update. Either way, `ensure` sends an alert that it put the flag back.

Without the `cron` job, run `ensure` yourself after each update, once `startScriptQuietSeconds` has passed, since a sooner run leaves the script alone.

Update X1 Validator restarts the validator, so the start script must carry the flag before you choose it. Even with the `cron` job, the flag can be out for up to 90 seconds after an Update X1 Console. So before Update X1 Validator, run `ensure`, and check that it says the start script carries `--private-rpc`. The architecture's [`x1console`'s Updates and Autopilot's Restarts](docs/architecture.md#x1consoles-updates-and-autopilots-restarts) explains the short windows when the script lacks the flag.

### Turn the Private Rpc Off and On

`turn-off-private-rpc` takes `--private-rpc` out of the start script, after asking, so the rpc listens on every interface again from the validator's next start. Everything else stays: `nginx` keeps serving the keyed url, and `ensure` keeps checking `nginx` and its certificate. But `ensure` no longer puts the flag back, and no longer checks that the rpc is private, until `turn-on-private-rpc` puts the flag back:

```bash
node x1-validator-private-rpc/src/cli.js turn-off-private-rpc
node x1-validator-private-rpc/src/cli.js turn-on-private-rpc
```

Neither restarts the validator. Restart it as in [Restart the Validator](#restart-the-validator), for the change to take effect. Running `apply` again turns private rpc on too, as [Update](#update) notes. If `ensure` is changing the start script at the moment you answer, `turn-off-private-rpc` refuses, changes nothing, and says to run it again.

### Alerts

`ensure` sends its alerts on Telegram through `x1console`'s bot, as plain text, naming your hostname and the event, never a secret. Each of the four problems at the top of the table alerts when it starts, repeats as the table's last column says, and sends a recovery notice when it ends. The key count check, `ensure-there-is-at-least-one-rpc-api-key`, sends its own alert, through the same bot.

| Alert | When | Repeats |
| --- | --- | --- |
| The rpc is public | The rpc listens on an address other than 127.0.0.1 | Every `exposedReminderMinutes` |
| The flag is missing | The start script lacks `--private-rpc`, and `ensure` couldn't put it back | Every `exposedReminderMinutes` |
| `nginx` is down | `nginx` isn't active | No |
| The certificate needs attention | Under `certificateWarningDays` left, or the tls check fails | Every `certificateReminderHours` |
| The flag is back | `ensure` put `--private-rpc` back after an update | No |
| No api key | `nginx`'s list holds no key, so `nginx` refuses every request | Every `apiKeyCountCheckHours`, while the list stays empty |

The first two stay quiet while private rpc is off, as [Turn the Private Rpc Off and On](#turn-the-private-rpc-off-and-on) explains, and before `apply` has added the flag. An alert from `ensure` that Telegram doesn't take goes out at the next run. Without `x1console`'s Telegram files, both commands only log.

Two checks send no alert: the running validator's flag, and what listens on ports 80 and 443. Their problems show only in the output and the exit code of an `ensure` you run yourself, without `--quiet`. The `cron` job runs it with `--quiet`, which leaves them out of its log.

---

## Configure

Your settings go in `x1-validator-private-rpc/app-config/user-configurable/private-rpc.json`. Its [README](app-config/user-configurable/README.md) says what the file holds, and where every setting is described. One you may want to change is `rateLimitRequestsPerSecond`, `nginx`'s limit on keyed requests, which all keys share. Run `apply` again after a change, to rewrite `nginx`'s configuration.

After changing `hashedApiKeysMapPath`, run `apply` straight away, with no other command of the tool before it. Until `apply` rewrites `nginx`'s configuration, `nginx` keeps reading its list of the keys' hashes at the old path, while the tool's other commands use the new path at once. So `remove-api-key` would write a list that `nginx` doesn't read, and the removed key would keep working.

To move the api keys' file, move the file itself first, then change `hashedApiKeysPath`, then run `apply`. With no file at the new path, `apply` takes the machine for a first install: it makes a new first key under a new password, and hands `nginx` a list that holds only that key. Every key your clients hold then stops working.

Non-standard settings for the programs the tool uses, such as `nginx`, aren't fully supported. A non-default `acmeStatePath`, this tool's setting for the folder where `nginx` keeps its certificates, is one example. There, the only gap is that when you uninstall or start over, `undo-apply` leaves that folder's files behind.

The Cronitor url is a credential, so it goes in the project root's `.env` instead, as [Cronitor Heartbeat](#cronitor-heartbeat) shows.

[examples/](examples/README.md) holds an example of each file `apply` renders, with placeholders for your values.

---

## Test

The tests are for changing the tool, on a development machine. A validator never runs them, and using the tool needs none.

Run tests from the project root, as the project's [Install](../README.md#install) section says for every `npm` command. Only the system test, `npm run test:system`, needs LXD. It runs the tool for real, in a throwaway Ubuntu 24.04 container on your development machine, never on a validator. The project's [engineering reference](../docs/engineering.md#the-system-test) says what it checks.

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

- **Hashes for `nginx`.** `nginx` keeps only each key's SHA-256 hash, in `/etc/nginx/x1-validator-private-rpc/hashed-api-keys.map`, and checks a request by hashing the key it carries. A random 256-bit key can't be worked back from its hash. Even with the list at its 500,000 limit, an even chance of finding any one key would take about 5×10⁴² years at the whole Bitcoin network's rate. So nothing on the validator holds a usable key, and `nginx` needs no password, at a start or ever.
- **Shown once.** The tool shows each key when it makes it, and never again. A key is never a command's argument, so no other user sees it in a process list.
- **Encrypted records.** `~/.config/x1-validator-services/hashed-api-keys.json` holds each key's hash, unencrypted, with its record. Only your account can read it, and its folder is one that future validator services can share. Every value of a record is encrypted with your x1-validator-services password, the way [LP Ranger](https://github.com/nottoseethesun/lp-ranger)'s command-line version stores private keys: AES-256-GCM, with its key from PBKDF2-SHA-512 at 600,000 iterations.
- **No key in the logs.** `nginx`'s logs show `<key>` in place of anything that looks like a key, anywhere in the url, a mistyped one included. They're `nginx`'s usual `access.log` and `error.log`, in `/var/log/nginx`, and they hold each client's address. Root, `nginx` and the `adm` group can read them, as with any `nginx` from nginx.org's package. The package's `logrotate` rule keeps 52 days of them. The part of `nginx`'s configuration that forwards keyed requests writes no error log, since each error line would carry the key: it sends them to `/dev/null`. A side effect is one expected `[emerg] chown("/dev/null", …) failed` line in `nginx`'s error log each night, as [The Request Path](docs/architecture.md#the-request-path) explains.
- **A saved password.** `systemd` encrypts it, with the machine's TPM2 chip when it has a usable one. Without a chip, the key that decrypts it sits on the same disk, so a copy of the disk gives it up. `apply` says which case applies before it asks.
- **A lost password.** If you saved it, root can read it back: `sudo systemd-creds decrypt --name=x1-validator-services-password /etc/credstore.encrypted/x1-validator-services-password -`. If you didn't, it can't be recovered, and nothing can read the records without it. The keys keep working, since `nginx` needs only their hashes, but `add-api-key` needs the password. To start over, run `undo-apply`, and let it delete every key. Then run `apply`, which makes a new first key under a new password, and make each client a key of its own with `add-api-key`.

---

## Development

For an overview of how the tool works, see **[`docs/architecture.md`](docs/architecture.md)**. It covers the parts the tool arranges on the validator, the path of a request and of the keys, and who restarts what.

For engineering details, see **[`docs/engineering.md`](docs/engineering.md)**. It covers the modules, apply's record, every file the tool reads and writes, the order its commands do things in, and the tests.

For how the whole project is checked, see the project's [`docs/engineering.md`](../docs/engineering.md), and for every `npm` command, [`docs/npm-project-commands.md`](../docs/npm-project-commands.md).
