# x1-validator-private-rpc

![A bronze-armored X1 defender robot with teal eyes holds up a glowing key beside a door marked 443, while shadowy figures stand behind a red line on the floor. At center, a round vault door marked 8899 frames a glowing core whose teal beam falls to the floor. Through a viewport, a bright streak and a storm of sparks cut across space beside a planet. Inspired by Isaac Asimov's story "Reason" (Astounding Science Fiction, 1941; collected in I, Robot).](../assets/images/x1-defender-robot.png "X1 Defender Robot")

## Overview

`x1console` starts an X1 validator with its full rpc open on port 8899, on every network interface, and advertised to the network. So anyone on the internet can query it, and each query competes with voting for the machine's cpu and bandwidth.

x1-validator-private-rpc makes the rpc private, and puts it behind an https url that carries an api key: the keyed url, such as `https://x1-rpc.example.com/KEY`. It's a command-line tool that you run on the validator, and for now it works only with [`x1console`](https://github.com/BlackBeard085/x1console/tree/main). It's the first feature of X1 Validator Services, a project of tools that run on an X1 validator.

The tool's `apply` command sets everything up, in stages, asking before each one that changes something. Its other commands manage the api keys, keep the rpc private, turn private rpc off and on, and take back what `apply` changed:

- `apply` adds `--private-rpc` to `x1console`'s start script, so the rpc listens on 127.0.0.1 alone from the validator's next start, and is no longer advertised.
- `apply` also puts `nginx`, from nginx.org, in front of the rpc, on the validator's public address and port 443 alone. `nginx` forwards only requests whose path starts with one of the keys, and refuses every other one with a 403 before it reaches the validator. Keyed requests beyond a rate limit you can set, which all keys share, get 429 Too Many Requests. `nginx` gets and renews its certificate from Let's Encrypt through port 443, so port 80 stays closed.
- Each client can have an api key of its own: `apply` makes the first, `add-api-key` makes more, and `remove-api-key` takes one away. `nginx` keeps only each key's SHA-256 hash, and checks a request by hashing the key it carries. A hash can't be worked back into its key, so `nginx`'s list of hashes is kept unencrypted, and `nginx` reads it with no password. So a restart of `nginx`, or a reboot, needs nobody to type one. The tool stores only each key's hash, never the key itself. So the one time it can show you a key is when it makes the key: it prints the key's two urls, https and wss, with the key in them. Copy them then, to give to the client, since no command can show the key again. Each key has a record, with when it was made and an optional email, encrypted with an x1-validator-services password you choose during `apply`.
- `ensure` keeps the rpc private. It's the command that keeps `--private-rpc`, the flag, in `x1console`'s start script, and alerts you on Telegram when something is wrong. The start script is a file in `x1console`'s `git` checkout. `x1console`'s menu entry Update X1 Console runs `git stash` there, then `git pull`. The stash removes every edit nobody committed, the flag included. So `apply` puts the tool's `git` hook in that checkout. When the update's `git pull` brings new commits, `git` runs the hook, which has `ensure` put the flag back at once. A pull with nothing new runs no hook, so `apply` also offers a `cron` job that runs `ensure` every minute. After such a pull, the `cron` job's `ensure` leaves the start script alone until the script has gone unchanged for 30 seconds, as shipped in the tool's settings. The first run after that puts the flag back. So the flag is back 30 to 90 seconds after the update. [After an `x1console` Update](#after-an-x1console-update) says why it holds off, and what to do without the `cron` job.
- `ensure` alerts you when the rpc turns public, the flag can't go back, `nginx` is down, or the certificate needs attention. While `nginx`'s list of the keys' hashes is empty, as after `remove-api-key` takes the last key, `nginx` refuses every request. The key count check, the command `ensure-there-is-at-least-one-rpc-api-key`, alerts you then. A second `cron` job, which `apply` offers with the first, runs it every two hours, as shipped.
- To make the rpc public again without uninstalling the tool, `turn-off-private-rpc` makes it public from the validator's next start, and leaves everything else in place. `turn-on-private-rpc` makes it private again.
- To uninstall the tool, `undo-apply` takes back what `apply` changed, except that it leaves `nginx` installed, since something else may need it. It says how to remove `nginx` too.

Two standalone tools come with the tool, apart from its commands. Once the tool is installed, `nginx` updates with the system's other packages, so an `apt` upgrade of `nginx` must keep the keyed url working. `validate-nginx-upgrade` proves that on this machine, with a throwaway api key, then removes everything it added. You run it once, as the first install step, before `apply`. `check-my-private-rpc` queries your keyed url as a client would, from any machine with the project installed, to check that it works, such as after the validator's restart.

The engineering reference's [Integration with `x1console`](docs/engineering.md#integration-with-x1console) details where the tool and `x1console` meet: the start script, the `git` hook and the Telegram set-up.

The tool never restarts the validator. `x1console`'s scripts and its pinger query the rpc on 127.0.0.1, with no key. The rpc still listens there under `--private-rpc`, and `nginx` listens only on the public address, so those queries reach the rpc as before.

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

Each run that can change the system shows this disclaimer before it does anything, in a dialog that `whiptail` draws, which takes over the terminal like the ones packages show as they install. The run goes on only once you choose Affirm, which affirms "I have read and understood the above Disclaimer." Decline, or Esc, stops it with nothing changed, and Ctrl-C does nothing there. Decline has the focus at first. The left and right arrows move between the two buttons, Tab also moves to the text, where the up and down arrows and PgUp and PgDn scroll it, and Enter chooses. Runs that change nothing don't show it: the dry runs, and the commands that only check or print. Neither does `ensure`, which `cron` and the tool's `git` hook run with nobody at the terminal.

---

## Prerequisites

- An X1 validator set up by `x1console`, on Ubuntu 24.04 or later.
- Node.js 24 or newer, as `engines`, `>=24`, in the project's `package.json` says. CI tests the two long-term-support majors in that range, 24 and 26. `x1console` installs Node.js 20.0.0 for its own scripts, and that version is too old for the tool. `x1console` installs it with `nvm`, the Node.js version manager, which holds several versions side by side. So the project's [Get the Code](../README.md#get-the-code) step adds Node.js 24 beside it, and the tool runs on 24, the older of the two majors, since a validator can't always move to the newest at once.
- The project's code on the validator, as the project's [Install](../README.md#install) section describes.
- The validator's account, with `sudo`.
- The validator's public ipv4 address on one of its own interfaces. Servers behind address translation aren't supported.
- Port 443 free on the validator, not closed by a `ufw` rule, and no `nginx` installed there, unless an earlier `apply` installed it.
- A domain you own, where you can add a dns record.
- For the alerts, `x1console`'s Telegram alerts, set up in `x1console`.

### System Programs

The tool works through a set of system programs, which the engineering reference's [Dependencies](docs/engineering.md#dependencies) section lists, with what the tool does with each. A stock Ubuntu 24.04 server has them all but three: `x1console` brings `nvm`, the project's [Get the Code](../README.md#get-the-code) step adds Node.js 24 with it, and `apply` installs `nginx`. Where they come from is why the tool needs Ubuntu. `apt` and `dpkg` come from the Debian distribution of Linux, and its family of distributions shares them. `ufw` comes from Ubuntu, one of that family, and the nginx.org packages that the tool installs are nginx.org's builds for Ubuntu. Ubuntu also installs `whiptail` with the system, and the tool draws its disclaimer's dialog with it. The tool will not work without these, and also, will not work without `systemd`. The rest are common to Linux systems that run `systemd`.

---

## Install

> **Never point the validator's own `solana` cli at the keyed url, or at the validator's own address.** On the validator, don't set the cli's rpc url to anything that contains the tool's hostname (`x1-rpc.example.com` in these docs) or the validator's public address, whether from `x1console`'s network menu or with `solana config set --url`. Autopilot's health check uses that url, and answers a failed check by deleting the ledger and restarting the validator. Under `--private-rpc`, the rpc no longer answers on the validator's address. The keyed url can stop answering too, for example while `nginx` restarts, or once its last key is removed. `apply` stops at its first check, changing nothing, while the cli's url names either.

**Start every command that runs one of the tool's `.js` files with `nvm exec 24`,** as each command below does. On a validator, the default `node` is Node.js 20.0.0, which `x1console` installed, and it's too old for the tool. `nvm exec 24` runs one command on Node.js 24 instead. Once you've linked the tool's launcher, a small script that starts the tool on Node.js 24, into `~/.local/bin`, as [Usage](#usage) shows, typing the tool's name needs no prefix.

### Check That `nginx` Upgrades Keep Working

Once the tool is installed, `nginx` updates with the system's other packages, whenever `apt upgrade` runs, as `x1console`'s Update X1 Validator does. This check, the standalone tool `validate-nginx-upgrade`, proves on this machine that such an upgrade keeps the keyed url working. Run it first, before anything else of the tool is installed. It installs nginx.org's previous release, runs it under `systemd` the way the tool will, with a throwaway api key, and upgrades it with `apt`. nginx.org's upgrade starts a new `nginx` process and hands over to it, without a restart. `systemd` knows `nginx` by its main process, so it must follow that handover. The check makes sure it did: `systemd` still counts `nginx` as running, now as the new process, with no restart. It also makes sure the new `nginx` still lets the throwaway key through and turns a random one away. Last, it removes everything it added. It never touches Tachyon, port 443 or the firewall.

It takes a few minutes. Run it inside `tmux`, so that a dropped `ssh` connection can't stop it halfway and leave `nginx` installed. If the connection drops, log in again and run `tmux attach` to get back to it. Run it as the validator's account, from the project root, on Node.js 24 through `nvm exec 24`, as for every command in these steps. It asks for your `sudo` password:

```bash
tmux
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/util/validate-nginx-upgrade/index.js
```

It ends with `Passed`, or with the reasons it failed. If it ever can't remove something it added, it lists that step with a `By hand:` command that does the same. Run those commands in the order listed, then run it again. To stop it early, press Ctrl-C: it finishes the step it's on, then removes everything it added. Type `exit` afterwards to leave `tmux`. Go on with the install only once it passes.

### Point the Hostname at the Validator

Add one `A` record at your dns provider: a new name under your domain, such as `x1-rpc.example.com`, with the validator's public ipv4 address. [Manual Domain Setup](docs/manual-domain-setup.md) shows how, for form-based and raw zone-file editors, and how to check the record.

### Set the Hostname

The tool reads your settings from one file, which holds only the settings you change. From the project root, make it from the example:

```bash
cp x1-validator-private-rpc/app-config/app-defaults-for-user-configurable/private-rpc.example.json \
   x1-validator-private-rpc/app-config/user-configurable/private-rpc.json
```

Then, in the copy, set `hostname` to the name from the last step, and `publicIp` to the validator's public ipv4 address, which `nginx` listens on. Or delete `publicIp`, to use the address the X1 network sees for your validator. Set `acmeEmail` to a contact address for Let's Encrypt, or delete it for none. [Configure](#configure) says more.

### Run apply

`apply` works in eight stages. Stage 1 checks the machine, and changes nothing. If it finds problems, it lists them all and stops. Otherwise it goes through stages 2 to 7, asking "Go on?" before each one:

- stage 2: `nginx` from nginx.org
- stage 3: the firewall rule for port 443
- stage 4: the first api key and your password
- stage 5: `nginx`'s configuration and start
- stage 6: the start-script flag
- stage 7: the `git` hook, then, after a question of their own, the `cron` jobs that run `ensure` and the key count check

Stage 8 changes nothing: it says whether to restart the validator, and prints the url.

At its stage for the first api key, `apply` asks for a new x1-validator-services password, typed twice, with at least as many characters as the `passwordMinLength` setting says. The password encrypts the api keys' records, never the keys, which the tool doesn't keep. The records, each beside its key's hash, go in the api keys' file, `~/.config/x1-validator-services/hashed-api-keys.json`. Then `apply` makes the first api key, and prints its two urls, https and wss, in full. **Save them now**: the tool keeps only the key's hash, and can't show the key again.

Then it asks whether to save the password, which `systemd` keeps encrypted. Nothing reads a saved password yet. It's there so that features to come can read the records unattended: billing, and rotation notices, which will email a key's client when the key is due to be replaced. `nginx` never needs it. Before it asks, it says whether `systemd` can tie a saved password to this machine's TPM2 chip, and what that means, as [Api Key Security](#api-key-security) explains.

`--yes` answers yes to each stage's question and to the question about the `cron` jobs. You still type the password, and answer the save question.

First have a look at what `apply` would do. The dry run changes nothing:

```bash
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply --dry-run
```

Then run it inside `tmux`, as with the upgrade check, with `--acme-staging` the first time. That gets the certificate from Let's Encrypt's staging service, which no client trusts. A mistake such as a dns record Let's Encrypt can't see yet makes the request for the certificate fail, and Let's Encrypt allows only five failed requests an hour for one hostname. Failures at the staging service don't count toward that limit:

```bash
tmux
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply --acme-staging
```

Once the staging run has finished, run `apply` again without `--acme-staging`, for the real certificate. It changes only `nginx`'s configuration, keeps the key, and asks for no x1-validator-services password:

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply
```

Every stage first checks whether its work is done, so running `apply` again changes nothing that's in place. If it stops partway, run it again, and it picks up from there. If `nginx` refuses a new configuration, `apply` puts the old one back, so `nginx` runs as before. It keeps what `nginx` refused, and why, in `x1-validator-private-rpc/logs/error.log`. A key it made and showed stays, so the next run makes none. On a first install, `apply` asks whether to save the password only right after it makes the first key. So if `apply` stops at that question, say with Ctrl-C, no later run asks it again, and the password stays unsaved. If you stop `apply` before its flag stage, `ensure` doesn't add the flag either: it leaves the start script alone until `apply` has added it.

### Restart the Validator

The validator takes `--private-rpc` at its next start. `apply` never restarts it. In `x1console`, choose 2. Validator, then 1. Start/Restart Validator, at a moment when the Validator screen shows no leader slot coming soon. The keyed url works before the restart too: `nginx` forwards to the rpc on 127.0.0.1, and until the restart the rpc listens on every interface, 127.0.0.1 among them.

After the restart, check from another machine that the rpc no longer answers on the validator's address. This should fail to connect:

```bash
curl -m 5 http://203.0.113.10:8899/health
```

Replace `203.0.113.10` with the validator's address. Then check the keyed url with `check-my-private-rpc`, as [Check](#check) describes. It's a separate script, not one of the tool's commands, and it queries the url as a client would. It asks for the key without showing it, so the key stays out of your shell's history.

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

From the project root, get the new code with `git pull`. Then add Node.js 24, and install the tool's Node.js packages on it with `npm ci`, as the project's [Get the Code](../README.md#get-the-code) does. `nvm install 24` adds Node.js 24 when it's missing, and otherwise moves it to its newest release. Last, run `apply` on Node.js 24, right after the pull:

```bash
cd ~/x1-validator-services
git pull
nvm install 24
nvm exec 24 npm ci --omit=dev --ignore-scripts
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply
```

`apply` rewrites every file it gave `nginx`, and the tool's `cron` lines, wherever the new version writes them differently. nginx.org's `apt` files stay as the first `apply` left them. The `cron` lines start `ensure` and the key count check, and the tool's `git` hook starts `ensure`. Each names, by its full path, the Node.js that ran `apply`. So `apply` also rewrites the lines and the hook when they name another Node.js, or an old path to the tool. When an update raises the Node.js major the tool needs, lines that name the older one start a tool that stops at once. No flag goes back, and no alert goes out, until `apply` rewrites them. That's why `apply` runs right after the pull.

If you've linked the tool into `~/.local/bin`, so you can type its name, as [Usage](#usage) shows, check that the link points at the tool's launcher: a small script, `x1-validator-private-rpc/bin/x1-validator-private-rpc`, that runs the tool on the newest Node.js 24 `nvm` holds. `readlink ~/.local/bin/x1-validator-private-rpc` shows where it points. A link to `src/cli.js` starts the tool on the validator's default `node`, Node.js 20.0.0, where it stops and says how to run it. This points the link at the launcher:

```bash
ln -sf ~/x1-validator-services/x1-validator-private-rpc/bin/x1-validator-private-rpc ~/.local/bin/x1-validator-private-rpc
```

If you had turned private rpc off, run `turn-off-private-rpc` again once `apply` is done, since `apply` turned it back on.

`nginx`, and the two nginx.org modules it runs, update with the system's other packages, whenever `apt upgrade` runs, as `x1console`'s Update X1 Validator does. The njs module hashes each request's key, and the ACME module gets and renews the certificate. The upgrade check above proved, on this machine, that such an upgrade keeps the keyed url working.

---

## Uninstall

`undo-apply` takes back what `apply` changed, newest first. `apply` records each change it makes on the machine, such as a file or a firewall rule it adds, with what was there before, in `x1-validator-private-rpc/app-data/what-apply-changed.json`. `undo-apply` takes back only those changes. What was there before `apply`, such as a firewall rule you added, stays. It never removes a package, since something else may need it, so `nginx` stays installed, as below.

To make the rpc public for a while and keep everything else, use `turn-off-private-rpc` instead, as [Turn the Private Rpc Off and On](#turn-the-private-rpc-off-and-on) shows. `nginx` then keeps serving the keyed url, which `undo-apply` stops.

If you set up the [Cronitor heartbeat](#cronitor-heartbeat), pause or delete its monitor first. Once the `cron` line goes, the check-ins stop, and Cronitor alerts you.

Look at what `undo-apply` would do first, then run it:

```bash
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/src/cli.js undo-apply --dry-run
nvm exec 24 node x1-validator-private-rpc/src/cli.js undo-apply
```

First it asks one question: whether to delete every api key, and the saved password with them when `apply` saved it. The keys and the saved password go together, since the password opens nothing but the keys' records. So a no keeps both. A later `apply` then hands `nginx` the same keys, and your clients' urls keep working. After a yes, a later `apply` makes a new first key under a new password, and every client needs a new url. Then `undo-apply` removes each of these that `apply` made:

- the `cron` lines, and the tool's `tmp/` and `logs/` folders, with `ensure`'s log and the tool's error log in them
- the `git` hook
- the start-script flag and its backups
- the files the tool gave `nginx`, with its list of the api keys' hashes, whatever the answer
- the saved password, unless you kept it, and the folders made for it and for the api keys' file, once nothing else is in them
- the firewall rule

`undo-apply` takes out the `--private-rpc` flag that `apply` added to the start script. The running validator keeps the rpc it started with until its next start. Unless it already runs without the flag, `undo-apply` says that its next start makes the rpc public. A flag `apply` didn't add stays, and `undo-apply` says so instead. You may have added it by hand, or with `turn-on-private-rpc` after an `apply` that stopped before stage 6, its flag stage. To have it gone, take it out of the start script by hand, after `undo-apply`. Once the start script carries no `--private-rpc`, restart the validator from `x1console` to make the rpc public, as in [Restart the Validator](#restart-the-validator).

`undo-apply` stops, disables and masks `nginx`, but leaves it installed, with its two modules. With the files the tool gave it gone, a start of `nginx` would run the package's own configuration, `/etc/nginx/nginx.conf`, and its default site. The mask stops anything from starting it. `nginx`'s configuration in `/etc/nginx`, its certificates in `/var/cache/nginx`, its logs in `/var/log/nginx`, its account and nginx.org's `apt` repository stay too. `nginx`'s packages, its account, nginx.org's repository and the mask stay listed in `x1-validator-private-rpc/app-data/what-apply-changed.json`. A later `apply` refuses an installed `nginx` unless that file shows `apply` installed it. With these entries, a later `apply` takes this `nginx` as its own, and reuses its certificate. `undo-apply` says all this as it runs.

If you want `nginx` gone, purge it, then run `undo-apply` again, which removes `nginx`'s account, nginx.org's repository and the mask:

```bash
cd ~/x1-validator-services
sudo apt-mark unhold nginx   # only if you hold it
sudo apt purge nginx nginx-module-njs nginx-module-acme
nvm exec 24 node x1-validator-private-rpc/src/cli.js undo-apply
```

If you removed `nginx` yourself with `apt remove` before running `undo-apply`, its configuration, certificates and logs may still be there. `undo-apply` leaves them. If you want them gone, `sudo apt purge nginx` deletes those folders, as `undo-apply` says.

Whatever a run of `undo-apply` doesn't take back stays listed in `x1-validator-private-rpc/app-data/what-apply-changed.json`, for a later run. A step that fails stays listed, and `undo-apply` says so. After a no to the question, the api keys' file stays, so the folders `apply` made for it stay listed. So do the saved password, if `apply` saved it, and its folder. Running `undo-apply` again retries the failed steps, and asks the question again while the api keys' file is there. Once nothing is left, `undo-apply` removes `app-data/`, with that file in it.

---

## Usage

Run the tool as the validator's account, from the project root, on Node.js 24:

```bash
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/src/cli.js --help
```

To type it by name from anywhere, link its launcher into `~/.local/bin`, which Ubuntu's default profile puts on your PATH from your next login. The launcher, `x1-validator-private-rpc/bin/x1-validator-private-rpc`, runs the tool on the newest Node.js 24 that `nvm` holds. So `x1-validator-private-rpc COMMAND` does the same as `nvm exec 24 node x1-validator-private-rpc/src/cli.js COMMAND` in the project root:

```bash
mkdir -p ~/.local/bin
ln -sf ~/x1-validator-services/x1-validator-private-rpc/bin/x1-validator-private-rpc ~/.local/bin/x1-validator-private-rpc
```

Nothing needs keeping running by hand: `nginx` runs under `systemd`, and `cron` runs `ensure` every minute and the key count check every few hours. Run a command when you need one: the sections below show the common ones. [`docs/project-commands.md`](docs/project-commands.md) lists every command, with its options and an example of each common use. So does each command's `--help`, which also says what each exit code means.

### Api Keys

Each client can have a key of its own. `add-api-key` makes one key, or as many as `--count` says. It checks that the api keys' file has room for them under the `maxApiKeys` setting, and refuses if it hasn't. Then it asks for your x1-validator-services password, which encrypts each key's record: when the key was made, and an email, for the rotation notices and billing to come. Then it asks for one email, showing what you type, and gives it to every key it makes. Press Enter for none. Last, it makes the keys, and prints each key's https and wss urls. That's the only time the tool shows a key: it keeps only the key's SHA-256 hash, so save the urls then.

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js add-api-key --count 2
```

`remove-api-key` asks for a key, which you paste at a prompt that shows nothing, and removes it. It asks no x1-validator-services password. Since it needs the key itself, a key you no longer have stays valid until `undo-apply` deletes every key. Removing the last key asks first, since `nginx` then refuses every request, and the key count check alerts you every few hours until `add-api-key` makes another:

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js remove-api-key
```

Both commands then reload a running `nginx`, so it reads its list again. A new key works, and a removed one stops working, once that's done. It takes a moment, up to a second or two with very many keys. A reload leaves the connections already open with `nginx`'s old worker process, and a websocket's key is checked only when it opens. So a removed key's websocket would stay open. To end it, the tool has the old worker close whatever it still holds 10 seconds after the reload. So after each change, every open websocket closes within 10 seconds, and its client must reconnect. A restart of `nginx`, or a reboot, needs nothing from you: `nginx` reads the list at its start, with no password.

Only one command changes the keys at a time. While `apply`, `undo-apply` or another key command is changing them, `add-api-key` and `remove-api-key` refuse, change nothing, and say to run them again.

Both commands may ask for your account's `sudo` password, after their own questions and before they change anything, so a wrong or cancelled one changes nothing.

If `remove-api-key` stops part way, for any reason, run it again with the same key, before any other key command or `apply`. It takes the key out of `nginx`'s list first, and out of the api keys' file, `hashed-api-keys.json`, last. So a stop in between leaves the key in that file. `add-api-key`, `remove-api-key` for another key, and `apply` each write `nginx`'s list from the file, and would hand the removed key back to `nginx`. The architecture's [The Keys' Path](docs/architecture.md#the-keys-path) says more.

### Check

`check-my-private-rpc` checks once that your keyed url works for a client, such as after the validator's restart, or when a client reports a problem. It asks for the rpc's hostname and the api key, and doesn't show the key as you type it. Then it sends the rpc a run of queries through `nginx`, one right after another, and prints a table of the answers. It ends with a green ✔ when every query worked, or a red ✘ and what went wrong.

Run it from the project root, on the validator or on any machine where the project is installed. It needs Node.js 24 or newer. On a machine without `nvm`, start it with such a `node` in place of `nvm exec 24 node`:

```bash
nvm exec 24 node x1-validator-private-rpc/util/check-my-private-rpc/index.js
```

The url `apply` or `add-api-key` printed holds both answers: the hostname, and after it the key. The `checkQueryCount` setting sets how many queries the check sends.

### After an `x1console` Update

An Update X1 Console takes `--private-rpc` out of the start script, and the tool puts it back on its own, through its `git` hook or its `cron` job. Meanwhile the running validator keeps its private rpc, since it read its flags when it started. Only a restart while the flag is out would start it with a public rpc.

Update X1 Console runs `git stash`, then `git pull`. The flag is the tool's own edit to an `x1console` file. Nobody commits that edit, so the stash takes it out. When the pull merges new commits, `git` runs the tool's `git` hook, which puts the flag back before the update finishes. A pull with nothing new merges nothing, so `git` runs no hook. In that case, the `cron` job's `ensure` puts the flag back. An `ensure` from `cron` can't tell, while an update runs, whether its pull will change the start script. If it does, an edit made after the stash makes the pull refuse, since `git` won't overwrite an edit nobody committed. So `ensure` leaves the script alone until it has gone unchanged for `startScriptQuietSeconds`, 30 seconds as shipped. The stash changes the script, and the pull usually ends a few seconds later, so by then the update is done. Since the `cron` job runs once a minute, the flag is back 30 to 90 seconds after the update. Either way, `ensure` sends an alert that it put the flag back.

Without the `cron` job, run `ensure` yourself after each update, once `startScriptQuietSeconds` has passed, since a sooner run leaves the script alone.

Update X1 Validator restarts the validator, so the start script must carry the flag before you choose it. Even with the `cron` job, the flag can be out for up to 90 seconds after an Update X1 Console. So before Update X1 Validator, run `ensure`, and check that it says the start script carries `--private-rpc`. The architecture's [`x1console`'s Updates and Autopilot's Restarts](docs/architecture.md#x1consoles-updates-and-autopilots-restarts) explains the short windows when the script lacks the flag.

### Turn the Private Rpc Off and On

`turn-off-private-rpc` takes `--private-rpc` out of the start script, after asking, so the rpc listens on every interface again from the validator's next start. Everything else stays: `nginx` keeps serving the keyed url, and `ensure` keeps checking `nginx` and its certificate. But `ensure` no longer puts the flag back, and no longer checks that the rpc is private, until `turn-on-private-rpc` puts the flag back:

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js turn-off-private-rpc
nvm exec 24 node x1-validator-private-rpc/src/cli.js turn-on-private-rpc
```

Neither restarts the validator. Restart it as in [Restart the Validator](#restart-the-validator), for the change to take effect. Running `apply` again turns private rpc on too, as [Update](#update) notes. If `ensure` is changing the start script at the moment you answer, `turn-off-private-rpc` refuses, changes nothing, and says to run it again.

`turn-off-private-rpc` takes out only the flag the tool adds, at the end of the `--rpc-port` line. A flag anywhere else in the start script, such as one you added by hand on a line of its own, stays. Then the rpc stays on 127.0.0.1 after the validator's next start, and `turn-off-private-rpc` says so. To make the rpc public, take that flag out of the start script by hand, then restart the validator.

### Alerts

`ensure` sends its alerts on Telegram through `x1console`'s bot, as plain text, naming your hostname and the event, never a secret. Each of the four problems at the top of the table alerts when it starts, repeats as the table's last column says, and sends a recovery notice when it ends. The key count check, `ensure-there-is-at-least-one-rpc-api-key`, sends its own alert, through the same bot.

| Alert | When | Repeats |
| --- | --- | --- |
| The rpc is public | The rpc listens on an address other than 127.0.0.1 | Every `exposedReminderMinutes` |
| The flag is missing | The start script lacks `--private-rpc`, and `ensure` couldn't put it back | Every `exposedReminderMinutes` |
| `nginx` is down | `nginx` isn't active | No |
| The certificate needs attention | Under `certificateWarningDays` left, issued for another name, or `ensure` can't read it from `nginx` over tls | Every `certificateReminderHours` |
| The flag is back | `ensure` put `--private-rpc` back after an update | No |
| No api key | `nginx`'s list holds no key, so `nginx` refuses every request | Every `apiKeyCountCheckHours`, while the list stays empty |

The first two stay quiet while private rpc is off, as [Turn the Private Rpc Off and On](#turn-the-private-rpc-off-and-on) explains, and before `apply` has added the flag. An alert from `ensure` that Telegram doesn't take goes out at the next run. Without `x1console`'s Telegram files, `ensure` and the key count check only log their alerts.

Two checks send no alert: whether the running validator carries `--private-rpc`, and what listens on ports 80 and 443. Their problems show only in the output and the exit code of an `ensure` you run yourself, without `--quiet`. The `cron` job runs it with `--quiet`, which leaves them out of its log.

---

## Configure

Your settings go in `x1-validator-private-rpc/app-config/user-configurable/private-rpc.json`. Its [README](app-config/user-configurable/README.md) says what the file holds, and where every setting is described. One you may want to change is `rateLimitRequestsPerSecond`, `nginx`'s limit on keyed requests, which all keys share. Run `apply` again after a change, to rewrite `nginx`'s configuration.

The `hashedApiKeysMapPath` setting says where the tool writes `nginx`'s list of the keys' hashes. `apply` writes that path into `nginx`'s configuration, and `nginx` reads the list from there. After changing the setting, run `apply` straight away, with no other command of the tool before it. Until `apply` rewrites `nginx`'s configuration, `nginx` keeps reading the list at the old path, while the tool's other commands use the new path at once. So `remove-api-key` would write a list that `nginx` doesn't read, and the removed key would keep working.

To move the api keys' file, move the file itself first, then change `hashedApiKeysPath`, then run `apply`. With no file at the new path, `apply` takes the machine for a first install: it makes a new first key under a new password, and hands `nginx` a list that holds only that key. Every key your clients hold then stops working.

Non-standard settings for the programs the tool uses, such as `nginx`, aren't fully supported. A non-default `acmeStatePath`, this tool's setting for the folder where `nginx` keeps its certificates, is one example. There, the only gap is that when you purge `nginx` after `undo-apply`, that folder's files stay behind.

The Cronitor url is a credential, so it goes in the project root's `.env` instead, as [Cronitor Heartbeat](#cronitor-heartbeat) shows.

[examples/](examples/README.md) holds an example of each file `apply` renders, with placeholders for your values.

---

## Test

The tests are for changing the tool, on a development machine. A validator never runs them, and using the tool needs none.

On a development machine, install with `npm ci`, as the project's [Development](../README.md#development) section says, and run every `npm` command from the project root. Run `npm test` after each change: it runs every test but the system test. None of them touches the machine: the tool's tests hand it a stand-in for the system. The system test, `npm run test:system`, runs the tool for real instead, in a throwaway Ubuntu 24.04 container on your development machine, never on a validator. It alone needs LXD. Run it before you merge a change to the tool's code. The project's [engineering reference](../docs/engineering.md#the-system-test) says what it checks.

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

GitHub can run the same test on its own runner, with no LXD on your machine: start the System Test workflow by hand, in the repository's Actions tab.

---

## Api Key Security

- **Hashes for `nginx`.** `nginx` keeps only each key's SHA-256 hash, in `/etc/nginx/x1-validator-private-rpc/hashed-api-keys.map`, and checks a request by hashing the key it carries. A random 256-bit key can't be worked back from its hash. Even with the list at its 500,000 limit, an even chance of finding any one key would take about 5×10⁴² years at the whole Bitcoin network's rate. So nothing on the validator holds a usable key, and `nginx` needs no password, at a start or ever.
- **Shown once.** The tool shows each key when it makes it, and never again. A key is never a command's argument, so no other user sees it in a process list.
- **Encrypted records.** `~/.config/x1-validator-services/hashed-api-keys.json` holds each key's hash, unencrypted, with its record. Only your account can read it, and its folder is one that future validator services can share. Every value of a key's record is encrypted with your x1-validator-services password, with AES-256-GCM. The encryption key comes from the password, through PBKDF2-SHA-512 at 600,000 iterations. [LP Ranger](https://github.com/nottoseethesun/lp-ranger), another project by the same author, stores private keys the same way.
- **No key in the logs.** `nginx` writes its usual `access.log` and `error.log` in `/var/log/nginx`. The access log shows `<key>` in place of anything that looks like a key, anywhere in the url, a mistyped one included. The error log can't hide a key: a line about a request carries the request line as the client sent it. So the part of `nginx`'s configuration that forwards keyed requests writes no error log: it sends those lines to `/dev/null`. But `nginx` picks that part only once it has read a request's header, so an error before then goes to `error.log`. Three things a client can do set off such an error: stall partway through its header, hang up partway through it, or send a header line `nginx` can't read. The error's line holds the request line as far as the client sent it. `nginx` writes each such error at its info level. The tool's configuration keeps `error.log` at notice and above, so such errors never reach it. Sending lines to `/dev/null` has one side effect: an expected `[emerg] chown("/dev/null", …) failed` line in `error.log` each night, as [Keys in `nginx`'s Logs](docs/architecture.md#keys-in-nginxs-logs) explains.
- **Who can read the logs.** Both logs hold each client's address. Root, `nginx` and the `adm` group can read them, as with any `nginx` from nginx.org's package, and the package's `logrotate` rule keeps 52 days of them.
- **A saved password.** `systemd` encrypts it, with the machine's TPM2 chip when it has a usable one. Without a chip, the key that decrypts it sits on the same disk, so a copy of the disk gives it up. `apply` says which case applies before it asks.
- **A lost password.** If you saved it, root can read it back: `sudo systemd-creds decrypt --name=x1-validator-services-password /etc/credstore.encrypted/x1-validator-services-password -`. If you didn't, it can't be recovered, and nothing can read the records without it. The keys keep working, since `nginx` needs only their hashes, but `add-api-key` needs the password. To start over, run `undo-apply`, and let it delete every key. Then run `apply`, which makes a new first key under a new password, and make each client a key of its own with `add-api-key`.

---

## Development

For an overview of how the tool works, see **[`docs/architecture.md`](docs/architecture.md)**. It covers the parts the tool arranges on the validator, the path of a request and of the keys, and who restarts what.

For engineering details, see **[`docs/engineering.md`](docs/engineering.md)**. It covers the modules, the record of what `apply` changed, every file the tool reads and writes, the order its commands do things in, and the tests.

For how the whole project is checked, see the project's [`docs/engineering.md`](../docs/engineering.md), and for every `npm` command, [`docs/npm-project-commands.md`](../docs/npm-project-commands.md).
