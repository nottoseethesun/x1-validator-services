# Security

This page records the security decisions that no tool checks by itself. LP Ranger's security guide is the authority for the rules; see [CLAUDE.md](../CLAUDE.md).

## Security Lint Exceptions

### Rules Off for the Whole Project

- `security/detect-non-literal-fs-filename`. Its reason is written beside it in `eslint-security.config.js`.

### One-Line Exceptions

None yet. Each one is written in the code as `eslint-disable-next-line <rule> -- Safe: <reason>`, and listed here with its file and its reason.

## Dependency Advisories

The gate fails on a high or critical advisory in the shipped dependencies. Advisories in the dev tools are fixed whenever a fix exists. Each fix below is an override in `package.json`, because the version range of the package that pulls the vulnerable one in leaves the fixed release out:

- `github-actionlint` takes `adm-zip` 0.6.1 or newer. Its own range is `^0.5.16`.
- `markdownlint-cli2` takes `katex` 0.18.2 or newer. `micromark-extension-math`'s range is `^0.16.0`.
- Every package takes `minimatch` 11.0.1 or newer. ESLint, and `@typescript-eslint/typescript-estree`, which `madge` pulls in, ask for `minimatch` 10. The override covers the whole tree because npm 11 writes the lockfile on the development machine, and the validator installs it with npm 9, which comes with Node.js 20.0.0. npm 9 refused the lockfile while the override was limited to ESLint and madge. They're the only packages that use `minimatch`, so the wider override changes nothing else.

The lockfile must install with `npm ci` under both npm 9 and npm 11. The CI job on Node.js 20.0.0 and `npm run test:system` both prove it.

No known advisory is left unfixed.
