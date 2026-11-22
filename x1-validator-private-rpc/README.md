# x1-validator-private-rpc

![A bronze-armored X1 defender robot with teal eyes holds up a glowing key beside a door marked 443, while shadowy figures stand behind a red line on the floor. At center, a round vault door marked 8899 frames a glowing core whose teal beam falls to the floor. Through a viewport, a bright streak and a storm of sparks cut across space beside a planet. Inspired by Isaac Asimov's story "Reason" (Astounding Science Fiction, 1941; collected in I, Robot).](../assets/images/x1-defender-robot.png "X1 Defender Robot")

## Overview

### What the Tool Is For

`x1console` starts an X1 validator with its full rpc open on port 8899, on every network interface, and advertised to the network. So anyone on the internet can query it, and each query competes with voting for the machine's cpu and bandwidth.

x1-validator-private-rpc makes the rpc private, so that only programs on the validator itself can reach it directly. From outside, only those you give an api key to, your clients, can reach it. They reach it through the keyed url: an https url that carries the key, such as `https://x1-rpc.example.com/KEY`. x1-validator-private-rpc is a command-line tool that you run on the validator, and for now it works only with [`x1console`](https://github.com/BlackBeard085/x1console/tree/main). It's the first feature of X1 Validator Services, a project of tools that run on an X1 validator.

Your use of this tool, including all of its scripts and features, constitutes your agreement that you have read and understood the [Disclaimer](#disclaimer).

### How It Works

The tool's `apply` command sets everything up, in stages, asking before each one that changes something. Its other commands manage the api keys, keep the rpc private, turn private rpc off and on, and take back what `apply` changed:

- `apply` adds `--private-rpc`, a flag the validator's software already has, to `x1console`'s start script, the file `x1console` starts the validator with. From the validator's next start, the flag makes the rpc listen on 127.0.0.1 alone, and the validator no longer advertises it. `x1console`'s scripts, and `x1-pinger`, the ping service `x1console` can start, query the rpc on 127.0.0.1, with no key, so they still reach it. The tool never restarts the validator: you choose when, as [Restart the Validator](#restart-the-validator) shows.
- `apply` also puts `nginx`, from nginx.org, in front of the rpc, on the validator's public address and port 443 alone. `nginx` forwards only requests whose path starts with one of the keys, and refuses every other one with a 403 before it reaches the validator. Keyed requests beyond a rate limit you can set, which all keys share, get 429 Too Many Requests. `nginx` runs two of nginx.org's modules: njs, which hashes each request's key, and ACME, which gets and renews the certificate from Let's Encrypt. Before Let's Encrypt issues a certificate, it checks that the hostname is yours, usually through port 80. The ACME module has it check through port 443 instead, so port 80 stays closed.
- Each client gets api keys of its own. `apply` makes the first key. After that, `add-api-key` makes more, such as for a new client, and `remove-api-key` removes one, such as a key that leaked, so that `nginx` refuses it. The tool stores only a hash of each key, never the key itself, and a hash can't be turned back into its key. So the tool can show you a key only once, when it makes the key. It writes each hash to the api keys' file, with the key's record: when the key was made, and the client's email, if you give one. A password you choose during `apply`, the x1-validator-services password, encrypts the records, but not the hashes. From that file, the tool writes `nginx`'s list of the hashes, which `nginx` checks each request against. [Api Key Security](#api-key-security) explains why `nginx` can check keys by their hashes alone, with no password.
- An `x1console` update, from its menu entry Update X1 Console, takes `--private-rpc` back out of the start script, and the command `ensure` puts it back. When the update's `git pull` brings new commits, `git` runs the tool's `git` hook, which `apply` installs in `x1console`'s folder, and the hook runs `ensure`. For an update that brings none, `apply` also offers a `cron` job that runs `ensure` every minute. [After an `x1console` Update](#after-an-x1console-update) explains both, and how soon the flag is back. `ensure` also alerts you on Telegram when the rpc turns public, the flag can't go back, `nginx` is down, or the certificate needs attention.
- While `nginx`'s list of the keys' hashes is empty, as after `remove-api-key` takes the last key, `nginx` refuses every request. The key count check, the command `ensure-there-is-at-least-one-rpc-api-key`, alerts you then. A second `cron` job, which `apply` offers with the first, runs it every two hours, as shipped in the tool's settings.
- To make the rpc public again without uninstalling the tool, `turn-off-private-rpc` makes it public from the validator's next start, and leaves everything else in place. `turn-on-private-rpc` makes it private again.
- To uninstall the tool, `undo-apply` takes back what `apply` changed. It leaves `nginx` installed, and prints the commands that remove `nginx`.

### The Standalone Tools

Two standalone tools come with x1-validator-private-rpc: programs of their own, which you start by their paths, not commands of the tool. Once the tool is installed, `nginx` updates with the system's other packages. `validate-nginx-upgrade`, the first install step, tests on this machine that such an `apt` upgrade keeps a keyed url working. `check-my-private-rpc` checks that your keyed url works for a client, such as after the validator's restart.

## Table of Contents

- [Overview](#overview)
  - [What the Tool Is For](#what-the-tool-is-for)
  - [How It Works](#how-it-works)
  - [The Standalone Tools](#the-standalone-tools)
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
- [Run](#run)
  - [Usage](#usage)
    - [Api Keys](#api-keys)
    - [Check](#check)
    - [After an `x1console` Update](#after-an-x1console-update)
    - [Turn the Private Rpc Off and On](#turn-the-private-rpc-off-and-on)
    - [Alerts](#alerts)
- [Configure](#configure)
- [Update](#update)
- [Uninstall](#uninstall)
- [Api Key Security](#api-key-security)
- [Test](#test)
- [Development](#development)

---

## Disclaimer

x1-validator-services is licensed under the Apache License, Version 2.0. The LICENSE file at the project's root holds its full text.

That license says the software is provided as is, without warranties or conditions of any kind, express or implied. That includes any warranties or conditions of title, non-infringement, merchantability or fitness for a particular purpose. You alone are responsible for deciding whether it's right to use or share it, and you take on any risks of doing so.

The license also says that no contributor is liable to you for damages, under any legal theory, whether in tort, negligence included, in contract or otherwise. That covers direct, indirect, special, incidental and consequential damages of any kind that come from the license, or from using the software or being unable to use it. Among them are lost goodwill, work stoppage, a computer's failure or malfunction, and any other commercial damages or losses. It holds even when a contributor was told such damages could happen.

Both hold unless the law requires otherwise, as it can for deliberate and grossly negligent acts, or unless otherwise agreed in writing.

This software could, although its authors have made all best efforts to the contrary, cause your validator to exhibit degraded performance or even stop working.

Each run that can change the system shows this disclaimer before it does anything, in a dialog that `whiptail` draws, which takes over the terminal like the ones packages show as they install. The run goes on only once you choose Affirm, which affirms "I have read and understood the above Disclaimer." Decline, or Esc, stops it with nothing changed, and Ctrl-C does nothing there. Decline has the focus at first. The left and right arrows move between the two buttons, and Enter chooses the one that has the focus. To scroll the text, press Tab to move to it, then use the up and down arrows, or PgUp and PgDn. Runs that change nothing don't show it: the dry runs, and the commands that only check or print. Neither does `ensure`, which `cron` and the tool's `git` hook run with nobody at the terminal.

---

## Prerequisites

- An X1 validator set up by `x1console`, on Ubuntu 24.04 or later.
- Node.js 24 or newer. `x1console` installs `nvm`, the Node.js version manager, with the Node.js 20.0.0 its own scripts run on. `nvm` holds several versions side by side, and the project's [Get the Code](../README.md#get-the-code) step adds Node.js 24 beside 20.0.0. On a validator, the tool runs on 24, the oldest major it supports, since a validator can't always move to the newest at once.
- The project's code on the validator, as the project's [Install](../README.md#install) section describes.
- The validator's account, with `sudo`.
- The validator's public ipv4 address on one of its own interfaces. Servers behind address translation aren't supported.
- Port 443 free on the validator, not closed by a `ufw` rule, and no `nginx` installed there, unless an earlier `apply` installed it.
- A domain you own, where you can add a dns record.
- `x1console`'s Telegram alerts, set up in `x1console`, if you want the tool's alerts: the tool sends them through `x1console`'s Telegram bot.

### System Programs

The tool needs Ubuntu, because of where some of the system programs it uses come from. `apt` and `dpkg` come from the Debian distribution of Linux, and every distribution in its family shares them. What ties the tool to Ubuntu, one of that family, is two of the others: `ufw` comes from Ubuntu, and the nginx.org packages the tool installs are nginx.org's builds for Ubuntu. Ubuntu also installs `whiptail` with the system, and the tool draws its disclaimer's dialog with it. The tool will not work without these, and also, will not work without `systemd`. The rest are common to Linux systems that run `systemd`. A stock Ubuntu 24.04 server has every program the tool uses but three: `nvm` and Node.js 24, which the prerequisites above bring, and `nginx`, which `apply` installs. [`docs/engineering.md`](docs/engineering.md#dependencies) lists every one in its Dependencies section, with what the tool does with each.

---

## Install

> **Never point the validator's own `solana` cli at the keyed url, or at the validator's own address.** That means any rpc url that contains the tool's hostname (`x1-rpc.example.com` in these docs) or the validator's public address, whether you set it from `x1console`'s network menu or with `solana config set --url`. Point the cli at X1's public rpc instead, from `x1console`'s network menu. Autopilot, the `cron` jobs `x1console` can install to look after the validator, checks the validator's health through the cli's rpc url. It answers a failed check by deleting the ledger and restarting the validator. The keyed url and the validator's own address can both fail that check. Under `--private-rpc`, the rpc no longer answers on the validator's address. The keyed url can stop answering too, for example while `nginx` restarts, or once the last api key is removed. `apply` stops at its first check, changing nothing, while the cli's url contains the tool's hostname or the validator's address.

**Start every command that runs one of the tool's `.js` files with `nvm exec 24`,** as each command below does. On a validator, the default `node` is Node.js 20.0.0, which `x1console` installed, and it's too old for the tool. `nvm exec 24` runs one command on Node.js 24 instead. For the tool's commands, [Run](#run) shows how to link its launcher, a small script that starts the tool on Node.js 24, so that the tool's name alone runs it. The standalone tools, `validate-nginx-upgrade` and `check-my-private-rpc`, have no launcher, so on the validator they always need `nvm exec 24`.

### Check That `nginx` Upgrades Keep Working

Once the tool is installed, `nginx` updates with the system's other packages, whenever `apt upgrade` runs, as `x1console`'s Update X1 Validator does. This check, the standalone tool `validate-nginx-upgrade`, proves on this machine that such an upgrade keeps a keyed url working. Run it first, before anything else of the tool is installed: the check refuses to run while any `nginx` is installed, since it installs and removes `nginx` itself. The check installs nginx.org's previous release of `nginx`, with a throwaway api key, and runs that `nginx` under `systemd` the way the tool will. Then it upgrades `nginx` with `apt`. nginx.org's upgrade starts a new `nginx` process and hands over to it, without a restart. `systemd` tracks a service by its main process, so it must follow that handover to the new process. The check makes sure it did: `systemd` still counts `nginx` as running, now as the new process, with no restart. It also makes sure the new `nginx` still lets the throwaway key through and turns a random one away. Last, it removes everything it added. It never touches the validator's software, port 443 or the firewall.

It takes a few minutes. Run it inside `tmux`, so that a dropped `ssh` connection can't stop it halfway and leave `nginx` installed. If the connection drops, log in again and run `tmux attach` to get back to it. Run it as the validator's account, from the project root, `~/x1-validator-services`. It asks for your `sudo` password:

```bash
tmux
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/util/validate-nginx-upgrade/index.js
```

It ends with `Passed`, or with the reasons it failed. If it ever can't remove something it added, it lists that step with a `By hand:` command that does the same. Run those commands in the order listed, then run it again. To stop it early, press Ctrl-C: it finishes the step it's on, then removes everything it added. Type `exit` afterwards to leave `tmux`. Go on with the install only once it passes.

### Point the Hostname at the Validator

Add one `A` record at your dns provider: a new name under your domain, such as `x1-rpc.example.com`, with the validator's public ipv4 address. [Manual Domain Setup](docs/manual-domain-setup.md) shows how, for form-based and raw zone-file editors, and how to check the record.

### Set the Hostname

The tool reads your settings from one file, which it merges over its shipped defaults, so the file needs only the settings you change. From the project root, make the file by copying the example:

```bash
cp x1-validator-private-rpc/app-config/app-defaults-for-user-configurable/private-rpc.example.json \
   x1-validator-private-rpc/app-config/user-configurable/private-rpc.json
```

Then, in the copy, set `hostname` to the name from the last step, and `publicIp` to the validator's public ipv4 address, which `nginx` listens on. Or delete `publicIp`, to use the address the X1 network sees for your validator. Set `acmeEmail` to a contact address for Let's Encrypt, or delete it for none. [Configure](#configure) says where every setting is described, and what to run after you change one.

### Run apply

`apply` works in eight stages. Stage 1 checks the machine, and changes nothing. If it finds problems, it lists them all and stops. Otherwise it goes through stages 2 to 7, asking "Go on?" before each one:

- stage 2: `nginx` from nginx.org
- stage 3: the firewall rule for port 443
- stage 4: the x1-validator-services password and the first api key
- stage 5: `nginx`'s configuration and start
- stage 6: the start-script flag
- stage 7: the `git` hook, then the two `cron` jobs that run `ensure` and the key count check, after one question that covers both, then a test alert on Telegram, when `x1console`'s bot is set up

Stage 8 changes nothing: it says whether to restart the validator, and prints the url, with `KEY` or the new key's last four characters in place of the key.

First have a look at what `apply` would do. The dry run changes nothing:

```bash
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply --dry-run
```

Let's Encrypt allows only five failed requests an hour for one hostname, and a mistake, such as a dns record Let's Encrypt can't see yet, makes a request fail. Failures at its staging service don't count toward that limit, though no client trusts the staging service's certificates. So the first run that sets the tool up, the staging run, takes `--acme-staging`, which gets the certificate from the staging service.

During the staging run, at its stage for the first api key, `apply` asks for a new x1-validator-services password, typed twice, with at least as many characters as the `passwordMinLength` setting says. Then `apply` makes the first api key. It writes the key's hash and its record, with no email, to the api keys' file, `~/.config/x1-validator-services/hashed-api-keys.json`. Then it prints the key's two urls, https and wss, with the key in them. **Save them now**: the client needs them, and so do you, to remove the key later, since no command can show the key again.

Then `apply` says how `systemd` would protect a saved password on this machine, and asks whether to save the password there. A saved password is the only way back to a forgotten one. Features to come will also use it to read the records unattended: billing, and rotation notices, which will email a key's client when the key is due to be replaced. None of the tool's commands reads a saved password yet, and `nginx` never needs it. [Api Key Security](#api-key-security) says what `systemd`'s protection guards against, and how root reads a saved password back.

`apply` asks whether to save the password only right after it makes a first key. So if you answer no, or stop the run at the question, such as with Ctrl-C, the password stays unsaved: no later run asks again while the api keys' file holds a key.

`--yes` answers yes to each stage's question and to the question about the `cron` jobs. You still type the password, and answer the save question.

Start the staging run inside `tmux`, as with the upgrade check:

```bash
tmux
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply --acme-staging
```

Once the staging run has finished, run `apply` again without `--acme-staging`, for the real certificate. It changes only `nginx`'s configuration, so the key from the staging run stays valid, and it asks for no x1-validator-services password:

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply
```

Every stage first checks whether its work is done, so running `apply` again changes nothing that's in place. If it stops partway, run it again, and it picks up from there. A key it made and showed stays, so the next run makes none. If you stop `apply` before its flag stage, `ensure` doesn't add the flag either: it leaves the start script alone until `apply` has added it.

If `nginx` refuses a new configuration, `apply` puts the old one back, so `nginx` runs as before. It writes what `nginx` refused, and why, to `x1-validator-private-rpc/logs/error.log`.

### Restart the Validator

The validator reads its flags only when it starts, so `--private-rpc` takes effect at its next start. In `x1console`, choose 2. Validator, then 1. Start/Restart Validator, at a moment when the Validator screen shows no leader slot coming soon. The keyed url works before the restart too: `nginx` forwards to the rpc on 127.0.0.1, and until the restart the rpc listens on every interface, 127.0.0.1 among them.

After the restart, check from another machine that the rpc no longer answers on the validator's address. This should fail to connect:

```bash
curl -m 5 http://203.0.113.10:8899/health
```

Replace `203.0.113.10` with the validator's address. Then check the keyed url with `check-my-private-rpc`, as [Check](#check) describes.

### Cronitor Heartbeat

`ensure` runs every minute, from the `cron` job that `apply` installs when you accept it. If that job ever stops working, for example because the project's folder moved or the tool's settings have a typo, the flag stops going back after an `x1console` update, and `ensure`'s alerts stop, all without a word. So at the end of each run, `ensure` checks in with Cronitor, and Cronitor alerts you when the check-ins stop. While all is well, Cronitor sends nothing. Without that job, don't set up the heartbeat: no run would check in each minute, and Cronitor would keep alerting.

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

4. Test it. Run `crontab -e`, and put a `#` in front of `ensure`'s line, the one that starts with `* * * * *`. Leave the key count check's line, which starts with `0 */`, as it is. Within about five minutes, Cronitor should alert you on Telegram. Then remove the `#`. Once the check-ins resume, Cronitor sends a recovery notice.

---

## Run

Once the tool is installed, `systemd` runs `nginx`, and starts it at each boot. [How It Works](#how-it-works) says what runs `ensure` and the key count check on their own. You run the tool's commands, and its two standalone tools, when you need them.

Run the tool as the validator's account, from the project root, on Node.js 24. Its `--help` lists its commands:

```bash
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/src/cli.js --help
```

To type the tool by name from anywhere, link its launcher into `~/.local/bin`, which Ubuntu's default profile puts on your PATH from your next login. The launcher, `x1-validator-private-rpc/bin/x1-validator-private-rpc`, runs the tool on the newest Node.js 24 that `nvm` holds. So `x1-validator-private-rpc COMMAND` does the same as `nvm exec 24 node x1-validator-private-rpc/src/cli.js COMMAND` in the project root:

```bash
mkdir -p ~/.local/bin
ln -sf ~/x1-validator-services/x1-validator-private-rpc/bin/x1-validator-private-rpc ~/.local/bin/x1-validator-private-rpc
```

### Usage

Each task has a section below: [Api Keys](#api-keys), [Check](#check), [After an `x1console` Update](#after-an-x1console-update), and [Turn the Private Rpc Off and On](#turn-the-private-rpc-off-and-on). [Alerts](#alerts) says what `ensure` and the key count check send you on Telegram. Each command's `--help` gives that command's options, an example of each common use, and what each exit code means, and so does each standalone tool's. [`docs/project-commands.md`](docs/project-commands.md) lists every command and standalone tool, with its options and an example of each common use.

#### Api Keys

`add-api-key` makes one key, or as many as `--count` says, such as three for one client's three apps. It first checks that the api keys' file has room for them under the `maxApiKeys` setting, and refuses if the file doesn't. Then it asks for your x1-validator-services password, which encrypts the new keys' records. Next it asks for one email, the client's, to write into every new key's record. The email shows as you type. Press Enter for none. Then it makes the keys, and prints each key's https and wss urls. Save them, as with the first key.

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js add-api-key --count 3
```

`remove-api-key` removes a key. It asks for the key, which you paste at a prompt that shows nothing. It asks no x1-validator-services password: it hashes the key you paste, and looks for that hash in the api keys' file, where the hashes aren't encrypted. Since it needs the key itself, a key you no longer have stays valid until `undo-apply` deletes every key. Removing the last key asks first, since `nginx` then refuses every request, and the key count check alerts you until `add-api-key` makes another:

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js remove-api-key
```

When you have a key but not its urls, such as a key you saved on its own, the command `url` prints the url's two forms, https and wss, with `KEY` in place of the key. It also says how many keys `nginx`'s list holds:

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js url
```

Writing `nginx`'s list needs `sudo`, so `add-api-key` and `remove-api-key` may ask for your account's `sudo` password. They ask after their own questions and before they change anything, so a wrong or cancelled password changes nothing.

Both then write `nginx`'s list, and reload a running `nginx`, so it reads the new list. Once the reload is done, a new key works, and a removed one stops working. A reload takes a moment, up to a second or two with hundreds of thousands of keys. It starts a new `nginx` worker process, the one that serves requests, and leaves each connection already open with the old one, under the old list. A websocket's key is checked only when the websocket opens, so a removed key's websocket would stay open on the old worker. So the tool's configuration has the old worker close every connection it still holds 10 seconds after a reload. After each change, then, every open websocket closes within 10 seconds, and its client must reconnect.

Only one command changes the keys at a time. While `apply`, `undo-apply` or another key command is changing them, `add-api-key` and `remove-api-key` refuse, change nothing, and say to run them again.

If `remove-api-key` stops part way, for any reason, run it again with the same key, before any other key command or `apply`. It takes the key's hash out of `nginx`'s list first, and out of the api keys' file, `hashed-api-keys.json`, last. So a stop in between leaves the hash in that file. `add-api-key`, `remove-api-key` for another key, and `apply` each write `nginx`'s list from that file. So each would put the removed key's hash back in the list, and the key would work again. [The Keys' Path](docs/architecture.md#the-keys-path), in `docs/architecture.md`, says more.

#### Check

`check-my-private-rpc` checks once that your keyed url works for a client, such as after the validator's restart, or when a client reports a problem. It asks for the rpc's hostname and the api key at prompts, never as arguments, so the key stays out of your shell's history. It doesn't show the key as you type it. Then it sends the rpc a run of queries through `nginx`, one right after another, and prints a table of the answers. It ends with a green ✔ when every query worked, or a red ✘ and what went wrong.

Take the hostname and the key from a url that `apply` or `add-api-key` printed: the hostname follows `https://`, and the key follows the hostname. Run it from the project root, on the validator or on any machine where the project is installed. On a machine without `nvm`, start it with a `node` that's Node.js 24 or newer, in place of `nvm exec 24 node`:

```bash
nvm exec 24 node x1-validator-private-rpc/util/check-my-private-rpc/index.js
```

The `checkQueryCount` setting sets how many queries the check sends.

#### After an `x1console` Update

An Update X1 Console takes `--private-rpc` out of the start script, and the tool puts it back on its own, through its `git` hook or its `cron` job. Meanwhile the running validator keeps its private rpc, since it read its flags when it started. Only a restart while the flag is out would start it with a public rpc.

`x1console`'s folder is a `git` checkout, and Update X1 Console runs `git stash` there, then `git pull`. The flag is the tool's own edit to an `x1console` file, and nobody commits it. `git stash` takes every edit nobody committed out of the folder's files, and sets it aside, so the stash takes the flag out. When the pull merges new commits, `git` runs the tool's `git` hook, which puts the flag back before the update finishes. A pull with nothing new merges nothing, so `git` runs no hook. In that case, the `cron` job's `ensure` puts the flag back. Either way, `ensure` sends an alert that it put the flag back.

The `cron` job's `ensure` waits before it puts the flag back. An `ensure` that `cron` starts during an update can't tell whether the update's pull will change the start script. If the pull does change it, a flag `ensure` put back after the stash makes the pull fail, since `git` won't overwrite an edit nobody committed. So `ensure` leaves the script alone until it has gone unchanged for `startScriptQuietSeconds`, 30 seconds as shipped. The stash changes the script, and the pull usually ends a few seconds later, so by then the update is done. Since the `cron` job runs once a minute, the flag is back 30 to 90 seconds after the update. The hook's `ensure` doesn't wait, since `git` runs the hook only once the pull's merge is done.

Without the `cron` job, run `ensure` yourself after each update, once `startScriptQuietSeconds` has passed, since a sooner run leaves the script alone.

Update X1 Validator restarts the validator, so the start script must carry the flag before you choose it. Even with the `cron` job, the flag can be out for up to 90 seconds after an Update X1 Console. So before Update X1 Validator, run `ensure`, and check that it says the start script carries `--private-rpc`. If it says instead that `x1console` may be updating, and that it left the start script alone, run it again once the script has gone unchanged for `startScriptQuietSeconds`. [`x1console`'s Updates and Autopilot's Restarts](docs/architecture.md#x1consoles-updates-and-autopilots-restarts), in `docs/architecture.md`, explains the short windows when the script lacks the flag.

#### Turn the Private Rpc Off and On

`turn-off-private-rpc` takes `--private-rpc` out of the start script, after asking, so the rpc listens on every interface again from the validator's next start. It also records that private rpc is off, so `ensure` no longer puts the flag back, and no longer checks that the rpc is private. Everything else stays: `nginx` keeps serving the keyed url, and `ensure` keeps checking `nginx` and its certificate. `turn-on-private-rpc` puts the flag back, and records that private rpc is on again:

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js turn-off-private-rpc
nvm exec 24 node x1-validator-private-rpc/src/cli.js turn-on-private-rpc
```

Restart the validator as in [Restart the Validator](#restart-the-validator), for the change to take effect. Running `apply` again turns private rpc on too, as [Update](#update) notes. If `ensure` is changing the start script at the moment you answer, `turn-off-private-rpc` refuses, changes nothing, and says to run it again.

`turn-off-private-rpc` takes out only the flag the tool adds, at the end of the `--rpc-port` line. A flag anywhere else in the start script, such as one you added by hand on a line of its own, stays. Then the rpc stays on 127.0.0.1 after the validator's next start, and `turn-off-private-rpc` says so. To make the rpc public, take that flag out of the start script by hand, then restart the validator.

#### Alerts

`ensure` sends its alerts on Telegram through `x1console`'s bot, as plain text, naming your hostname and the event, never a secret. For each of the four problems at the top of the table, `ensure` sends an alert when the problem starts, repeats the alert as the table's last column says, and sends a recovery notice when the problem ends. The key count check, `ensure-there-is-at-least-one-rpc-api-key`, sends its own alert, through the same bot.

| Alert | When | Repeats |
| --- | --- | --- |
| The rpc is public | The rpc listens on an address other than 127.0.0.1 | Every `exposedReminderMinutes` |
| The flag is missing | The start script lacks `--private-rpc`, and `ensure` couldn't put it back | Every `exposedReminderMinutes` |
| `nginx` is down | `nginx` isn't active | No |
| The certificate needs attention | Under `certificateWarningDays` left, issued for another name, or `ensure` can't read it from `nginx` over tls | Every `certificateReminderHours` |
| The flag is back | `ensure` put `--private-rpc` back after an Update X1 Console | No |
| No api key | `nginx`'s list holds no key, so `nginx` refuses every request | Every `apiKeyCountCheckHours`, while the list stays empty |

The first two stay quiet while private rpc is off, as [Turn the Private Rpc Off and On](#turn-the-private-rpc-off-and-on) explains, and before `apply` has added the flag. An alert from `ensure` that fails to send, because Telegram can't be reached or refuses it, goes out at the next run. Without `x1console`'s Telegram files, its bot's token and chat id, `ensure` and the key count check only log their alerts.

Two checks send no alert: whether the running validator carries `--private-rpc`, and what listens on ports 80 and 443. Their problems show only in the output and the exit code of an `ensure` you run yourself, without `--quiet`. The `cron` job runs `ensure` with `--quiet`, which leaves these two checks out of `ensure`'s log.

---

## Configure

Your settings go in `x1-validator-private-rpc/app-config/user-configurable/private-rpc.json`, the file [Set the Hostname](#set-the-hostname) made. The [README in its folder](app-config/user-configurable/README.md) says what the file holds, and where every setting is described. One setting you may want to change is `rateLimitRequestsPerSecond`: how many keyed requests a second `nginx` forwards to the rpc, all keys together. If your clients get 429 Too Many Requests, raising it lets more of their requests through, but each one competes with voting, as [What the Tool Is For](#what-the-tool-is-for) explains. After changing any setting, run `apply` again. It rewrites what the change affects, such as `nginx`'s configuration.

The `hashedApiKeysMapPath` setting says where the tool writes `nginx`'s list of the keys' hashes. `apply` writes that path into `nginx`'s configuration, and `nginx` reads the list from there. After changing the setting, run `apply` straight away, with no other command of the tool before it. Until `apply` rewrites `nginx`'s configuration, `nginx` keeps reading the list at the old path, while the tool's other commands use the new path at once. So `remove-api-key` would write a list that `nginx` doesn't read, and the removed key would keep working.

To move the api keys' file, move the file itself first, then change `hashedApiKeysPath`, then run `apply`. With no file at the new path, `apply` takes the machine for a first install: it makes a new first key under a new password, and hands `nginx` a list that holds only that key. Every key your clients hold then stops working.

Non-standard settings for the programs the tool uses, such as `nginx`, aren't fully supported. A non-default `acmeStatePath`, this tool's setting for the folder where `nginx` keeps its certificates, is one example. There, the only gap is that when you purge `nginx` after `undo-apply`, that folder's files stay behind.

The Cronitor url is a credential, so it goes in the project root's `.env` instead, as [Cronitor Heartbeat](#cronitor-heartbeat) shows.

[examples/](examples/README.md) holds an example of each file `apply` renders, with placeholders for your values.

---

## Update

The tool has no releases: an update brings the newest code from the project's `main` branch. When you run `apply` after an update, it rewrites the files it wrote for `nginx`, and the tool's `cron` lines, wherever the new version writes them differently. nginx.org's `apt` repository stays as the first `apply` set it up.

Run `apply` as soon as the new code and its packages are in. The `cron` lines start `ensure` and the key count check, and the tool's `git` hook starts `ensure`. Each names, by its full path, the Node.js that ran `apply`. So `apply` also rewrites the lines and the hook when they name another Node.js, or an old path to the tool. When an update raises the Node.js major the tool needs, lines that name the older one start a tool that stops at once. No flag goes back, and no alert goes out, until `apply` rewrites them.

From the project root, get the new code with `git pull`. Then `nvm install 24` installs the newest release of Node.js 24, beside any older one, when `nvm` doesn't hold it yet. Install the tool's Node.js packages on it with `npm ci`, as the project's [Get the Code](../README.md#get-the-code) does. Last, run `apply` on Node.js 24:

```bash
cd ~/x1-validator-services
git pull
nvm install 24
nvm exec 24 npm ci --omit=dev --ignore-scripts
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply
```

If you had turned private rpc off, run `turn-off-private-rpc` again once `apply` is done, since `apply` turned it back on.

`apply` doesn't upgrade `nginx` or its two modules. `apt upgrade` does, with the system's other packages, as [Check That `nginx` Upgrades Keep Working](#check-that-nginx-upgrades-keep-working) explains.

---

## Uninstall

`undo-apply` takes back what `apply` changed, newest first. `apply` records each change it makes on the machine, such as a file or a firewall rule it adds, with what was there before, in `x1-validator-private-rpc/app-data/what-apply-changed.json`. `undo-apply` takes back only those changes. What was there before `apply`, such as a firewall rule you added, stays. It never removes a package, since something else may need one. So `nginx` stays installed, as below.

To make the rpc public for a while and keep everything else, use `turn-off-private-rpc` instead, as [Turn the Private Rpc Off and On](#turn-the-private-rpc-off-and-on) shows. `nginx` then keeps serving the keyed url, which `undo-apply` stops.

If you set up the [Cronitor heartbeat](#cronitor-heartbeat), pause or delete its monitor first. Once the `cron` line goes, the check-ins stop, and Cronitor alerts you.

Look at what `undo-apply` would do first, then run it:

```bash
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/src/cli.js undo-apply --dry-run
nvm exec 24 node x1-validator-private-rpc/src/cli.js undo-apply
```

First `undo-apply` asks one question: whether to delete every api key, with the saved password if `apply` saved one. One answer covers both, since the password opens nothing but the keys' records. So a no leaves both in place. A later `apply` then gives `nginx` the same keys' hashes, and your clients' urls keep working. After a yes, a later `apply` makes a new first key under a new password, and every client needs a new url. Then `undo-apply` removes each of these that `apply` made:

- the `cron` lines, and the tool's `tmp/` and `logs/` folders, with `ensure`'s log and the tool's error log in them
- the `git` hook
- the start-script flag, and the copies of the start script that `apply` saved beside it before adding the flag
- the files the tool wrote for `nginx`, its list of the api keys' hashes among them, whatever the answer
- the saved password, unless you kept it, and the folders made for it and for the api keys' file, once nothing else is in them
- the firewall rule

Once the start-script flag is out, the running validator's rpc stays as it started until the validator's next start. Unless the running validator already lacks the flag, `undo-apply` says that the validator's next start makes the rpc public. A flag `apply` didn't add stays, and `undo-apply` says so instead. You may have added it by hand, or with `turn-on-private-rpc` after an `apply` that stopped before stage 6, its flag stage. To have it gone, take it out of the start script by hand, after `undo-apply`. Once the start script carries no `--private-rpc`, restart the validator from `x1console` to make the rpc public, as in [Restart the Validator](#restart-the-validator).

`undo-apply` stops, disables and masks `nginx`, but leaves it installed, with its two modules. With the files the tool wrote for `nginx` gone, a start of `nginx` would run the package's own configuration, `/etc/nginx/nginx.conf`, and its default site. The mask stops anything from starting it. `nginx`'s configuration in `/etc/nginx`, its certificates in `/var/cache/nginx`, its logs in `/var/log/nginx`, its account and nginx.org's `apt` repository stay too. `nginx`'s packages, its account, nginx.org's repository and the mask stay listed in `x1-validator-private-rpc/app-data/what-apply-changed.json`. A later `apply` refuses an installed `nginx` unless that file shows `apply` installed it. With these entries, a later `apply` takes this `nginx` as its own, and reuses its certificate. `undo-apply` says all this as it runs.

If you want `nginx` gone, purge it, then run `undo-apply` again, which removes `nginx`'s account, nginx.org's repository and the mask:

```bash
cd ~/x1-validator-services
sudo apt-mark unhold nginx   # only if you hold it
sudo apt purge nginx nginx-module-njs nginx-module-acme
nvm exec 24 node x1-validator-private-rpc/src/cli.js undo-apply
```

If you removed `nginx` yourself with `apt remove` before running `undo-apply`, its configuration, certificates and logs may still be there. `undo-apply` leaves them. If you want them gone, `sudo apt purge nginx` deletes those folders, as `undo-apply` says.

Whatever a run of `undo-apply` doesn't take back stays listed in `x1-validator-private-rpc/app-data/what-apply-changed.json`, for a later run. A step that fails stays listed, and `undo-apply` says so. Running `undo-apply` again retries the failed steps, and asks the question again while the api keys' file is there. Once nothing is left, `undo-apply` removes `app-data/`, with that file in it.

---

## Api Key Security

- **Hashes for `nginx`.** `nginx` reads only each key's SHA-256 hash, from an unencrypted list, `/etc/nginx/x1-validator-private-rpc/hashed-api-keys.map`, and checks a request by hashing the key it carries. A random 256-bit key can't be worked back from its hash. A guessed key works if its hash matches any hash in the list, so each hash the list holds makes a guess likelier to work. Even with the list at its 500,000 limit, an even chance of finding any one key would take about 5×10⁴² years at the whole Bitcoin network's rate. So nothing on the validator holds a usable key, and `nginx` needs no password, at a start or ever: a restart of `nginx`, or a reboot, needs nobody to type one.
- **Never an argument.** A key is never a command's argument, so no other user sees it in a process list.
- **Encrypted records.** `~/.config/x1-validator-services/hashed-api-keys.json` holds each key's hash, unencrypted, with its record. Only your account can read it, and its folder is one that future validator services can share. Every value of a key's record is encrypted with your x1-validator-services password, with AES-256-GCM. The encryption key comes from the password, through PBKDF2-SHA-512 at 600,000 iterations. [LP Ranger](https://github.com/nottoseethesun/lp-ranger), another project by the same author, stores private keys the same way.
- **No key in the access log.** `nginx` writes its usual `access.log` and `error.log` in `/var/log/nginx`. The access log shows `<key>` in place of anything that looks like a key, anywhere in the url, a mistyped one included.
- **No key in the error log.** The error log can't hide a key: a line about a request carries the request line as the client sent it. So the part of `nginx`'s configuration that forwards keyed requests writes no error log: it sends those lines to `/dev/null`. But `nginx` picks that part only once it has read a request's header. An error before then still has a line that holds the request line, as far as the client sent it, so that line must be kept out of `error.log` another way. Three things a client can do set off such an error: stall partway through its header, hang up partway through it, or send a header line `nginx` can't read. `nginx` writes each such error at its info level. The tool's configuration writes only notice and above to `error.log`, so such errors never reach it. Sending lines to `/dev/null` has one side effect: an expected `[emerg] chown("/dev/null", …) failed` line in `error.log` each night, as [Keys in `nginx`'s Logs](docs/architecture.md#keys-in-nginxs-logs), in `docs/architecture.md`, explains.
- **Who can read the logs.** Both logs hold each client's address. Root, `nginx` and the `adm` group can read them, as with any `nginx` from nginx.org's package, and the package's `logrotate` rule keeps 52 days of them.
- **A saved password.** `systemd` encrypts a saved password. When the machine has a usable TPM2 chip, `systemd` ties the encryption to the chip, so a copy of the disk alone can't decrypt the password. Without a chip, the key that decrypts the password sits on the same disk, so a copy of the disk gives the password up.
- **A lost password.** If you saved it, root can read it back: `sudo systemd-creds decrypt --name=x1-validator-services-password /etc/credstore.encrypted/x1-validator-services-password -`. If you didn't, it can't be recovered: nothing can read the records, and `add-api-key` can't make a key, though the keys you have keep working. To start over, run `undo-apply`, and let it delete every key. Then run `apply`, which makes a new first key under a new password, and make each client a key of its own with `add-api-key`.

---

## Test

The tests are for changing the tool, on a development machine. A validator never runs them, and using the tool needs none.

On a development machine, install with `npm ci`, as the project's [Development](../README.md#development) section says, and run every `npm` command from the project root. The tool has two kinds of test: unit tests, which give the tool a stand-in for the system, so none of them touches the machine, and a system test, which runs the tool for real. `npm test` runs the unit tests, with every other test in the project but the system test: run it after each change. The system test, `npm run test:system`, runs in a throwaway Ubuntu 24.04 container on your development machine, never on a validator. It alone needs LXD. Run it before you merge a change to the tool's code. [The System Test](../docs/engineering.md#the-system-test), in the project's `docs/engineering.md`, says what it checks.

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

## Development

For an overview of how the tool works, see **[`docs/architecture.md`](docs/architecture.md)**. It covers the parts the tool arranges on the validator, the path of a request and of the keys, and who restarts what.

For engineering details, see **[`docs/engineering.md`](docs/engineering.md)**. It covers the modules, the record of what `apply` changed, every file the tool reads and writes, the order its commands do things in, and the tests. Its [Integration with `x1console`](docs/engineering.md#integration-with-x1console) section details where the tool and `x1console` meet: the start script, the `git` hook and the Telegram set-up.

For how the whole project is checked, see the project's [`docs/engineering.md`](../docs/engineering.md), and for every `npm` command, [`docs/npm-project-commands.md`](../docs/npm-project-commands.md).
