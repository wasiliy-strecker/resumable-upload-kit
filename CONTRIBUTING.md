# Contributing

Use Node.js 22.12 or newer and the pnpm version declared in `package.json`.

```bash
pnpm install --frozen-lockfile
pnpm verify
```

Changes to public protocol behavior must include focused tests and an update to the compatibility
matrix. Do not describe a tus extension as supported until its complete HTTP behavior has an
integration test.

Keep commits scoped and imperative. Never commit uploaded files, local storage directories,
credentials, or test fixtures derived from private documents.
