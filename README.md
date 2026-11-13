# X1 Validator Services

[![Lint (JS+MD)](https://img.shields.io/github/actions/workflow/status/nottoseethesun/x1-validator-services/ci.yml?branch=main&label=lint)](https://github.com/nottoseethesun/x1-validator-services/actions/workflows/ci.yml)
[![Tests (Node 20.0.0/22/24)](https://img.shields.io/github/actions/workflow/status/nottoseethesun/x1-validator-services/ci.yml?branch=main&label=tests)](https://github.com/nottoseethesun/x1-validator-services/actions/workflows/ci.yml)
[![Security Audit](https://img.shields.io/github/actions/workflow/status/nottoseethesun/x1-validator-services/security-audit.yml?branch=main&label=security)](https://github.com/nottoseethesun/x1-validator-services/actions/workflows/security-audit.yml)

## Overview

X1 Validator Services is a home for features powered by code that runs on the validator itself, such as a gated (by an API key) X1 RPC service.

## Install

Run every `npm` command from this directory, the project root. All features share its single `node_modules`.

### Get the Code

On the validator, as the validator's account:

```bash
git clone https://github.com/nottoseethesun/x1-validator-services.git ~/x1-validator-services
cd ~/x1-validator-services
npm ci --omit=dev --ignore-scripts
```

`--omit=dev` leaves out the development tools, and `--ignore-scripts` skips the set-up step that only they need.

### Each Feature

Each feature's own steps are in its README:

- [x1-validator-private-rpc](x1-validator-private-rpc/README.md)

### Credentials

Credentials that belong to your install go in `.env`, in the project root, which git ignores. Start from the example, and keep the file readable only by you:

```bash
cp .env.example .env && chmod 600 .env
```

Fill it in with an editor rather than with `echo`, which would leave the secret in your shell history.

### Cronitor Alerts

Some features check in with [Cronitor](https://cronitor.io), which alerts you when the check-ins stop. One account serves every feature. Set it up once:

1. Create a Cronitor account.
2. In Cronitor, open Settings → Alerts, and edit the notification list your monitors use, usually the default one. Add a Telegram notification, and follow Cronitor's prompts to link your chat.

Cronitor uses its own Telegram bot, so its alerts arrive in a different chat from x1console's. Each feature's README says which monitor to create.
