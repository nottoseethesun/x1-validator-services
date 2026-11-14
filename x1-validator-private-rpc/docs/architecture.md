# x1-validator-private-rpc — System Architecture

x1-validator-private-rpc turns an X1 validator's public rpc into a private one, and puts it behind an https url that carries an api key. It does that by arranging programs on the validator. x1console's start script, the validator itself, systemd and cron are there already, and `apply` adds nginx, from nginx.org. The tool is a command-line program that sets those parts up, keeps them that way, and takes them back down. It never runs as a server of its own.

Companion references:

- [The feature's README](../README.md): how to install it, run it and use it.
- [`engineering.md`](engineering.md): the modules, the records and files the tool writes, the order things happen in, and the tests.
- [`docs/engineering.md`](../../docs/engineering.md): the project's gate, scripts and system test.
- [`docs/npm-project-commands.md`](../../docs/npm-project-commands.md): every npm command.

---

## Table of Contents

- [The Parts](#the-parts)
  - [The Validator and x1console](#the-validator-and-x1console)
  - [nginx](#nginx)
  - [The Tool](#the-tool)
  - [The Watchers](#the-watchers)
  - [Services Outside the Machine](#services-outside-the-machine)
- [The Request Path](#the-request-path)
- [The Key's Path](#the-keys-path)
- [Setting Up and Taking Down](#setting-up-and-taking-down)
- [Keeping It That Way](#keeping-it-that-way)
- [Restarts](#restarts)
- [Privileges](#privileges)
- [Security Model](#security-model)
- [Technology Choices](#technology-choices)

---

## The Parts

### The Validator and x1console

x1console installs the validator and starts it with one long command in its start script, `start_validator.sh`. Out of the box that command opens the rpc on port 8899, and its websocket on 8900, on every network interface, and the validator advertises the rpc to the X1 network. So anyone can query it, and each query competes with voting for the machine.

One flag changes that: `--private-rpc`. With it, the validator's rpc listens on 127.0.0.1 alone, and the validator stops advertising it. The tool adds that one word to the start script, and takes it out again. The flag reaches the validator only at its next start, which is always the operator's to choose. x1console's Update X1 Console runs `git stash`, which takes the flag back out, so something has to put it back. [Keeping It That Way](#keeping-it-that-way) covers that.

### nginx

nginx, from nginx.org's own apt repository, stands in front of the rpc. It listens on the validator's public address and port 443 alone. Two of nginx.org's modules do the work:

- **The njs module** runs the tool's key check, `src/njs/x1-validator-private-rpc.js`, on every request.
- **The ACME module** gets and renews the certificate from Let's Encrypt through the tls-alpn-01 challenge, which runs on port 443 itself. So port 80 stays closed.

nginx runs under systemd. A drop-in replaces the start command of nginx's own unit with the tool's start wrapper, a short shell script that puts the api key in nginx's environment and then becomes nginx. The package's own configuration, `/etc/nginx/nginx.conf`, stays untouched and unused: the wrapper starts nginx with the tool's configuration instead.

### The Tool

The tool is `src/cli.js`, run as the validator's account. Its commands fall into three groups:

- **Setting up and taking down.** `apply` sets every part up, in stages, and records each setting it changes, with its old value. `undo-apply` puts those old values back, newest first, and touches nothing else.
- **Keeping it running.** `ensure` puts the flag back after an update, checks every part, and sends alerts. `unlock` gives a locked nginx its key.
- **Switching and showing.** `turn-off-private-rpc` and `turn-on-private-rpc` switch the rpc between public and private. `url` shows the full urls, for https and for websockets.

A hidden command, `decrypt-key`, exists for the start wrapper alone. [The Key's Path](#the-keys-path) shows where it fits.

### The Watchers

Two watchers run `ensure`, so nobody has to remember to:

- **A cron job**, when the operator agrees to it during `apply`, runs it every minute. `flock` skips a run while the last one is still going.
- **x1console's git hook**, `.git/hooks/post-merge`, runs it right after an Update X1 Console pulls new commits. It always exits 0, so it can never fail the update.

The hook is fast, and the cron job is the backup that covers what the hook can't: a pull that brought nothing new, which runs no hook but still stashed the flag away.

### Services Outside the Machine

- **Let's Encrypt** issues the certificate. nginx's ACME module talks to it directly.
- **Telegram** carries `ensure`'s alerts, through the bot x1console already uses for its own.
- **Cronitor**, when the operator sets it up, alerts when `ensure`'s check-ins stop. That catches a cron job that broke without a word.

---

## The Request Path

A client's request travels like this:

1. The client connects to the hostname on port 443. dns points the hostname at the validator's public address.
2. nginx completes the tls handshake with its Let's Encrypt certificate.
3. The key check reads the request's path. When the path doesn't start with the key, followed by a slash or nothing, nginx answers 403, and the request goes no further. When nginx holds no usable key, every path gets 403.
4. A keyed request counts against one rate limit, shared by every keyed request. Over the limit, nginx answers 429.
5. nginx strips the key from the path and forwards the request to the rpc on 127.0.0.1. A request that asks for a websocket upgrade goes to the websocket port instead.

What nginx logs, and who can read it, is in the README's [Api Key Security](../README.md#api-key-security) section.

One more path exists, for the tool alone. The gate page, `/x1-rpc-gate`, answers only requests from the machine's own public address. It says `unlocked` when nginx holds a usable key, and `locked` when it doesn't, and never shows the key. `apply`, `unlock` and `ensure` read it to know nginx's state.

---

## The Key's Path

The key is made once, by `apply`: 32 random bytes, written as 64 hex characters. From then on it lives in two places only:

- **The vault**, the file the `vaultPath` setting names, encrypted with the x1-validator-services password. The vault is meant to hold the secrets of future validator services too, under the same password.
- **nginx's memory**, from each start of nginx until it stops.

nginx gets the key at each start, in one of two ways:

- **With the password typed.** `unlock` asks for the password and decrypts the key. `apply` does the same, or makes the key on its first run. Either has sudo write the key to the hand-off file: a memory-only file in a root-only folder under `/run`. Then it restarts nginx. The start wrapper reads the file, deletes it, and starts nginx with the key in its environment.
- **With the password saved.** systemd keeps the password encrypted, as a credential, and at nginx's start decrypts it into a memory-only folder only nginx's service can read. The start wrapper then runs `decrypt-key` as the validator's account, with the password on its standard input, and takes the key from its output.

Either way, the wrapper passes nginx only a well-formed key. With none, nginx starts locked: it runs, and answers every request for the rpc with 403, until `unlock` gives it the key.

---

## Setting Up and Taking Down

`apply` works in eight stages. It asks before each of the six that change something, stages two to seven. The first checks the machine and changes nothing, and stops with every problem it finds. Then come nginx from nginx.org, the firewall rule for port 443, the api key and the password, nginx's configuration and start, the start-script flag, and the watchers. The last says what to do next.

Every setting `apply` changes is recorded the moment it changes, with its old value, in `app-data/what-apply-changed.json`, apply's record. A stage first checks whether its work is done, so running `apply` again changes nothing that's in place, and picks up where a stopped run ended.

`undo-apply` puts back the old value of each setting `apply` changed, newest first, until the machine is as `apply` found it. A setting that was in place before `apply`, such as a firewall rule the operator added, stays. The engineering reference's [apply's Record](engineering.md#applys-record) says what stays on record when a step fails, and when the record goes.

`turn-off-private-rpc` and `turn-on-private-rpc` change only the flag in the start script, and the operator's choice in the tool's state, `app-data/state.json`. nginx, the key and the watchers stay as they are.

---

## Keeping It That Way

`ensure` runs from the watchers, and on demand. Each run:

1. Puts `--private-rpc` back into the start script when it's missing, unless the operator turned private rpc off. It never edits the script in the middle of an x1console update, which a run can tell from git's lock file and from the script's last change.
2. Checks every part: the flag in the script and in the running validator, where the rpc listens, nginx's state and address, the gate page, the certificate, and the start wrapper's paths.
3. Sends the alerts its checks call for, on Telegram, and remembers what it sent, so a lasting problem doesn't alert every minute.
4. Checks in with Cronitor, when a check-in url is set.

While private rpc is off, `ensure` leaves the start script alone, and skips the checks that the rpc is private. Before `apply` has set nginx up, `ensure` does nothing.

---

## Restarts

The tool never restarts the validator. A change to the flag waits for the validator's next start, which the operator makes from x1console at a quiet moment.

The tool restarts nginx when it has to: `apply` when it starts nginx with the key, and `unlock` when it hands over the key. A reboot, or any other restart of nginx, starts nginx locked unless the password is saved. `ensure` alerts when that happens.

---

## Privileges

The tool runs as the validator's account, never as root. Each step that needs root runs as its own command through sudo: package installs, files in system folders, systemd, ufw and the hand-off file. Every effect on the machine, with or without sudo, goes through one module, `src/lib/host.js`, so the tests can put a stand-in in its place.

---

## Security Model

The feature README's [Api Key Security](../README.md#api-key-security) section describes how the key and the password are kept. The project's [`docs/security.md`](../../docs/security.md) records the security checks the gate runs, and every exception to them.

---

## Technology Choices

- **Node.js 20.0.0**, the version x1console installs, so the tool needs nothing new on the validator.
- **nginx from nginx.org**, for its njs and ACME modules. The key check and the certificate then live inside nginx, with no other program to run. nginx.org's packages also upgrade nginx in place, a binary upgrade that keeps the key in the new process's environment. `util/validate-nginx-upgrade/index.js` proves that on each machine before the install.
- **systemd's encrypted credentials** for a saved password, so the tool keeps no secret of its own on disk in the clear.
- **No program of the tool's own runs all the time.** nginx serves, systemd starts it, and cron runs `ensure`.
- **No database.** apply's record and its dictionary, the tool's state, `ensure`'s alert state and the vault are json files.
- **Small, common packages** for the generic parts: commander for the command line, Ajv for the settings' schema, dotenv for `.env`, and ora for the upgrade check's spinner. [CLAUDE.md](../../CLAUDE.md) says which versions, and why.
