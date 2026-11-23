# x1-validator-private-rpc

![A bronze-armored X1 defender robot with teal eyes holds up a glowing key beside a door marked 443, while shadowy figures stand behind a red line on the floor. At center, a round vault door marked 8899 frames a glowing core whose teal beam falls to the floor. Through a viewport, a bright streak and a storm of sparks cut across space beside a planet. Inspired by Isaac Asimov's story "Reason" (Astounding Science Fiction, 1941; collected in I, Robot).](../assets/images/x1-defender-robot.png "X1 Defender Robot")

## Overview

### What the Tool Is For

`x1console` starts an X1 validator with its full rpc open on port 8899, on every network interface, and advertised to the network. So anyone on the internet can query it, and each query competes with voting for the machine's cpu and bandwidth.

x1-validator-private-rpc makes the rpc private, so that only programs on the validator itself can reach it directly. From outside, only those you give an api key to, your clients, can reach it. They reach it through the keyed url: an https url that carries the key, such as `https://x1-rpc.example.com/KEY`. x1-validator-private-rpc is a command-line tool that you run on the validator, and for now it works only with [`x1console`](https://github.com/BlackBeard085/x1console/tree/main). It's the first feature of X1 Validator Services, a project of tools that run on an X1 validator.

Your use of this tool, including all of its scripts and features, constitutes your agreement that you have read and understood the [Disclaimer](#disclaimer).

### How It Works

The tool's `apply` command sets everything up, in stages, asking before each one that changes something. Its other commands manage the api keys, keep the rpc private, turn private rpc off and on, and take back what `apply` changed:

- `apply` adds `--private-rpc`, a flag built into the validator's software, to `x1console`'s start script, the file `x1console` starts the validator with. From the validator's next start, the flag makes the rpc listen on 127.0.0.1 alone, and the validator no longer advertises it. `x1console`'s scripts query the rpc on 127.0.0.1, with no key, and so does `x1-pinger`, the ping service `x1console` can start. So both still reach the rpc. The tool never restarts the validator: you choose when, as [Restart the Validator](#restart-the-validator) shows.
- `apply` also puts `nginx`, from nginx.org, in front of the rpc, on the validator's public address and port 443 alone. `nginx` forwards only requests whose path starts with one of the keys, and refuses every other one with a 403 before it reaches the validator. Keyed requests beyond a rate limit you can set, which all keys share, get 429 Too Many Requests. `nginx` runs two of nginx.org's modules: njs, which hashes each request's key, and ACME, which gets and renews the certificate from Let's Encrypt. Before Let's Encrypt issues a certificate, it checks that the keyed url's hostname is yours, usually through port 80. The ACME module has it check through port 443 instead, so port 80 stays closed.
- Each client gets api keys of its own. `apply` makes the first key. After that, `add-api-key` makes more, such as for a new client, and `remove-api-key` removes one, such as a key that leaked, so that `nginx` refuses it. The tool stores only a hash of each key, never the key itself, and a hash can't be turned back into its key. So the tool can show you a key only once, when it makes the key. It writes each hash to the api keys' file, with the key's record: the time the key was made, and the client's email, if you give one. A password you choose during `apply`, the x1-validator-services password, encrypts the records, but not the hashes. From that file, the tool writes `nginx`'s list of the hashes, which `nginx` checks each request against. [Api Key Security](#api-key-security) explains why `nginx` can check keys by their hashes alone, with no password.
- An `x1console` update, from its menu entry Update X1 Console, takes `--private-rpc` back out of the start script, and the command `ensure` puts it back. When the update's `git pull` brings new commits, `git` runs the tool's `git` hook, which `apply` installs in `x1console`'s folder, and the hook runs `ensure`. For an update that brings none, `apply` also offers a `cron` job that runs `ensure` every minute. [After an `x1console` Update](#after-an-x1console-update) explains both, and how soon the flag is back. `ensure` also alerts you on Telegram when the rpc turns public, the flag can't go back, `nginx` is down, or the certificate needs attention.
- While `nginx`'s list of the keys' hashes is empty, as after `remove-api-key` removes the last key, `nginx` refuses every request. The key count check, the command `ensure-there-is-at-least-one-rpc-api-key`, alerts you then. A second `cron` job, which `apply` offers with the first, runs it every two hours, as shipped in the tool's settings.
- To make the rpc public again without uninstalling the tool, `turn-off-private-rpc` makes it public from the validator's next start, and leaves everything else in place. `turn-on-private-rpc` makes it private again.
- To uninstall the tool, `undo-apply` takes back what `apply` changed. It leaves `nginx` installed, and prints the commands that remove `nginx`.

### The Standalone Tools

Two standalone tools come with x1-validator-private-rpc: programs of their own, which you start by their paths, not commands of the tool. Once the tool is installed, `nginx` updates with the system's other packages. `validate-nginx-upgrade`, which you run as the first install step, tests on this machine that an `apt` upgrade of `nginx` keeps a keyed url working. `check-my-private-rpc` checks that your keyed url works for a client, such as after the validator's restart.

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

Each run that can change the system shows this disclaimer before it does anything, except a run of `ensure`. `cron` and the tool's `git` hook run `ensure` with nobody at the terminal to answer, and `ensure` skips the disclaimer when you run it yourself too. Runs that change nothing don't show the disclaimer either: the dry runs, and the commands that only check or print. `whiptail` draws the disclaimer in a dialog that takes over the terminal, like the dialogs some packages show as they install. The run goes on only once you choose Affirm, which affirms "I have read and understood the above Disclaimer." Decline, or Esc, stops it with nothing changed, and Ctrl-C does nothing in the dialog. Decline has the focus at first. The left and right arrows move between the two buttons, and Enter chooses the one that has the focus. To scroll the text, press Tab to move to it, then use the up and down arrows, or PgUp and PgDn.

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

**Start every command that runs one of the tool's `.js` files with `nvm exec 24`,** as each command below does. The validator's default `node` is Node.js 20.0.0, which `x1console` installed, and it's too old for the tool. `nvm exec 24` runs one command on Node.js 24 instead. For the tool's commands, [Run](#run) shows how to link its launcher, a small script that starts the tool on Node.js 24, so that the tool's name alone runs it. The standalone tools, `validate-nginx-upgrade` and `check-my-private-rpc`, have no launcher, so on the validator they always need `nvm exec 24`.

### Check That `nginx` Upgrades Keep Working

Once the tool is installed, `nginx` updates with the system's other packages, whenever `apt upgrade` runs, as `x1console`'s Update X1 Validator does. This check, the standalone tool `validate-nginx-upgrade`, proves on this machine that such an upgrade keeps a keyed url working. Run it first, before `apply` installs `nginx`: the check refuses to run while any `nginx` is installed, since it installs and removes `nginx` itself.

The check installs nginx.org's previous release of `nginx`, with a throwaway api key, and runs that `nginx` under `systemd` the way the tool will. Then it upgrades `nginx` with `apt`. nginx.org's upgrade starts a new `nginx` process and hands over to it, without a restart, and the old process then exits. `systemd` tracks a service by its main process, so `systemd` must follow that handover to the new process. If it didn't, one of two things would happen. `systemd` would count `nginx` as stopped, and stop every process left in the service. The old process started the new one inside the service, so `systemd` would stop the new one too, and the keyed url would stop working. Or `systemd` would restart `nginx`, which drops every open connection. The check makes sure neither happened: `systemd` still counts `nginx` as running, now as the new process, with no restart. It also makes sure the new `nginx` still lets the throwaway key through and turns a random one away. Last, it removes everything it added. It never touches the validator's software, port 443 or the firewall.

It takes a few minutes. Run it inside `tmux`, so that a dropped `ssh` connection can't stop it halfway and leave `nginx` installed. If the connection drops, log in again and run `tmux attach` to get back to it. Run it as the validator's account, from the project root, `~/x1-validator-services`. It asks for your `sudo` password. Start `tmux`, then the check:

```bash
tmux
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/util/validate-nginx-upgrade/index.js
```

It ends with `Passed`, or with the reasons it failed. A run that leaves behind something it added fails too. It lists each removal step it couldn't finish, with a `By hand:` command that does that step. Run those commands in the order listed, then run the check again. To stop it early, press Ctrl-C: it finishes the step it's on, then removes everything it added. Once the check has ended, type `exit` to leave `tmux`. Go on with the install only once it passes.

### Point the Hostname at the Validator

Clients reach the rpc through the keyed url's hostname, and Let's Encrypt reaches the validator through it too, to check that the hostname is yours. So the hostname must point at the validator. Add one `A` record at your dns provider: a new name under your domain, such as `x1-rpc.example.com`, with the validator's public ipv4 address. [Manual Domain Setup](docs/manual-domain-setup.md) shows how, for form-based and raw zone-file editors, and how to check the record.

### Set the Hostname

The tool reads your settings from one file, which it merges over its shipped defaults, so the file needs only the settings you change. From the project root, make the file by copying the example:

```bash
cd ~/x1-validator-services
cp x1-validator-private-rpc/app-config/app-defaults-for-user-configurable/private-rpc.example.json \
   x1-validator-private-rpc/app-config/user-configurable/private-rpc.json
```

Then, in the copy, set `hostname` to the name from the last step, and `publicIp` to the validator's public ipv4 address, which `nginx` listens on. Or delete `publicIp`, to use the address the X1 network sees for your validator. Set `acmeEmail` to a contact address for Let's Encrypt, or delete it for none. Since June 2025, Let's Encrypt keeps no copy of the address, and sends no warning before a certificate expires. `ensure` warns you on Telegram instead, as [Alerts](#alerts) says. Let's Encrypt passes the address on to the mailing list system of ISRG, the nonprofit behind Let's Encrypt, as [Let's Encrypt's notice](https://letsencrypt.org/2025/06/26/expiration-notification-service-has-ended/) says. That system may send you an email about how to subscribe. [Configure](#configure) says where every setting is described, and what to run after you change one.

### Run apply

`apply` works in eight stages. Stage 1 checks the machine, and changes nothing. If it finds problems, `apply` lists them all and stops. Otherwise `apply` goes through stages 2 to 7, asking "Go on?" before each one:

- stage 2: `nginx` from nginx.org
- stage 3: the firewall rule for port 443
- stage 4: the x1-validator-services password and the first api key
- stage 5: `nginx`'s configuration and start
- stage 6: the start-script flag
- stage 7: the `git` hook. Then one question offers the two `cron` jobs, which run `ensure` and the key count check. Last, a test alert on Telegram, when `x1console`'s bot is set up.

Stage 8 changes nothing: it says whether to restart the validator, and prints the url. When the run made a key, the url shows only that key's last four characters, since stage 4 showed the key in full. Otherwise the url shows `KEY` in place of the key.

Until you restart the validator, its rpc still listens on every interface. So once stage 7 has installed `ensure`'s `cron` job, `ensure` alerts you within a minute that the rpc is public, and repeats the alert until the restart, as often as the `exposedReminderMinutes` setting says.

First have a look at what `apply` would do. With `--dry-run`, it prints each change it would make, and makes none. `sudo` may still ask for your password, since stage 1 reads the firewall's rules as root:

```bash
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply --dry-run
```

The first run that sets the tool up, the staging run, is started with `--acme-staging`. With it, `apply` gets the certificate from Let's Encrypt's staging service, whose certificates no client trusts. At stage 5, `nginx` starts, and its ACME module asks Let's Encrypt for the certificate. Stage 5 waits for the certificate as long as the `certificateWaitSeconds` setting says, and stops the run if none comes. A mistake, such as a dns record Let's Encrypt can't see yet, makes the request fail. Let's Encrypt allows only five failed requests an hour for one hostname, but failures at the staging service don't count toward that limit. So a mistake found on the staging run can't hold up the real certificate.

During the staging run, at its stage for the first api key, `apply` asks for a new x1-validator-services password, typed twice, with at least as many characters as the `passwordMinLength` setting says. Then `apply` makes the first api key. It writes the key's hash and record, with no email, to the api keys' file, `~/.config/x1-validator-services/hashed-api-keys.json`. Then it prints the key's two urls, https and wss, with the key in them. **Save them now, off the validator**: the client needs them, and so do you, to remove the key later, since no command can show the key again. None of the tool's files on the validator holds a usable key, but a url saved there would give one to anyone who breaks into the validator or copies its disk.

Then `apply` says how `systemd` would protect a saved password on this machine, and asks whether to save the password there. If you forget the password, `add-api-key` can't make a key, and you can recover the password only if you saved it. Features to come will also use a saved password to read the records unattended: billing, and rotation notices, which will email a key's client when the key is due to be replaced. None of the tool's commands reads a saved password yet, and `nginx` never needs it. [Api Key Security](#api-key-security) says what `systemd`'s protection guards against, and how root reads a saved password back.

`apply` asks whether to save the password only right after it makes the first key. It makes the first key only while the api keys' file holds no key's hash. So if you answer no, or stop the run at the question, such as with Ctrl-C, no later run asks again, and the password stays unsaved.

`--yes` answers yes to each stage's "Go on?" and to the question about the `cron` jobs, so that `apply` runs on without stopping at them. You still affirm the disclaimer, type the password, and answer the save question.

Start the staging run inside `tmux`, as with the upgrade check, so that a dropped `ssh` connection can't stop the run at the save question, which no later run asks again:

```bash
tmux
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply --acme-staging
```

Every stage first checks whether its work is done, so running `apply` again changes nothing that's in place. If it stops partway, fix any problem it names, then run it again with the same options, and it picks up from there. So after a staging run that stopped, such as at stage 5 with no certificate, run `apply` with `--acme-staging` again. A key it made and showed stays, so the next run makes none.

A run also stops at stage 5 if `nginx` refuses the configuration the stage wrote. The stage has `nginx` test the configuration, and starts, restarts or reloads `nginx` only once the test passes. So the refused configuration never reaches a running `nginx`, and `nginx` stays as it was. `apply` then puts the stage's files back as they were before the run, so that a later start of `nginx`, such as at a reboot, doesn't load the refused files. `apply` also writes what `nginx` refused, and why, to `x1-validator-private-rpc/logs/error.log`.

If you stop `apply` before stage 6, its flag stage, the start script stays as it was. `ensure`, whether `cron`, the `git` hook or you start it, adds the flag only when stage 6 or `turn-on-private-rpc` has turned private rpc on.

A staging run that finishes gets its certificate at stage 5. The staging service checks that the hostname is yours the same way as for a real certificate, so that run shows that Let's Encrypt can check your hostname. Once the staging run has finished, and you've saved the key's urls, type `exit` to leave `tmux`, so that its scrollback doesn't keep the urls on the validator. The next run, without `--acme-staging`, gets the real certificate. It changes `nginx`'s configuration, but not the api keys, so the key from the staging run stays valid. It asks for no x1-validator-services password. Start it from the project root:

```bash
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply
```

### Restart the Validator

The validator reads its flags only when it starts, so `--private-rpc` takes effect at its next start. In `x1console`, choose 2. Validator, then 1. Start/Restart Validator, at a moment when the Validator screen shows no leader slot coming soon. The keyed url works before the restart too: `nginx` forwards to the rpc on 127.0.0.1, and until the restart the rpc listens on every interface, 127.0.0.1 among them.

After the restart, check from another machine that the rpc no longer answers on the validator's address. This should fail to connect:

```bash
curl -m 5 http://203.0.113.10:8899/health
```

Replace `203.0.113.10` with the validator's address. Then check the keyed url with `check-my-private-rpc`, as [Check](#check) describes.

### Cronitor Heartbeat

`ensure` runs every minute, from the `cron` job that `apply` installs when you accept it. If that job ever stops working, for example because the project's folder moved or the tool's settings have a typo, the flag can stay out of the start script after an `x1console` update, and `ensure`'s alerts stop. Nothing on the validator tells you that the job has stopped, or that the flag is out. So at the end of each run, `ensure` checks in with a web request to Cronitor, a monitoring service off the validator. These check-ins are the heartbeat. Cronitor alerts you when they stop, and sends nothing while they keep coming, whatever `ensure` finds. Without that job, don't set up the heartbeat: no run would check in each minute, and Cronitor would keep alerting.

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

The tool's launcher, `x1-validator-private-rpc/bin/x1-validator-private-rpc`, runs the tool on the newest Node.js 24 that `nvm` holds. Once you link it into `~/.local/bin`, typing `x1-validator-private-rpc COMMAND` in any folder does the same as `nvm exec 24 node x1-validator-private-rpc/src/cli.js COMMAND` in the project root. To link the launcher:

```bash
mkdir -p ~/.local/bin
ln -sf ~/x1-validator-services/x1-validator-private-rpc/bin/x1-validator-private-rpc ~/.local/bin/x1-validator-private-rpc
```

Ubuntu's default profile adds `~/.local/bin` to your PATH as you log in, if the folder exists by then. So if typing the tool's name gives `command not found`, log out and back in.

### Usage

Each task has a section below: [Api Keys](#api-keys), [Check](#check), [After an `x1console` Update](#after-an-x1console-update), and [Turn the Private Rpc Off and On](#turn-the-private-rpc-off-and-on). [Alerts](#alerts) says what `ensure` and the key count check send you on Telegram. The `--help` of each command and of each standalone tool gives its options, an example of each common use, and what each exit code means. [`docs/project-commands.md`](docs/project-commands.md) lists every command and standalone tool, with its options and an example of each common use.

#### Api Keys

`add-api-key` makes one key, or as many as `--count` says, such as three for one client's three apps. It first checks that the api keys' file has room for them under the `maxApiKeys` setting, and refuses if the file doesn't. Then it asks for your x1-validator-services password, which encrypts the new keys' records. It goes on only with the password you chose during `apply`. Next it asks for one email, the client's, to write into every new key's record. The email shows as you type. Press Enter for none. Then it makes the keys, and prints each key's https and wss urls. Save them now, off the validator, since no command can show these keys again.

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js add-api-key --count 3
```

`remove-api-key` removes a key. It asks for the key, which you paste at a prompt that shows nothing. It asks no x1-validator-services password: it hashes the key you paste, and looks for that hash in the api keys' file, where the hashes aren't encrypted. Since it needs the key itself, a key you no longer have stays valid until `undo-apply` deletes every key. Removing the last key asks first, since `nginx` then refuses every request:

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js remove-api-key
```

When you have a key but not its urls, such as a key you saved on its own, the command `url` prints the url's two forms, https and wss, with `KEY` in place of the key. It also says how many keys `nginx`'s list holds:

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js url
```

Writing `nginx`'s list needs `sudo`, so `add-api-key` and `remove-api-key` may ask for your account's `sudo` password. They ask after their own questions and before they change anything, so a wrong or cancelled password changes nothing.

Both then write `nginx`'s list, and reload a running `nginx`, so it reads the new list. Once the reload is done, a new key works, and a removed one is refused, on each connection opened from then on. A reload takes a moment, up to a second or two with hundreds of thousands of keys. `nginx` serves requests from a worker process. A reload starts a new worker, under the new list, and leaves each connection that's already open with the old worker, under the old list. The old worker closes each https connection as soon as no request is under way on it, so the client's next request opens a new connection, to the new worker. But a websocket's key is checked only when the websocket opens, and the websocket stays open as long as it streams, so a removed key's websocket would stay open on the old worker. So the tool's configuration has the old worker close every connection it still holds 10 seconds after a reload. Within 10 seconds of the reload, then, a removed key stops working on every connection. After `add-api-key` or `remove-api-key`, every websocket opened before the reload closes too, whatever its key, and its client must reconnect.

Only one command changes the keys at a time. While `apply`, `undo-apply` or another key command is changing the keys, `add-api-key` and `remove-api-key` refuse, change nothing, and say to run the command again once the other one is done.

If `remove-api-key` stops partway, for any reason, run it again with the same key, before any other key command or `apply`. It takes the key's hash out of `nginx`'s list first, and out of the api keys' file, `hashed-api-keys.json`, last. So a stop in between leaves the hash in that file. `add-api-key`, `remove-api-key` for another key, and `apply` each write `nginx`'s list from that file. So each would put the removed key's hash back in the list, and the key would work again. [The Keys' Path](docs/architecture.md#the-keys-path), in `docs/architecture.md`, says more.

#### Check

`check-my-private-rpc` checks once that your keyed url works for a client, such as after the validator's restart, or when a client reports a problem. It asks for the rpc's hostname and the api key at prompts, never as arguments, so the key stays out of your shell's history. The key doesn't show as you type. Then the check sends the rpc a run of queries through `nginx`, one right after another, as many as the `checkQueryCount` setting says, and prints a table of the answers. It ends with a green ✔ when every query worked, or a red ✘ and what went wrong.

Take the hostname and the key from a url that `apply` or `add-api-key` printed: the hostname follows `https://`, and the key follows the hostname. Run the check from the project root, on the validator or on any machine where the project is installed:

```bash
nvm exec 24 node x1-validator-private-rpc/util/check-my-private-rpc/index.js
```

On a machine without `nvm`, start the check with a `node` that's Node.js 24 or newer, in place of `nvm exec 24 node`.

#### After an `x1console` Update

An Update X1 Console takes `--private-rpc` out of the start script, and `ensure` puts it back. `x1console`'s folder is a `git` checkout, and Update X1 Console runs `git stash` there, then `git pull`. `git stash` saves every edit nobody committed, then undoes those edits in the folder's files. The flag is the tool's own edit to an `x1console` file, and nobody commits it. So the stash takes the flag out of the start script, and the update never applies the stash back. When the pull merges new commits, `git` runs the tool's `git` hook, and the hook's `ensure` puts the flag back before the update finishes. A pull with nothing new merges nothing, so `git` runs no hook. In that case, the `cron` job's `ensure` puts the flag back. Either way, `ensure` sends an alert that it put the flag back.

An `ensure` that `cron` starts, or that you run yourself, doesn't put the flag back while `x1console` may be updating. During an update, `ensure` can't tell whether the update's pull will change the start script. If the pull does change the script, and `ensure` has put the flag back after the stash, the pull fails, since `git` won't overwrite an edit nobody committed. So `ensure` leaves the script alone until the script has gone unchanged for `startScriptQuietSeconds`, 30 seconds as shipped. The stash changes the script, and the pull usually ends a few seconds after it. So by the time the script has gone unchanged for `startScriptQuietSeconds`, the pull is over. Since the `cron` job runs once a minute, the flag is back 30 to 90 seconds after the update. The hook's `ensure` doesn't wait, since `git` runs the hook only once the pull's merge is done.

Without the `cron` job, run `ensure` yourself after each update, once `startScriptQuietSeconds` has passed, since a sooner run leaves the script alone.

While the flag is out, the running validator keeps its private rpc, since it read its flags when it started. Only a restart in that time would start it with a public rpc. Autopilot can make such a restart on its own, such as after it updates the validator's software. If you accepted the `cron` job, `ensure` then alerts you that the rpc is public. Once `ensure` has also alerted you that it put the flag back in the start script, restart the validator when no leader slot is coming soon, as in [Restart the Validator](#restart-the-validator). The validator then starts with the flag.

Update X1 Validator restarts the validator, so the start script must carry the flag before you choose it. Even with the `cron` job, the flag can be out for up to 90 seconds after an Update X1 Console. So before Update X1 Validator, run `ensure`, and check that it says the start script carries `--private-rpc`:

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js ensure
```

If `ensure` says instead that `x1console` may be updating, so `ensure` left the start script alone, run `ensure` again once the script has gone unchanged for `startScriptQuietSeconds`. [`x1console`'s Updates and Autopilot's Restarts](docs/architecture.md#x1consoles-updates-and-autopilots-restarts), in `docs/architecture.md`, explains each time the script lacks the flag, and for how long.

#### Turn the Private Rpc Off and On

To make the rpc public again without uninstalling the tool, run `turn-off-private-rpc`. It asks you to confirm, then takes `--private-rpc` out of the start script, so the rpc listens on every interface again from the validator's next start. It also records that private rpc is off, so `ensure` no longer puts the flag back, and no longer checks that the rpc is private. Everything else stays: `nginx` keeps serving the keyed url, and `ensure` keeps checking `nginx` and its certificate. To make the rpc private again, `turn-on-private-rpc` puts the flag back, and records that private rpc is on again:

```bash
nvm exec 24 node x1-validator-private-rpc/src/cli.js turn-off-private-rpc
nvm exec 24 node x1-validator-private-rpc/src/cli.js turn-on-private-rpc
```

Restart the validator as in [Restart the Validator](#restart-the-validator), for the change to take effect. A run of `apply`, such as after an [update of the tool](#update) or a change to a setting, turns private rpc on again, since its flag stage puts the flag back and records that private rpc is on. If `ensure` is changing the start script at the moment you answer `turn-off-private-rpc`'s question, `turn-off-private-rpc` refuses, changes nothing, and says to run it again.

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
| No api key | `nginx`'s list of the keys' hashes is empty, so `nginx` refuses every request | Every `apiKeyCountCheckHours`, while the list stays empty |

The first two stay quiet in two cases: before `apply` or `turn-on-private-rpc` has turned private rpc on, and after `turn-off-private-rpc` has turned it off. In both, `ensure` doesn't check the start script for the flag, or check that the rpc is private. When an alert from `ensure` fails to send, because Telegram can't be reached or refuses it, `ensure` sends it at its next run. Without `x1console`'s Telegram files, its bot's token and chat id, `ensure` and the key count check only print their alerts. The `cron` jobs add what both print to `ensure`'s log, `x1-validator-private-rpc/logs/ensure.log`.

Two checks send no alert: whether the running validator carries `--private-rpc`, and whether `nginx` listens on the public address's port 443 alone, with nothing on port 80. The `cron` job runs `ensure` with `--quiet`, which prints only what `ensure` changed and its alerts, so these two checks stay out of `ensure`'s log. Their problems show only when you run `ensure` yourself: in its exit code, and, without `--quiet`, in its output. A validator running without the flag still sets off an alert, though: its rpc listens on every interface, and the alert that the rpc is public reports that.

---

## Configure

Your settings go in `x1-validator-private-rpc/app-config/user-configurable/private-rpc.json`, the file [Set the Hostname](#set-the-hostname) made. The [README in its folder](app-config/user-configurable/README.md) says what the file holds, and where every setting is described. After changing any setting, run `apply` again. It rewrites what the change affects, such as `nginx`'s configuration. If you had turned private rpc off, run `turn-off-private-rpc` again once `apply` is done, since `apply` turns private rpc back on.

One setting you may want to change is `rateLimitRequestsPerSecond`: how many keyed requests a second `nginx` forwards to the rpc, all keys together. If your clients get 429 Too Many Requests, raising it lets more of their requests through, but each one competes with voting, as [What the Tool Is For](#what-the-tool-is-for) explains.

The `hashedApiKeysMapPath` setting says where the tool writes `nginx`'s list of the keys' hashes. `apply` writes that path into `nginx`'s configuration, and `nginx` reads the list from there. After changing the setting, run `apply` straight away, with no other command of the tool before it. Until `apply` rewrites `nginx`'s configuration, `nginx` keeps reading the list at the old path, while the tool's other commands use the new path at once. So `remove-api-key` would write a list that `nginx` doesn't read, and the removed key would keep working.

The `hashedApiKeysPath` setting says where the api keys' file is. To move that file, move the file itself first, then change the setting, then run `apply`. With no file at the new path, `apply` treats the machine as a first install: it makes a new first key under a new password, and writes `nginx`'s list with that key's hash alone. Every key your clients hold then stops working.

Non-standard settings for the programs the tool uses, such as `nginx`, aren't fully supported. A non-default `acmeStatePath`, this tool's setting for the folder where `nginx` keeps its certificates, is one example. There, the only gap is that when you purge `nginx` after `undo-apply`, that folder's files stay behind.

The Cronitor url is a credential, so it goes in the project root's `.env` instead, as [Cronitor Heartbeat](#cronitor-heartbeat) shows.

[examples/](examples/README.md) holds an example of each file `apply` renders, with placeholders for your values.

---

## Update

The tool has no releases: an update brings the newest code from the project's `main` branch. When you run `apply` after an update, it rewrites the files it wrote for `nginx`, and the tool's `cron` lines, wherever the new version writes them differently. nginx.org's `apt` repository stays as the first `apply` set it up.

An update can raise the Node.js version the tool needs. The tool's `cron` lines and its `git` hook each start the tool with the full path of the Node.js that ran the last `apply`, so after such an update they still name the older Node.js. The tool checks its Node.js before anything else, so every run they start stops at once. Then `ensure` puts no flag back, and neither it nor the key count check sends an alert. So run `apply` as soon as the new code and its packages are installed: `apply` rewrites the lines and the hook when they name another Node.js, or an old path to the tool.

From the project root, get the new code with `git pull`. Then install the newest release of Node.js 24, beside any older one, with `nvm install 24`, since the new code may need a newer release than the one you have. When `nvm` holds that release already, the command installs nothing. Install the tool's Node.js packages on that release with `npm ci`, as the project's [Get the Code](../README.md#get-the-code) does. Last, run `apply` on that release, so that the `cron` lines and the hook name it. Each step, in order:

```bash
cd ~/x1-validator-services
git pull
nvm install 24
nvm exec 24 npm ci --omit=dev --ignore-scripts
nvm exec 24 node x1-validator-private-rpc/src/cli.js apply
```

If you had turned private rpc off, run `turn-off-private-rpc` again once `apply` is done, since `apply` turned it back on.

`apply` doesn't upgrade `nginx` or its two modules: `apt upgrade` does, as [Check That `nginx` Upgrades Keep Working](#check-that-nginx-upgrades-keep-working) explains.

---

## Uninstall

To uninstall the tool, run `undo-apply`. `apply` records each change it makes on the machine, such as a file or a firewall rule it adds, with what was there before, in `x1-validator-private-rpc/app-data/what-apply-changed.json`. `undo-apply` takes back only those changes, newest first. What was there before `apply`, such as a firewall rule you added, stays.

To make the rpc public for a while and keep everything else, use `turn-off-private-rpc` instead, as [Turn the Private Rpc Off and On](#turn-the-private-rpc-off-and-on) shows. `nginx` then keeps serving the keyed url, which `undo-apply` stops.

If you set up the [Cronitor heartbeat](#cronitor-heartbeat), pause or delete its monitor before you run `undo-apply`. `undo-apply` removes `ensure`'s `cron` line, so the check-ins stop, and Cronitor would alert you.

Look at what `undo-apply` would do first, then run it:

```bash
cd ~/x1-validator-services
nvm exec 24 node x1-validator-private-rpc/src/cli.js undo-apply --dry-run
nvm exec 24 node x1-validator-private-rpc/src/cli.js undo-apply
```

First `undo-apply` asks one question: whether to delete every api key, with the saved password if `apply` saved one. One answer covers both, since the password decrypts nothing but the keys' records. So a no leaves both in place. A later `apply` then writes `nginx`'s list from the same keys' hashes, and your clients' urls work again. After a yes, a later `apply` makes a new first key under a new password, and every client needs a new url. Then `undo-apply` removes each of these that `apply` made:

- the `cron` lines, and the tool's `tmp/` and `logs/` folders, with `ensure`'s log and the tool's error log in them
- the `git` hook
- the start-script flag, and the copies of the start script that `apply` saved beside it before adding the flag
- the files the tool wrote for `nginx`, its list of the api keys' hashes among them, whatever the answer
- the saved password, unless you kept it, and the folders made for it and for the api keys' file, once nothing else is in them
- the firewall rule

Once the start-script flag is out, the running validator's rpc stays unchanged until the validator's next start, since the validator read its flags when it started. So to make the rpc public, restart the validator from `x1console`, as in [Restart the Validator](#restart-the-validator). `undo-apply` reminds you to restart, unless the running validator already lacks the flag: its rpc is public then, and a restart changes nothing.

The start script may also carry a `--private-rpc` that `apply` didn't add: one you added by hand, or with `turn-on-private-rpc` after an `apply` that stopped before stage 6, its flag stage. `undo-apply` leaves that flag, so the rpc stays on 127.0.0.1 after the validator's next start. `undo-apply` says so, in place of the reminder to restart. If you want the flag gone, take it out of the start script by hand, after `undo-apply` and before the restart. If you took the flag out before `undo-apply`, `ensure` would put a `--private-rpc` back, as it does after an `x1console` update. Since `apply` added no flag, `undo-apply` would leave that one too.

`undo-apply` never removes a package, since something else may need one. So `nginx` stays installed, with its two modules. `undo-apply` stops, disables and masks it. With the files the tool wrote for `nginx` gone, a start of `nginx` would run the package's own configuration, `/etc/nginx/nginx.conf`, and its default site. The mask stops anything from starting it. `nginx`'s configuration in `/etc/nginx`, its certificates in `/var/cache/nginx`, its logs in `/var/log/nginx`, its account and nginx.org's `apt` repository stay too.

A later `apply` refuses an installed `nginx` unless `x1-validator-private-rpc/app-data/what-apply-changed.json` shows that `apply` installed it. So `nginx`'s packages, its account, nginx.org's repository and the mask stay listed in that file. With these entries, a later `apply` treats this `nginx` as one it installed, and reuses `nginx`'s certificate. `undo-apply` says what stays, and why, as it runs.

If you want `nginx` gone, purge it, then run `undo-apply` again, which removes `nginx`'s account, nginx.org's repository and the mask:

```bash
cd ~/x1-validator-services
sudo apt-mark unhold nginx   # only if you hold it
sudo apt purge nginx nginx-module-njs nginx-module-acme
nvm exec 24 node x1-validator-private-rpc/src/cli.js undo-apply
```

If you removed `nginx` yourself with `apt remove` before running `undo-apply`, its configuration, certificates and logs may still be there. `undo-apply` leaves them. If you want them gone, `sudo apt purge nginx` deletes those folders, as `undo-apply` says.

Whatever a run of `undo-apply` doesn't take back, such as a step that failed, stays listed in `x1-validator-private-rpc/app-data/what-apply-changed.json`, for a later run, as `undo-apply` says when it ends. Running `undo-apply` again retries the failed steps, and asks the question again while the api keys' file is there. Once nothing is left, `undo-apply` removes `app-data/`, with that file in it.

---

## Api Key Security

- **Hashes for `nginx`.** `nginx` reads only each key's SHA-256 hash, from an unencrypted list, `/etc/nginx/x1-validator-private-rpc/hashed-api-keys.map`, and checks a request by hashing the key it carries. A random 256-bit key can't be worked back from its hash. A guessed key works if its hash matches any hash in the list, so each hash the list holds makes a guess likelier to work. Even with the list at its 500,000 limit, an even chance of finding any one key would take about 5×10⁴² years at the whole Bitcoin network's rate. So none of the tool's files on the validator holds a usable key, and the list needs no encryption. With nothing to decrypt, `nginx` never needs a password: a restart of `nginx`, or a reboot, needs nobody to type one.
- **Never an argument.** A key is never a command's argument, so no other user sees it in a process list.
- **Encrypted records.** Every value of a key's record is encrypted with your x1-validator-services password, with AES-256-GCM. The encryption key comes from the password, through PBKDF2-SHA-512 at 600,000 iterations. [LP Ranger](https://github.com/nottoseethesun/lp-ranger), another project by the same author, stores private keys the same way. Only your account can read the api keys' file. Its folder, `~/.config/x1-validator-services`, is named for the whole project, so that the project's later features can keep their own files there too.
- **No key in the access log.** `nginx` writes its usual `access.log` and `error.log` in `/var/log/nginx`. The access log shows `<key>` in place of anything that looks like a key, anywhere in the url, a mistyped one included.
- **No key in the error log.** `nginx` has no setting for the error log's format, so it can't write `<key>` there in place of a key, as it does in the access log. Each line `nginx` writes there about a request quotes the request line just as the client sent it, and the request line holds the url, key and all. So the tool keeps those lines out of `error.log`. The part of `nginx`'s configuration that forwards keyed requests writes no error log: it sends those lines to `/dev/null`. But `nginx` picks that part only once it has read a request's header. The line for an error that comes before then also quotes the request line, as far as the client sent it, so that line must be kept out of `error.log` another way. Three things a client can do set off such an error: stall partway through its header, hang up partway through it, or send a header line `nginx` can't read. `nginx` writes each such error at its info level, one level below notice. The tool's configuration writes only notice and above to `error.log`, so such errors never reach it.
- **Who can read the logs.** Both logs hold each client's address. Root, `nginx` and the `adm` group can read them, as with any `nginx` from nginx.org's package, and the package's `logrotate` rule keeps 52 days of them.
- **A nightly `[emerg]` line.** About once a night, `nginx` writes an `[emerg] chown("/dev/null", …) failed` line to `error.log`. The line needs nothing from you. It comes from sending the keyed requests' error lines to `/dev/null`. When `logrotate` has `nginx` reopen its logs each night, `nginx` tries to make its account the owner of each of them, `/dev/null` among them. The tool runs `nginx` with a read-only `/dev` of its own, so that change fails, and the machine's `/dev/null` stays root's. [Keys in `nginx`'s Logs](docs/architecture.md#keys-in-nginxs-logs), in `docs/architecture.md`, explains why the machine's `/dev/null` must stay root's.
- **A saved password.** `systemd` encrypts a saved password. When the machine has a usable TPM2 chip, `systemd` ties the encryption to the chip, so a copy of the disk alone can't decrypt the password. Without a chip, the key that decrypts the password sits on the same disk, so a copy of the disk gives the password up.
- **A lost password.** If you saved it, root can read it back: `sudo systemd-creds decrypt --name=x1-validator-services-password /etc/credstore.encrypted/x1-validator-services-password -`. If you didn't, it can't be recovered: nothing can read the records, and `add-api-key` can't make a key, though the keys you have keep working. To start over, run `undo-apply`, and let it delete every key. Then run `apply`, which makes a new first key under a new password, and make each client a key of its own with `add-api-key`.

---

## Test

The tests are for changing the tool, on a development machine. A validator never runs them, and using the tool needs none.

On a development machine, install the project's packages with `npm ci`, as the project's [Development](../README.md#development) section says, and run every `npm` command from the project root. The tool has two kinds of test. The unit tests give the tool a stand-in for the system, so none of them touches the machine. The system test runs the tool with the real `apt`, `systemd`, `nginx`, `ufw` and `cron`, in a throwaway Ubuntu 24.04 LXD container on your development machine. `npm test` runs every test in the project, the tool's unit tests included, except the system test. Run it after each change. `npm run test:system` runs the system test, and it alone needs LXD. Run it before you merge a change to the tool's code. [The System Test](../docs/engineering.md#the-system-test), in the project's `docs/engineering.md`, says what it checks.

Set up LXD once, on Ubuntu, and add your account to the `lxd` group, which lets the test use LXD without `sudo`:

```bash
sudo snap install lxd
sudo lxd init --auto
sudo usermod -aG lxd "$USER"
```

Log out and back in, so that the group change takes effect. Then run the test. It takes about ten minutes, and the container needs internet access:

```bash
npm run test:system
```

GitHub can run the same test on its own runner, with no LXD on your machine: start the System Test workflow by hand, in the repository's Actions tab.

---

## Development

For an overview of how the tool works, see **[`docs/architecture.md`](docs/architecture.md)**. It covers the parts the tool arranges on the validator, the path of a request and of the keys, and who restarts what.

For engineering details, see **[`docs/engineering.md`](docs/engineering.md)**. It covers the modules, the record of what `apply` changed, every file the tool reads and writes, the order its commands do things in, and the tests. Its [Integration with `x1console`](docs/engineering.md#integration-with-x1console) section details where the tool and `x1console` meet: the start script, the `git` hook and the Telegram set-up.

For how the whole project is checked, see the project's [`docs/engineering.md`](../docs/engineering.md), and for every `npm` command, [`docs/npm-project-commands.md`](../docs/npm-project-commands.md).
