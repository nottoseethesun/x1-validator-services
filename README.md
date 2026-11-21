# X1 Validator Services

![X1 Validator Services banner: a butler in a black tuxedo beside the X1 logo and the words "Your X1 Validator Services Butler", with panels for api-key access, rate-limited access and encrypted traffic.](./assets/images/x1-validator-services-butler.jpeg "X1 Validator Services Banner")

[![Lint (JS+MD)](https://img.shields.io/github/actions/workflow/status/nottoseethesun/x1-validator-services/ci.yml?branch=main&label=lint)](https://github.com/nottoseethesun/x1-validator-services/actions/workflows/ci.yml)
[![Tests (Node 20.0.0/22/24)](https://img.shields.io/github/actions/workflow/status/nottoseethesun/x1-validator-services/ci.yml?branch=main&label=tests)](https://github.com/nottoseethesun/x1-validator-services/actions/workflows/ci.yml)
[![Security Audit](https://img.shields.io/github/actions/workflow/status/nottoseethesun/x1-validator-services/security-audit.yml?branch=main&label=security)](https://github.com/nottoseethesun/x1-validator-services/actions/workflows/security-audit.yml)

## Overview

X1 Validator Services holds features: tools whose code runs on an X1 validator itself, each in a folder of its own, with a README that gives its install steps and use. The first, x1-validator-private-rpc, is a command-line tool that makes the validator's rpc private and puts it behind an https url that carries an api key.

## Install

Install the code once, then each feature you want. Run every `npm` command from the project root, the folder the clone below makes: all features share its single `node_modules`.

### Get the Code

On the validator, as the validator's account:

```bash
git clone https://github.com/nottoseethesun/x1-validator-services.git ~/x1-validator-services
cd ~/x1-validator-services
npm ci --omit=dev --ignore-scripts
```

`--omit=dev` leaves out the development tools, and `--ignore-scripts` skips the `prepare` script, which installs the pre-commit hook, a development tool.

### Each Feature

Each feature's own steps are in its README:

- [x1-validator-private-rpc](x1-validator-private-rpc/README.md)

### Credentials

Some features take a credential, which their README names. Credentials go in `.env`, a file in the project root that `git` ignores. Start from the example, and keep the file readable only by you:

```bash
cp .env.example .env && chmod 600 .env
```

Fill it in with an editor rather than with `echo`, which would leave the secret in your shell history.

### Cronitor Alerts

Some features check in with [Cronitor](https://cronitor.io), which alerts you when the check-ins stop. Cronitor watches each feature's check-ins with a monitor, which that feature's README says how to create. One account serves every feature. Set it up once:

1. Create a Cronitor account.
2. In Cronitor, open Settings → Alerts, and edit the notification list your monitors use, usually the default one. Add a Telegram notification, and follow Cronitor's prompts to link your chat.

Cronitor uses its own Telegram bot, so its alerts arrive in a different chat from `x1console`'s.

## Development

For how the project is checked and tested, see **[`docs/engineering.md`](docs/engineering.md)**: the checks that must pass before every commit, the lists of files they read, the tests' rules, CI, and the system test, which runs a feature in an LXD container.

For every `npm` command, what it does, which flags it takes, and a line you can copy, see **[`docs/npm-project-commands.md`](docs/npm-project-commands.md)**.

For a feature's design, see its own references:

- x1-validator-private-rpc: [architecture](x1-validator-private-rpc/docs/architecture.md) and [engineering](x1-validator-private-rpc/docs/engineering.md)

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text.
