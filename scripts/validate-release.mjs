import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import {
  internalPackageNames,
  releasePackages,
  workspacePackageDirectories,
} from './release-config.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(repositoryRoot, relativePath), 'utf8'))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function readTagArgument(arguments_) {
  const tagIndex = arguments_.indexOf('--tag')
  if (tagIndex !== -1) {
    assert(arguments_[tagIndex + 1], 'The --tag option requires a value')
    return arguments_[tagIndex + 1]
  }

  return process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME
}

function dependencyEntries(manifest) {
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(
    (field) =>
      Object.entries(manifest[field] ?? {}).map(([name, range]) => ({ field, name, range })),
  )
}

export async function validateRelease({ tag } = {}) {
  const rootManifest = await readJson('package.json')
  const version = rootManifest.version

  assert(
    typeof version === 'string' && semverPattern.test(version),
    `Invalid root version: ${version}`,
  )

  for (const directory of workspacePackageDirectories) {
    const manifest = await readJson(`${directory}/package.json`)
    assert(
      manifest.version === version,
      `${manifest.name} has version ${manifest.version}; expected ${version}`,
    )
  }

  const expectedTag = `v${version}`
  if (tag) assert(tag === expectedTag, `Release tag ${tag} does not match ${expectedTag}`)

  const changelog = await readFile(resolve(repositoryRoot, 'CHANGELOG.md'), 'utf8')
  assert(
    new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(
      changelog,
    ),
    `CHANGELOG.md has no dated ${version} release section`,
  )

  for (const { directory, name } of releasePackages) {
    const manifest = await readJson(`${directory}/package.json`)
    assert(manifest.name === name, `${directory} has unexpected package name ${manifest.name}`)
    assert(manifest.private !== true, `${name} must not be private`)
    assert(manifest.license === 'MIT', `${name} must declare its MIT license`)
    assert(manifest.repository?.url, `${name} must declare its repository`)
    assert(manifest.repository?.directory === directory, `${name} has a wrong repository directory`)
    assert(manifest.homepage, `${name} must declare its homepage`)
    assert(manifest.bugs?.url, `${name} must declare its issue tracker`)
    assert(manifest.publishConfig?.access === 'public', `${name} must use public publish access`)
    assert(manifest.publishConfig?.provenance === true, `${name} must request npm provenance`)

    for (const { field, name: dependencyName, range } of dependencyEntries(manifest)) {
      if (internalPackageNames.has(dependencyName)) {
        assert(
          range === 'workspace:*',
          `${name} ${field}.${dependencyName} must use workspace:*; found ${range}`,
        )
      }
    }
  }

  return { expectedTag, version }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  const tag = readTagArgument(process.argv.slice(2))
  const result = await validateRelease({ tag })
  console.log(`Release metadata is consistent for ${result.expectedTag}`)
}
