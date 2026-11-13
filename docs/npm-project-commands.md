# npm Project Commands

Run every command from the project root. Each script behind a command also answers `--help` when run by its path, as in `node scripts/check.js --help`.

## The Gate

### `npm run check`

Runs every check, then prints a summary. It must pass before every commit and every push. On Node.js 24 or newer it runs everything: lint, formatting, the security pass, the secret scan, the dead-code checks, the audit of the shipped dependencies, the tests and the coverage verdict. On Node.js 20.0.0 and 22 it runs the features' tests only. Reports go to `tmp/check/`.

```bash
npm run check
```

## Lint and Format

### `npm run lint`

Runs every lint, format and security check that needs nothing but this machine. The pre-commit hook runs it.

```bash
npm run lint
```

### `npm run lint:fix`

The same checks, with each tool rewriting what it can fix.

```bash
npm run lint:fix
```

### `npm run format`

Rewrites the formatting of the project's JavaScript files with Prettier. Run it when the lint reports unformatted code.

```bash
npm run format
```

### `npm run format:check`

Reports JavaScript files Prettier would change, without changing them.

```bash
npm run format:check
```

### `npm run knip:files`

Reports JavaScript files that nothing imports.

```bash
npm run knip:files
```

## Tests

These run the suite alone, for quick runs while working. Only `npm run check` counts before a commit.

### `npm test`

Runs every test once.

```bash
npm test
```

### `npm run test:coverage`

Runs every test once, with a coverage summary.

```bash
npm run test:coverage
```

### `npm run test:watch`

Reruns the tests on every change.

```bash
npm run test:watch
```

### `npm run test:system`

Runs x1-validator-private-rpc's nginx upgrade check end to end in a throwaway Ubuntu 24.04 LXD container, checks that it left the container clean, and deletes the container. It needs LXD on the development machine and network access from the container, takes a few minutes, and isn't part of `npm run check`. With `--keep`, the container stays for a look inside.

```bash
npm run test:system
npm run test:system -- --keep
```

## Security

### `npm run audit:deps`

Audits the shipped dependencies, and fails on a high or critical advisory.

```bash
npm run audit:deps
```

### `npm run audit:deps:all`

Audits every dependency, dev tools included, and fails on a high or critical advisory.

```bash
npm run audit:deps:all
```

### `npm run audit:security`

Runs the security lint, `eslint-security.config.js`.

```bash
npm run audit:security
```

### `npm run audit:secrets`

Scans for committed credentials with secretlint.

```bash
npm run audit:secrets
```
