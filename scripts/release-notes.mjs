import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { validateRelease } from './validate-release.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

function option(arguments_, name) {
  const index = arguments_.indexOf(name)
  if (index === -1 || !arguments_[index + 1]) throw new Error(`${name} requires a value`)
  return arguments_[index + 1]
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function extractReleaseNotes(changelog, version) {
  const escapedVersion = escapeRegularExpression(version)
  const match = new RegExp(`^## \\[${escapedVersion}\\] - [^\\n]+\\n`, 'm').exec(changelog)

  if (!match) throw new Error(`Could not find release notes for ${version}`)
  const remainingChangelog = changelog.slice(match.index + match[0].length)
  const nextSectionIndex = remainingChangelog.search(/^## \[|^\[Unreleased\]:/m)
  const releaseSection =
    nextSectionIndex === -1 ? remainingChangelog : remainingChangelog.slice(0, nextSectionIndex)
  return releaseSection.trimEnd() + '\n'
}

const arguments_ = process.argv.slice(2)
const output = option(arguments_, '--output')
const { version } = await validateRelease({ tag: process.env.GITHUB_REF_NAME })
const requestedVersion = arguments_.includes('--version')
  ? option(arguments_, '--version')
  : version

if (requestedVersion !== version) {
  throw new Error(
    `Requested version ${requestedVersion} does not match workspace version ${version}`,
  )
}

const changelog = await readFile(resolve(repositoryRoot, 'CHANGELOG.md'), 'utf8')
await writeFile(resolve(output), extractReleaseNotes(changelog, version), 'utf8')
console.log(`Wrote release notes for v${version} to ${output}`)
