# Releasing

Releases are immutable GitHub releases built from annotated tags on `main`. Version `0.1` ships five
package archives, a `SHA256SUMS` file, and GitHub artifact attestations. The packages are not yet
published to npm.

## Prepare the release

1. Create a release branch from current `main`.
2. Set the root, app, and package versions to the same semantic version.
3. Move user-visible changes from `Unreleased` into a dated changelog section.
4. Run the local release gates:

   ```bash
   pnpm install --frozen-lockfile
   pnpm verify
   pnpm test:integration
   pnpm test:e2e
   pnpm audit --prod
   ```

5. Open a pull request and require every Node matrix, PostgreSQL, and Chromium check to pass.
6. Merge the pull request into `main` before creating the tag.

`pnpm verify` builds all packages, checks their manifests with publint and Are the Types Wrong,
packs the exact publishable files, rejects unresolved `workspace:` ranges, and installs the five
archives into a clean consumer. That consumer exercises ESM, CommonJS, and strict TypeScript
resolution.

## Tag and publish

Create an annotated tag at the reviewed merge commit and push only that tag:

```bash
git switch main
git pull --ff-only
pnpm release:validate -- --tag v0.1.0
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

The release workflow rejects lightweight tags and commits that are not reachable from `main`. It
repeats the full unit, integration, browser, build, and clean-consumer checks before creating any
release. It then generates five `.tgz` archives, writes SHA-256 checksums, creates GitHub build
provenance attestations for every asset, and publishes changelog-derived notes.

No npm token is required for this release path. The package manifests retain public npm metadata
and provenance settings so registry publishing can be added later as a separate, reviewed step.

## Verify published assets

Download and verify the release in an empty directory:

```bash
gh release download v0.1.0 --repo wasiliy-strecker/resumable-upload-kit
sha256sum --check SHA256SUMS
for asset in ./*.tgz ./SHA256SUMS; do
  gh attestation verify "$asset" --repo wasiliy-strecker/resumable-upload-kit
done
```

The release must contain exactly these assets:

- `resumable-upload-kit-protocol-0.1.0.tgz`
- `resumable-upload-kit-server-0.1.0.tgz`
- `resumable-upload-kit-storage-postgres-filesystem-0.1.0.tgz`
- `resumable-upload-kit-client-0.1.0.tgz`
- `resumable-upload-kit-react-0.1.0.tgz`
- `SHA256SUMS`

## Failed and superseded releases

If the workflow fails before release creation, fix the cause on a new pull request. Delete the
unpublished tag only after confirming that no release or external consumer uses it, then tag the
new reviewed commit.

Once a release exists, never move its tag or replace assets. Record the correction in the
changelog and publish the next patch, for example `v0.1.1`. Immutability makes checksums,
attestations, incident evidence, and consumer builds meaningful.
