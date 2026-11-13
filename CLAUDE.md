# CLAUDE.md

This file guides Claude Code, and anyone else working in this repository.

## Purpose

X1 Validator Services is a home for features whose code runs on an X1 validator itself. Each feature lives in a sub-directory of its own.

The first feature is `x1-validator-private-rpc`. It's a command-line tool that makes the validator's rpc private and puts it behind an https url that carries an api key. Its design is in `project-kickoff-documents/x1-validator-private-rpc-handoff.md`, with the tested reference files beside it.

## Conventions

[LP Ranger](https://github.com/nottoseethesun/lp-ranger)'s conventions are the authority for this project. They cover code style, tests, the gate, security, docs, the git workflow and how to work with the owner. Read them in this order:

1. its `CLAUDE.md`
2. its `docs/claude/CLAUDE-*.md` guides, skipping `CLAUDE-DISCLOSURES.md`
3. its `docs/claude/memory/MEMORY.md`, and the `feedback_*` notes it lists

Skip what belongs to LP Ranger's own domain: EVM, chains, pools and positions, its dashboard and its CSS. This file keeps no copy of LP Ranger's rules, so the two can't drift apart. It records only where this project differs, below.

## Where This Project Differs From LP Ranger

- **ES modules.** Every file is an ES module. Translate LP Ranger's CommonJS examples: `import` and `export`, file extensions in relative imports, and `fileURLToPath(import.meta.url)` where LP Ranger uses `__dirname`.
- **Node.js versions.** The validator runs Node.js 20.0.0, the version x1console installs. So `engines` is `>=20.0.0`, and code that runs there may use no newer API or syntax; eslint-plugin-n checks this. The lint, coverage and audit tools need Node.js 24, so the whole gate runs on 24. On 20.0.0 and 22 the gate runs the features' tests only.
- **Runtime dependencies.** commander 14, the newest major that runs on Node.js 20.0.0; Ajv 8; dotenv 18; and ora 8, for the terminal spinner, since ora 9 and newer don't load on Node.js 20.0.0. Every other package is a dev dependency.
- **Only the entry point runs at load.** Every module other than a program's entry point only declares imports, constants, functions and exports. Two LP Ranger rules exist only because its modules read settings as they load, so they don't apply here: setting overrides before a module loads, and keeping diagnostic tools from importing shared modules.
- **One repository, several features.** One `package.json` and one `node_modules` at the root serve every feature. Run every npm command from the root. Each feature's details go in its own `README.md`; the root `README.md` holds only what applies to the whole project.
- **System tests.** A test that configures a system, with packages, systemd, nginx, ufw or cron, runs in an LXD container on the development machine, through `npm run test:system`. No test runs on a validator. Every effect on the system goes through the host in `src/lib/host.js`, so unit tests pass the fake host instead.
- **apt, never apt-get.** Code, tests and docs call `apt`, as x1console and nginx.org's instructions do, and never `apt-get` or `apt-cache`. Each call from code passes `-o Apt::Cmd::Disable-Script-Warning=true`, which stops `apt` warning that a program runs it.
- **The lockfile.** npm 11 writes it on the development machine, and the validator installs it with npm 9, which comes with Node.js 20.0.0, so `npm ci` must accept it under both. See [docs/security.md](docs/security.md) for why the `minimatch` override covers the whole tree.
- **The gate.** Its reports go to `tmp/check/`. Besides LP Ranger's coverage rules, it fails a source module that no test loads, since Node.js reports coverage only for the files a test loaded. The list of files held to 95% coverage is in `scripts/check.js`.
- **The security pass.** `security/detect-non-literal-fs-filename` is off for the whole project; its reason is beside it in `eslint-security.config.js`. [docs/security.md](docs/security.md) lists every exception and every dependency override.

## Layout

```text
package.json             one for the whole project
eslint.config.js         the main lint rules
eslint-security.config.js  the security pass
knip.config.js           the unused-file check
scripts/                 the gate and the runners of the tools
  lint-targets.js        every file list the gates use
test/                    tests of the project's own tooling
eslint-rules/            this project's lint rules
docs/                    project-wide docs
x1-validator-private-rpc/
  README.md              the feature's install steps and use
  app-config/            shipped settings and their schema; per-install overrides
  src/cli.js             its entry point
  src/cli/               modules the entry point loads
  src/lib/               modules shared by its programs, the host included
  src/njs/               the key check nginx runs, installed as is
  util/validate-nginx-upgrade/  the first install step, a standalone tool
  test/                  its tests; helpers/ holds the fake host
```

Entry points sit directly in a feature's `src/`, and standalone tools in its `util/`. Modules sit in folders under `src/`, grouped by the entry point that loads them, with shared ones in `src/lib/`. A new feature joins every gate when it's added to `FEATURES` in `scripts/lint-targets.js`.

## Commands

`npm run check` is the gate. It must pass before every commit and every push. Every npm command, with its options and an example, is in [docs/npm-project-commands.md](docs/npm-project-commands.md).
