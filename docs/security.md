# Security

This page records the security decisions that no tool checks by itself. LP Ranger's security guide is the authority for the rules, as [CLAUDE.md](../CLAUDE.md) says. How x1-validator-private-rpc keeps its api key is in that feature's [Api Key Security](../x1-validator-private-rpc/README.md#api-key-security) section.

## The Audit in CI

`.github/workflows/security-audit.yml` runs three jobs: the audit of the shipped dependencies, the security lint and the secret scan. It runs on every push and pull request to main, and once a day. The daily run is there because the advisory database changes on its own, so code nobody touched can start failing. Validators install from main, so main is the code operators run. The README's security badge shows the latest result.

## Security Lint Exceptions

### Rules Off for the Whole Project

- `security/detect-non-literal-fs-filename`. Its reason is written beside it in `eslint-security.config.js`.

### One-Line Exceptions

None yet. Each one is written in the code as `eslint-disable-next-line <rule> -- Safe: <reason>`, and listed here with its file and its reason.

## Dependency Advisories

The gate fails on a high or critical advisory in the shipped dependencies. Advisories in the dev tools are fixed whenever a fix exists. Each fix below is an override in `package.json`, because the version range of the package that pulls the vulnerable one in leaves the fixed release out:

- `github-actionlint` takes `adm-zip` 0.6.1 or newer. Its own range is `^0.5.16`.
- `markdownlint-cli2` takes `katex` 0.18.2 or newer. `micromark-extension-math`'s range is `^0.16.0`.
- Every package takes `minimatch` 11.0.1 or newer. ESLint, and `@typescript-eslint/typescript-estree`, which `madge` pulls in, ask for `minimatch` 10. The override covers the whole tree, because npm 9 refuses the lockfile when the override names only ESLint and madge. The lockfile must install under npm 9 too, as [CLAUDE.md](../CLAUDE.md) says. ESLint and madge are the only packages that use `minimatch`, so the wider override changes nothing else.

The CI job on Node.js 20.0.0 and `npm run test:system` both prove that npm 9 accepts the lockfile.

No known advisory is left unfixed.
