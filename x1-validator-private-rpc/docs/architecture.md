# x1-validator-private-rpc — System Architecture

x1-validator-private-rpc turns an X1 validator's public rpc into a private one, and puts it behind an https url that carries an api key. It does that by arranging programs on the validator. `x1console`'s start script, the validator itself, `systemd` and `cron` are there already, and `apply` adds `nginx`, from nginx.org. The tool is a command-line program that sets those parts up, keeps them that way, and takes them back down. It never runs as a server of its own.

Companion references:

- [The feature's README](../README.md): how to install it, run it and use it.
- [`engineering.md`](engineering.md): the modules, the records and files the tool writes, the order things happen in, and the tests.
- [`docs/engineering.md`](../../docs/engineering.md): the project's gate, scripts and system test.
- [`docs/npm-project-commands.md`](../../docs/npm-project-commands.md): every `npm` command.

---

## Table of Contents

- [The Parts](#the-parts)
  - [The Validator and `x1console`](#the-validator-and-x1console)
  - [`nginx`](#nginx)
  - [The Tool](#the-tool)
  - [The Watchers](#the-watchers)
  - [Services Outside the Machine](#services-outside-the-machine)
- [The Request Path](#the-request-path)
- [The Keys' Path](#the-keys-path)
- [Setting Up and Taking Down](#setting-up-and-taking-down)
- [Switching](#switching)
- [Keeping It That Way](#keeping-it-that-way)
- [`x1console`'s Updates and Autopilot's Restarts](#x1consoles-updates-and-autopilots-restarts)
- [Restarts](#restarts)
- [Privileges](#privileges)
- [Security Model](#security-model)
- [Technology Choices](#technology-choices)

---

## The Parts

### The Validator and `x1console`

`x1console` installs the validator and starts it with one long command in its start script, `start_validator.sh`. Out of the box that command opens the rpc on port 8899, and its websocket on 8900, on every network interface, and the validator advertises the rpc to the X1 network. So anyone can query it, and each query competes with voting for the machine's cpu and bandwidth.

One flag changes that: `--private-rpc`. With it, the validator's rpc listens on 127.0.0.1 alone, and the validator stops advertising it. The tool adds that one word to the start script, and takes it out again. The flag reaches the validator only at its next start, which the tool never chooses. `x1console`'s Update X1 Console runs `git stash`, which takes the flag back out, so something has to put it back. [Keeping It That Way](#keeping-it-that-way) covers that.

### `nginx`

`nginx`, from nginx.org's own `apt` repository, stands in front of the rpc. It listens on the validator's public address and port 443 alone. Two of nginx.org's modules do the work:

- **The njs module** runs the tool's key check, `src/njs/x1-validator-private-rpc.js`, on every request, under QuickJS, the engine njs 1.0 recommends. It hashes the key at the start of the request's path. Then `nginx`'s `map`, a lookup table in its configuration, looks the hash up in `nginx`'s list of the keys' hashes, which [The Keys' Path](#the-keys-path) describes.
- **The ACME module** gets and renews the certificate from Let's Encrypt through the tls-alpn-01 challenge, which runs on port 443 itself. So port 80 stays closed.

`nginx` runs under `systemd`. A drop-in replaces the start command of `nginx`'s own unit with one that starts `nginx` with the tool's configuration. It also gives `nginx` its own read-only `/dev`, as [The Request Path](#the-request-path) explains, and makes `nginx`'s log folder before each start when it's missing, as [Setting Up and Taking Down](#setting-up-and-taking-down) says. The package's own configuration, `/etc/nginx/nginx.conf`, stays untouched and unused. `nginx` needs nothing else at a start: no key, and no password.

### The Tool

The tool is `src/cli.js`, run as the validator's account. Its commands fall into four groups:

- **Setting up and taking down.** `apply` sets every part up, in stages, and records each setting it changes on the machine, such as whether a file is there, with its old value. `undo-apply` puts those old values back, newest first, and touches nothing else. It leaves `nginx` installed, since something else may need it.
- **Keeping it running.** `ensure` puts the flag back after an update, checks every part, and sends alerts. `ensure-there-is-at-least-one-rpc-api-key` checks that `nginx`'s list holds a key.
- **The api keys.** `add-api-key` makes keys and shows each one once. `remove-api-key` takes a key away. `url` shows the url's two forms, for https and for websockets, with `KEY` in place of a key, and how many keys there are.
- **Switching.** `turn-off-private-rpc` and `turn-on-private-rpc` switch the rpc between public and private.

### The Watchers

Two watchers run `ensure`, so nobody has to remember to:

- **A `cron` job**, when the operator agrees to it during `apply`, runs it every minute. `flock` skips a run while the last one is still going.
- **The tool's `git` hook**, `.git/hooks/post-merge` in `x1console`'s checkout, runs it right after an Update X1 Console pulls new commits, synchronously, before the update finishes. It always exits 0, so it can never fail the update.

The hook puts the flag back at once, and the `cron` job is the backup for what the hook can't cover. After an update whose pull brought nothing new, `git` runs no hook, but the update's `git stash` still took the flag out.

A second `cron` job, which `apply` adds beside the first, runs `ensure-there-is-at-least-one-rpc-api-key` every `apiKeyCountCheckHours` hours, on the hour. It's a job of its own because it keeps no alert state, so it alerts on every run while the list is empty. Its schedule therefore sets how often that alert repeats. Inside `ensure`, which runs every minute, it would repeat every minute.

Each `cron` line first makes the folders it writes in, whenever they're missing: `tmp/`, which holds `flock`'s lock file, and `logs/`, which holds the log. Otherwise deleting either folder would stop every run without a word, since `flock` can't make its file in a missing folder, and the shell can't open a log there.

### Services Outside the Machine

- **Let's Encrypt** issues the certificate. `nginx`'s ACME module talks to it directly.
- **Telegram** carries `ensure`'s alerts, through the bot `x1console` already uses for its own.
- **Cronitor**, when the operator sets it up, alerts when `ensure`'s check-ins stop. That catches a `cron` job that broke without a word.

---

## The Request Path

A client's request travels like this:

1. The client connects to the hostname on port 443. dns points the hostname at the validator's public address.
2. `nginx` completes the tls handshake with its Let's Encrypt certificate.
3. The key check hashes the key at the start of the request's path, and `nginx`'s map looks the hash up in `nginx`'s list. A path that doesn't start with a well-formed key, followed by a slash or nothing, or whose key's hash isn't in the list, gets 403, and the request goes no further. That happens in `nginx`'s rewrite phase, before the rate limit, so such requests never use up the limit. Each costs one SHA-256 hash, about a microsecond, as [Technology Choices](#technology-choices) measures.
4. A keyed request counts against one rate limit, shared by every key. Over the limit, `nginx` answers 429.
5. `nginx` strips the key from the path and forwards the request to the rpc on 127.0.0.1. A request that asks for a websocket upgrade goes to the websocket port instead.

One more path exists, for the tool alone. The gate page, `/x1-rpc-gate`, answers only requests from the machine's own public address. It says `ok`, which tells `apply` and `ensure` that `nginx` answers with its certificate.

The location that forwards keyed requests, the part of `nginx`'s configuration that handles them, writes no error log. Each of `nginx`'s error lines carries the request line, key and all. And anyone can set some of them off without a key. `nginx` holds at most 1024 connections at once, and its own connections to the rpc count among them, beside the clients'. Once someone fills them, by holding open handshakes or websockets, `nginx` has none left to forward a client's keyed request, and logs an alert for it, request line and all. So anyone could have clients' keys written into the error log. What `nginx` logs, and who can read it, is in the README's [Api Key Security](../README.md#api-key-security) section.

That location sends its error lines to `/dev/null`, so the drop-in has to give `nginx` a read-only `/dev` of its own. Otherwise the nightly log rotation would hand the machine's `/dev/null` to the `nginx` account. Each night `logrotate` has `nginx` reopen its logs. `nginx`'s master then gives each log file to the `nginx` account, unless that account owns it already, so the workers can reopen it too. It makes no exception for a device, so at the first reopen the machine's `/dev/null` would become the `nginx` account's. It would keep that account's number after `undo-apply` removed the account, until a reboot. The next system account made, given that free number, would then own the machine's `/dev/null`. Code that a flaw let run as the `nginx` account could also stop every other account from writing to it, and the validator's start script writes to it. `systemd`'s `PrivateDevices=yes` gives `nginx` that `/dev` of its own. The change of owner then fails there, and the machine's `/dev/null` stays root's. `nginx` logs each failure, about once a night, as `[emerg] chown("/dev/null", …) failed (30: Read-only file system)`, which is expected.

Anyone can take every client's url down, with no key, by filling `nginx`'s 1024 connections. They open connections and send each one its tls handshake and request header a few bytes at a time. While all 1024 are busy, `nginx` turns new connections away. The validator itself keeps running. By default, `nginx` gives a connection's first request 60 seconds to finish its handshake and header, so about 17 new connections a second could keep it full. The tool's configuration gives 5 seconds instead, so the same attack needs about 205 new connections a second, twelve times as many. That raises its cost, but one machine can still open that many. A real client needs one round trip for the handshake with tls 1.3, or two with tls 1.2. The slowest real case, a satellite link with tls 1.2 and one lost packet, takes about 3 seconds. So 5 seconds turns away no real client.

No time limit stops a determined attacker, though. Each later request on a kept-alive connection gets its own 5 seconds. An attacker can send each request's last line together with the next request's first line. The connection is then never idle. When `nginx` runs out of connections, it closes idle ones to make room, so it never closes this one, until its limit of an hour for a kept-alive connection. One machine can hold all 1024 that way. `ensure` alerts within a minute, as "The certificate needs attention", since its certificate check can't reach `nginx`. Only a limit on connections per address would stop one machine from holding them all, and the tool sets none. That risk is accepted as small, given today's attacks.

Such an attack also floods `nginx`'s error log, but it can't fill the disk. While the connections are held, `nginx` logs a line for each further connection it turns away, about 1 MB a second from one machine. The daily rotation compresses each day's log a day later, so about two days' worth, about 190 GB, stays uncompressed. `gzip` packs each older day of such repeated lines into a few GB at most, and nginx.org's rule keeps 52 days. That can't fill the 4 TB disk `x1console` asks for.

---

## The Keys' Path

`apply` makes the first key, when there's none, and `add-api-key` makes more: 32 random bytes each, written as 64 hex characters. The tool shows each key once, as its two urls, as soon as its hash is written to `hashed-api-keys.json`, and never keeps the key itself. It keeps the key's SHA-256 hash, in two places:

- **`hashed-api-keys.json`**, the file the `hashedApiKeysPath` setting names, which holds each hash, unencrypted, with the key's record: when the key was made, and its email. Every value of a record is encrypted with the x1-validator-services password, which is used for nothing else. `add-api-key` asks for the email at a prompt, never as an option. The shell's history would keep an option, and `ps` would show it to every account on the machine.
- **`nginx`'s list**, the file the `hashedApiKeysMapPath` setting names, which `nginx`'s map includes, with one line per hash. The tool writes it from the first file's hashes, with no password.

`nginx` reads its list at each start and each reload. `add-api-key` and `remove-api-key` write both files, and reload a running `nginx`, which keeps answering throughout. A reload takes a moment, longer with more keys, as [Technology Choices](#technology-choices) measures. Until it's done, `nginx` checks against its old list. So for that moment a new key still gets 403, and a removed one still works. After its own reload, `apply` sends test requests through `nginx`, and repeats them until they pass, for up to `certificateWaitSeconds`.

A reload leaves the connections already open with `nginx`'s old worker process, which serves them under the old list until they end. Each request's key is checked when the request arrives, so this matters only for a connection that carries more than one request. What happens to each kind of connection this configuration allows, as `nginx` 1.30.6's source shows:

- **http/1.1, kept alive.** The old worker closes an idle connection at once. It answers a busy one's request, then closes it. The client's next request opens a new connection, which the new list checks.
- **http/2.** The old worker closes an idle connection at once. A busy one gets `GOAWAY`, and the old worker skips every new request on it.
- **A websocket.** Its key is checked once, when it opens. After that it's a tunnel to the rpc, which no list checks again. Left alone, it lasts as long as it streams, or `websocketIdleTimeoutSeconds` after it goes quiet.

So the tool's configuration sets `worker_shutdown_timeout 10s`: 10 seconds after a reload, the old worker closes whatever it still holds. A removed key's websocket ends then, and so does a request the old worker is still answering. Every other websocket ends too, after each `apply`, `add-api-key` and `remove-api-key` that reloads `nginx`, and its client must reconnect, under the new list. So 10 seconds after a reload is done, no connection serves a removed key. The configuration sets no `keepalive_min_timeout`, which would keep an idle connection open through the old worker's shutdown. If it ever did, the 10 seconds would still end that connection.

The 10 seconds can't be kept to keyed requests: `worker_shutdown_timeout` covers every connection the old worker still holds. On this `nginx`, the only other connection that can last that long is a certificate order to Let's Encrypt that the old worker has under way. The time limit cuts it too. That does no harm, since the new worker starts its own order as soon as it runs.

Two commands that change the keys at once would undo each other's change. Each reads `hashed-api-keys.json`, may wait at a question, then writes the whole file and the whole list from what it read. Say `add-api-key` sits at its password prompt while `remove-api-key` removes a leaked key. Then `add-api-key` writes the removed key back, and `nginx` takes it again. So `apply`'s stage for the keys, `add-api-key`, `remove-api-key` and `undo-apply` each hold the api keys' lock, from their read of the file to their last write. `undo-apply` holds it from its question to its end, so no key command changes the keys or `nginx`'s list while it takes them apart. A second command refuses at once, changes nothing, and says to run it again. It doesn't wait, since the first may sit at a prompt for as long as its operator takes.

The lock is `flock`'s lock on the folder of `hashed-api-keys.json`. The command holds the folder open, and the kernel lets go of the lock when the command ends, even when it's killed. So a lock is never left behind, and no lock file is made. `apply` makes the folder, and records it, before it takes the lock. Readers of `nginx`'s list take no lock: `url`, `ensure-there-is-at-least-one-rpc-api-key` and `nginx` itself. The list is written whole and renamed into place, so they always read a whole list.

Each key command writes two files: `hashed-api-keys.json`, which the validator's account owns, and `nginx`'s list, which needs `sudo`. A command that stopped between the two writes would leave them disagreeing. A key gone from `hashed-api-keys.json` but still in `nginx`'s list would keep working, and `remove-api-key`, which looks for the key in the file, would find nothing to remove.

`sudo` asks for the account's password unless it asked in that terminal lately. `add-api-key` writes `nginx`'s list second. If `sudo` first asked at that write, a wrong or cancelled password would stop the command between its two writes. So `add-api-key` and `remove-api-key` run `sudo` after their own questions and before their first write. A refused `sudo` then changes nothing. And since no question comes after it, `sudo`'s memory of the password can't run out while the operator takes their time at one.

`remove-api-key` writes `nginx`'s list first and its file last. Whichever step fails, the file still holds the key, and running the command again removes it. Until then, every other command that writes `nginx`'s list writes it from the file, and so hands the key back: `add-api-key`, `remove-api-key` for another key, and `apply`. So when its write of the file fails, `remove-api-key` says to run it again before any of those.

`add-api-key` writes its file first, shows the new keys at once, before anything else can stop it, and writes `nginx`'s list last. So no key sits in the file that nobody saw. If the list's write fails anyway, the new keys work from the next command that writes the list. `apply`'s stage for the keys keeps the same order, and a stopped `apply` is run again, which writes the list from the file.

`remove-api-key` needs the key itself, pasted, so a key nobody has any more stays valid until `undo-apply` deletes every key.

The password can be saved with `systemd`'s encrypted credentials. Nothing reads a saved password yet. It's there so that features to come can read the records unattended: billing, and rotation notices, which will email a key's client when the key is due to be replaced. `nginx` never uses it.

With no hash in its list, `nginx` refuses every request. Only `remove-api-key` can empty the list, and it asks before it removes the last key. `ensure-there-is-at-least-one-rpc-api-key` counts the list's lines every `apiKeyCountCheckHours` hours, and alerts on every run while it's empty. The commands that write the list count its lines the same way, and say at once when it's empty.

---

## Setting Up and Taking Down

`apply` works in eight stages, and asks before each one that changes something. The engineering reference's [Sequence View](engineering.md#sequence-view) lists them.

Every setting `apply` changes on the machine is recorded the moment it changes, with its old value, in `app-data/what-apply-changed.json`, apply's record. Such a setting is, for example, whether a file, folder, package or firewall rule is there. A stage first checks whether its work is done, so running `apply` again changes nothing that's in place, and picks up where a stopped run ended.

`apply` has `nginx -t` test each new configuration before `nginx` uses it. When `nginx -t` refuses one, `apply` puts back every file it wrote as it was, removing any it made new, and stops. It keeps what it wrote, and why `nginx` refused it, in the tool's `logs/error.log`.

Refused files left in place would be a trap, since nothing reads them at once. `nginx` reads its configuration only when it starts or reloads, and runs on that copy in between. `systemd` applies the drop-in only when it starts `nginx`. And `apply` has `nginx -t` test the files it wrote before `systemd` reads the drop-in, and before `nginx` starts, restarts or reloads. So the refused files would no longer match what `nginx` and `systemd` run. A later `apply` would find them in place and take them as done, and never test the configuration again. Each later reload by `add-api-key` or `remove-api-key` would meet the refused configuration. `nginx` would refuse it and keep its old one, with its old list, while `systemctl reload` reported success. So a removed key would keep working. Nor would `apply` restart `nginx` for a changed drop-in, which would wait for the next start, often a reboot.

`nginx` writes its logs in nginx.org's own folder, `/var/log/nginx`, which the package makes, rotates and, when purged, removes. If that folder is deleted, `nginx` can neither start nor reload. It opens its logs again at each, and no program can make a file in a missing folder. A start fails. A reload fails without a word: nginx.org's reload only sends `nginx` a signal, so `systemctl reload` reports success at once. `nginx` then gives up the new configuration and keeps its old one, its old list included, and a removed key keeps working. A missing log file alone does no harm, since `nginx` makes it.

So the folder is made again whenever it's missing, with mode 0755, as the package makes it. The drop-in makes it before each start and restart. `add-api-key`, `remove-api-key` and `apply`'s stage for the keys make it before they reload a running `nginx`. `apply`'s stage for `nginx`'s configuration and start makes it before `nginx -t`, which opens the logs. `apply` doesn't record it, since it's the package's folder, which purging the package removes. The log files `nginx` then makes have mode 0644, so every account can read them. The next rotation makes new ones with the package's mode, 640, but the rotated files keep 0644 until nginx.org's rule deletes them, 52 days later.

`nginx` takes a changed `hashedApiKeysMapPath` only when `apply` rewrites its configuration, while every other command reads the tool's settings as it runs. So a key command run between such a change and `apply` writes `nginx`'s list at the new path, while `nginx` still reads the old one. A key that `remove-api-key` removes then keeps working from the old list. The tool doesn't guard against that, as it's the operator's error. The README, and a warning beside the setting in the shipped settings, say to run `apply` straight after such a change.

A changed `hashedApiKeysPath`, with the file left where it was, looks to `apply` like a first install. It makes a new first key under a new password, and hands `nginx` a list that holds only that key, so every client's key stops working. The old file still holds their hashes, so setting the path back and running `apply` again gives `nginx` their keys again. The tool doesn't guard against that either, as it's the operator's error. The README, and a warning beside the setting, say to move the file first.

`undo-apply` puts back what `apply` changed on the machine, each to its old value, newest first, until the machine is as `apply` found it, but for `nginx`, as below. The engineering reference's [apply's Record](engineering.md#applys-record) says what it leaves alone, what stays on record when a step fails, and when the record goes.

The keys aren't in apply's record, since `add-api-key` and `remove-api-key` change them between runs. So before any step, `undo-apply` asks one question: delete every key, or keep them all. When `apply` saved the password, the question names it too, since the password opens nothing but the keys' records. A yes gets `sudo` first, as the key commands do, so a refused `sudo` leaves the file and `nginx`'s list agreeing. Then it deletes `hashed-api-keys.json`, and the saved password at the step `apply` recorded for it. A no keeps both, and the next `apply` writes `nginx`'s list again from the file, so every client's url still works. `nginx`'s list goes either way, with `nginx`'s other files.

`undo-apply` never removes a package. Something else on the machine may have come to need `nginx` or its modules since `apply` installed them, and removing them could break it. So `undo-apply` stops, disables and masks `nginx`, and leaves it installed, with its configuration in `/etc/nginx`, its certificates and their private keys in `/var/cache/nginx`, and its logs.

It also leaves `nginx`'s packages on record. `apply`'s first check refuses a machine where `nginx` is installed and apply's record doesn't show that `apply` installed it. With the packages still on record, a later `apply` takes this `nginx` as its own: it skips the install, and reuses the certificate. Three more entries stay while `nginx` is installed. `nginx`'s account stays, since `nginx` runs as it and its files belong to it. nginx.org's repository stays, for `nginx`'s updates. And the mask stays: with the drop-in gone, a start of `nginx.service` would run the package's own configuration, `/etc/nginx/nginx.conf`, with its default site, and the mask stops anything from starting it.

`undo-apply` says what stays, and that the operator may purge `nginx`. Once they have, a later `undo-apply` removes `nginx`'s account, nginx.org's repository and the mask, and the record with them. If someone removed `nginx` by hand with `apt remove` first, its configuration, certificates and logs stay, since only a purge deletes them, and `undo-apply` says so, and how to purge them.

---

## Switching

`turn-off-private-rpc` and `turn-on-private-rpc` change only the flag in the start script, and the operator's choice of a private or a public rpc, which the tool's state, `app-data/state.json`, keeps. `nginx`, the keys and the watchers stay as they are.

`turn-off-private-rpc` and `ensure` could undo each other. Say an Update X1 Console has just taken the flag out, and the operator runs `turn-off-private-rpc`. It reads the script before its question, finds no flag, and so has none to take out. While its question waits, the `cron` job's `ensure` puts the flag back, since private rpc is still on. `turn-off-private-rpc` would then record off and leave that flag in. The validator's next start would keep the rpc private, though the operator turned it off, and `ensure`, which follows off, would leave the flag there.

To prevent that, both hold the start script's lock, which is `flock`'s lock on the state's folder, `app-data/`. `ensure` holds it from its read of the choice until it has put the flag back or left it. `turn-off-private-rpc` takes it after its question, then reads the state and the script again and writes both. A run of `ensure` that finds the lock held changes nothing, and its next run does the work. A `turn-off-private-rpc` that finds it held refuses, changes nothing, and says to run it again. `undo-apply` holds it for its step that takes the flag out, which a running `ensure` could race the same way. `turn-on-private-rpc` and `apply` need no lock, since they only add the flag, as `ensure` does. The kernel lets go of `flock`'s lock when its holder exits, however it exits. A lock file instead could be left behind by a killed command, and would stop `ensure` for good, without a word.

---

## Keeping It That Way

`ensure` runs from the watchers, and on demand. Each run:

1. Puts `--private-rpc` back into the start script when it's missing, while private rpc is on. It never edits the script in the middle of an `x1console` update, which a run can tell from `git`'s lock file and from the script's last change.
2. Checks every part: the flag in the script and in the running validator, where the rpc listens, `nginx`'s state and address, the gate page, and the certificate.
3. Sends the alerts its checks call for, on Telegram, and remembers what it sent, so a lasting problem doesn't alert every minute.
4. Checks in with Cronitor, when a check-in url is set.

Before `apply` has set `nginx` up, `ensure` does nothing. The engineering reference's [Sequence View](engineering.md#sequence-view) gives each step in full, with what a run skips unless private rpc is on.

---

## `x1console`'s Updates and Autopilot's Restarts

These facts come from `x1console`'s source at commit `c1ef91b`, its latest when this was written.

**Update X1 Console takes the flag out.** It runs `git stash`, then `git pull`, in `~/x1console`, and nothing more ([`x1console.sh`, lines 249–262](https://github.com/BlackBeard085/x1console/blob/c1ef91b5a499f6922166008638ad558a0c2a9b25/x1console.sh#L249-L262)). It never applies the stash back, and it restarts nothing. Only the operator runs it, from the menu. The tool's flag is an edit nobody commits, so the stash takes it away. Without the stash, `git pull` wouldn't keep the edit either: it refuses the whole pull when upstream changed the same file, since `git` merges only committed changes.

**The hook puts it back before the update finishes, because it is synchronous on both sides:**

- On `git`'s side, `git pull` runs the post-merge hook as part of the merge, and waits for it to exit before it returns.
- On the tool's side, the hook runs `ensure` in the foreground, with nothing sent to the background. `ensure` writes the flag into the start script before anything else it does.

So when Update X1 Console finishes, the start script holds the flag again.

**Autopilot never takes the flag out.** Its four `cron` jobs ([`setautopilot.sh`, lines 4–8](https://github.com/BlackBeard085/x1console/blob/c1ef91b5a499f6922166008638ad558a0c2a9b25/setautopilot.sh#L4-L8)) never touch `~/x1console`. Two of them restart the validator:

- the check every 30 minutes, which restarts a delinquent validator
- the hourly updater, which updates Tachyon, then restarts the validator through `restart.js` ([`update.sh`, lines 35–74](https://github.com/BlackBeard085/x1console/blob/c1ef91b5a499f6922166008638ad558a0c2a9b25/update.sh#L35-L74))

Each restart reads the start script as it stands.

**Two short windows remain**, when the start script lacks the flag:

1. During `git pull` itself, from the stash until the hook. That's the fetch from GitHub and the merge, usually a few seconds.
2. After a pull that brings no new commits. `git` then runs no hook, but the stash has still taken the flag out. The `cron` job's `ensure` puts it back within a minute after `startScriptQuietSeconds` has passed since the script changed. It waits that long so that it never edits the script in the middle of an update. Without the `cron` job, which `apply` asks about, this window lasts until the operator runs `ensure`, as the README's After an `x1console` Update says. A restart inside it sends no alert, since no `ensure` runs to see the public rpc.

Rarely, the hook's `ensure` runs in the few milliseconds that the `cron` job's `ensure` holds the start script's lock, and so skips its run, as [Switching](#switching) says. That `cron` run leaves the script alone too, since the stash changed it only seconds before. So the first window then lasts as long as the second. That happens about once in 10,000 updates.

**Only a restart inside a window matters**, such as one of Autopilot's restarts landing just after a manual Update X1 Console. The validator then starts with a public rpc, as it did before the tool. `nginx` keeps working, since the rpc then listens on every interface, the loopback address included. `ensure` puts the flag back into the script. Within a minute it sends the Telegram alert that the rpc is public, and sends it again every `exposedReminderMinutes` minutes while that lasts. The operator restarts the validator at a quiet moment, and it takes the flag.

The tool doesn't close the windows itself: it never restarts the validator, and it can't change what Update X1 Console does. An option in `x1console` to start the rpc as private would close them for good.

---

## Restarts

The tool never restarts the validator. A change to the flag waits for the validator's next start, which the operator makes from `x1console` at a quiet moment.

`apply` starts `nginx` when it's stopped, and reloads it when a file of `nginx`'s changed. It restarts `nginx` in two cases: when the drop-in changed, since `systemd` applies the drop-in only at a start, and when `nginx` doesn't answer. `add-api-key` and `remove-api-key` reload it. A reload keeps `nginx` answering. A reboot, or any other restart of `nginx`, needs nothing from the tool, since `nginx` reads its list of hashes at its start.

---

## Privileges

The tool runs as the validator's account, never as root. Each step that needs root runs as its own command through `sudo`: package installs, files in system folders, `nginx`'s list of hashes among them, `systemd`, `ufw` and the saved password. Every effect on the machine, with or without `sudo`, goes through one module, `src/lib/host.js`, so the tests can put a stand-in in its place.

---

## Security Model

The feature README's [Api Key Security](../README.md#api-key-security) section describes how the keys and the password are kept. The project's [`docs/security.md`](../../docs/security.md) records the security checks the gate runs, and every exception to them.

The Telegram bot's token and the chat's id are `x1console`'s, in `telegram_token.txt` and `chat_id.txt` in `~/x1console`, as plain text, since `x1console`'s own alerts read them that way. The tool reads them there and keeps no copy. The x1-validator-services password doesn't lock them. A locked copy would protect nothing while `x1console`'s files stay, and locking those would stop `x1console`'s alerts. `ensure` couldn't open a locked copy anyway: `cron` runs it as the validator's account, and only root can open the saved password, when there is one.

---

## Technology Choices

- **Node.js 20.0.0**, the version `x1console` installs, so the tool needs nothing new on the validator.
- **`nginx` from nginx.org**, for its njs and ACME modules. The key check and the certificate then live inside `nginx`, with no other program to run. nginx.org's packages also upgrade `nginx` in place. That's a binary upgrade, after which the new `nginx` reads its configuration and its list of hashes again. `util/validate-nginx-upgrade/index.js` proves that on each machine before the install.
- **Hashes in `nginx`'s map** for the keys, as a GitHub token is kept: the key is shown once, and only its hash stays. Measured with `nginx` 1.30.6 and njs 1.0.2, a hash takes about a microsecond, and a lookup among 10,000 hashes a fiftieth of that. The map's hash table, sized as `src/lib/key-hash-map.js` says, builds at once for up to 500,000 keys, the `maxApiKeys` limit: 500,000 started in 0.66 seconds and reloaded in 1.4. With `nginx`'s usual table size, 10,000 keys took 20 seconds to start.
- **`systemd`'s encrypted credentials** for a saved password, so the tool keeps no secret of its own on disk in the clear.
- **No program of the tool's own runs all the time.** `nginx` serves, `systemd` starts it, and `cron` runs `ensure` and the key count check.
- **No database.** apply's record, the dictionary of the settings `apply` can change, the tool's state, `ensure`'s alert state and `hashed-api-keys.json` are json files.
- **Small, common packages** for the generic parts: commander for the command line, Ajv for the settings' schema, dotenv for `.env`, and ora for the upgrade check's spinner. [CLAUDE.md](../../CLAUDE.md) says which versions, and why.
