# x1-validator-private-rpc

## Install

> **Run `npm` from the project root.** Every `npm` command runs in the project root, one level up from this directory (`cd ..`), where the project's single `node_modules` lives.
>
> **Never point the validator's own solana cli at the gated rpc.** On the validator, don't set the cli's rpc url, whether through x1console's network menu or `solana config set --url`, to anything that contains the gated rpc's hostname (`x1-rpc.example.com` in these docs). Autopilot's health check uses that url, and the gated rpc can stop answering, for example after a reboot, until you unlock it. Autopilot answers a failed check by deleting the ledger and restarting the validator.

### Check That nginx Upgrades Keep Working

Run this first, before anything else of the tool is installed. It proves on this machine that a regular apt upgrade of nginx keeps the gated rpc working. It installs nginx.org's previous release, runs it under systemd the way the tool will, upgrades it with apt, and checks that systemd followed the new nginx and that the api key carried over. Then it removes everything it added. It never touches Tachyon, port 443 or the firewall.

It takes a few minutes. Run it inside tmux, so that a dropped SSH connection can't stop it halfway and leave nginx installed. If the connection drops, log in again and run `tmux attach` to get back to it. Run it as the validator's account, from the project root. It asks for your sudo password:

```bash
tmux
cd ~/x1-validator-services
node x1-validator-private-rpc/util/validate-nginx-upgrade/index.js
```

It ends with `Passed`, or with the reasons it failed. If it ever can't remove something it added, it lists that step with a `By hand:` command that does the same. Run those commands in the order listed, then run it again. To stop it early, press Ctrl-C: it finishes the step it's on, then removes everything it added. Type `exit` afterwards to leave tmux. Go on with the install only once it passes.

### Cronitor Heartbeat

`ensure`, the tool's watcher, runs from cron every minute. It puts `--private-rpc` back after an x1console update, and sends the tool's Telegram alerts. If its cron job ever stops working, for example because this folder moved or its settings have a typo, all of that stops without a word. So at the end of each scheduled run, `ensure` checks in with Cronitor, and Cronitor alerts you when the check-ins stop. While all is well, it sends nothing.

The heartbeat is optional. Without a url, `ensure` doesn't check in. To set it up, first create a Cronitor account, as the project's [Cronitor Alerts](../README.md#cronitor-alerts) section describes. Then:

1. In Cronitor, create a job monitor, named for example `X1 Validator Private RPC - ensure`, with these settings:
   - schedule `* * * * *`, every minute, like the cron line
   - a grace period of 60 seconds
   - an alert after three consecutive missed runs, so one lost check-in doesn't set it off
2. Copy the monitor's telemetry url, which looks like `https://cronitor.link/p/YOUR_CRONITOR_API_KEY/YOUR_MONITOR_KEY`. Treat it as a credential: anyone who has it can check in for you and hide an outage.
3. Add it to the project root's `.env` (see [Credentials](../README.md#credentials)):

   ```text
   X1_PRIVATE_RPC_CRONITOR_URL=https://cronitor.link/p/YOUR_CRONITOR_API_KEY/YOUR_MONITOR_KEY
   ```

4. Test it. Run `crontab -e`, and put a `#` in front of the line that runs `ensure`. Within about five minutes, Cronitor should alert you on Telegram. Then remove the `#`. Once the check-ins resume, Cronitor sends a recovery notice.

## Test

Run tests from the project root (`cd ..`). Only the system test, `npm run test:system`, needs LXD. It runs the nginx upgrade check for real, in a throwaway Ubuntu 24.04 container on your development machine, confirms the check removed everything it added, and deletes the container. Never run it on a validator.

Set up LXD once, on Ubuntu, then log out and back in so the group change takes effect:

```bash
sudo snap install lxd
sudo lxd init --auto
sudo usermod -aG lxd "$USER"
```

Then run the test. It takes a few minutes, and the container needs internet access:

```bash
npm run test:system
```
