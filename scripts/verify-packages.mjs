import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { internalPackageNames, releasePackages } from './release-config.mjs'
import { validateRelease } from './validate-release.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const localBinaryDirectory = resolve(repositoryRoot, 'node_modules/.bin')
const commandEnvironment = {
  ...process.env,
  PATH: `${localBinaryDirectory}${delimiter}${process.env.PATH ?? ''}`,
}

function run(command, arguments_, options = {}) {
  console.log(`\n> ${command} ${arguments_.join(' ')}`)
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    env: commandEnvironment,
    stdio: 'inherit',
    ...options,
  })

  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}

function outputOption(arguments_) {
  const index = arguments_.indexOf('--output')
  if (index === -1) return null
  if (!arguments_[index + 1]) throw new Error('--output requires a directory')
  return resolve(repositoryRoot, arguments_[index + 1])
}

function allDependencyEntries(manifest) {
  return ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((field) =>
    Object.entries(manifest[field] ?? {}),
  )
}

async function inspectArchive(archive, expectedName, version) {
  const manifestText = execFileSync('tar', ['-xOf', archive, 'package/package.json'], {
    encoding: 'utf8',
  })
  const manifest = JSON.parse(manifestText)

  assert.equal(manifest.name, expectedName)
  assert.equal(manifest.version, version)
  assert(!manifestText.includes('workspace:'), `${expectedName} archive contains workspace ranges`)

  for (const [name, range] of allDependencyEntries(manifest)) {
    if (internalPackageNames.has(name)) {
      assert.equal(range, version, `${expectedName} must pin ${name} to ${version} in its archive`)
    }
  }
}

async function packPackages(outputDirectory, version) {
  const archives = new Map()

  for (const { directory, name } of releasePackages) {
    run('publint', [directory, '--pack', 'pnpm'])
    run('attw', [
      '--pack',
      directory,
      '--profile',
      'node16',
      '--format',
      'table',
      '--no-emoji',
      '--no-color',
    ])

    console.log(`\n> pnpm --dir ${directory} pack --pack-destination ${outputDirectory} --json`)
    const packed = JSON.parse(
      execFileSync(
        'pnpm',
        ['--dir', directory, 'pack', '--pack-destination', outputDirectory, '--json'],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: commandEnvironment,
        },
      ),
    )
    const archive = resolve(packed.filename)
    await inspectArchive(archive, name, version)
    archives.set(name, archive)
  }

  return archives
}

async function verifyConsumer(archives) {
  const consumerDirectory = await mkdtemp(resolve(tmpdir(), 'resumable-upload-kit-consumer-'))

  try {
    const dependencies = Object.fromEntries(
      [...archives].map(([name, archive]) => [name, `file:${archive}`]),
    )
    Object.assign(dependencies, {
      '@types/node': '22.20.1',
      '@types/react': '19.2.18',
      fastify: '5.11.2',
      react: '19.2.8',
    })

    await writeFile(
      resolve(consumerDirectory, 'package.json'),
      JSON.stringify(
        { name: 'release-consumer-smoke', private: true, type: 'module', dependencies },
        null,
        2,
      ),
      'utf8',
    )
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], {
      cwd: consumerDirectory,
    })

    await writeFile(
      resolve(consumerDirectory, 'smoke.mjs'),
      `import assert from 'node:assert/strict'
import { tusVersion } from '@resumable-upload-kit/protocol'
import { createUploadService } from '@resumable-upload-kit/server'
import { registerResumableUploadRoutes } from '@resumable-upload-kit/server/fastify'
import { FileSystemUploadBlobStore } from '@resumable-upload-kit/storage-postgres-filesystem'
import { createResumableUploadClient } from '@resumable-upload-kit/client'
import { useResumableUpload } from '@resumable-upload-kit/react'

assert.equal(tusVersion, '1.0.0')
for (const value of [
  createUploadService,
  registerResumableUploadRoutes,
  FileSystemUploadBlobStore,
  createResumableUploadClient,
  useResumableUpload,
]) {
  assert.equal(typeof value, 'function')
}
`,
      'utf8',
    )
    await writeFile(
      resolve(consumerDirectory, 'smoke.cjs'),
      `const assert = require('node:assert/strict')
const protocol = require('@resumable-upload-kit/protocol')
const server = require('@resumable-upload-kit/server')
const fastifyAdapter = require('@resumable-upload-kit/server/fastify')
const storage = require('@resumable-upload-kit/storage-postgres-filesystem')
const client = require('@resumable-upload-kit/client')
const react = require('@resumable-upload-kit/react')

assert.equal(protocol.tusVersion, '1.0.0')
for (const value of [
  server.createUploadService,
  fastifyAdapter.registerResumableUploadRoutes,
  storage.FileSystemUploadBlobStore,
  client.createResumableUploadClient,
  react.useResumableUpload,
]) {
  assert.equal(typeof value, 'function')
}
`,
      'utf8',
    )
    await writeFile(
      resolve(consumerDirectory, 'types.ts'),
      `import { tusVersion, type UploadResourceState } from '@resumable-upload-kit/protocol'
import { createUploadService, type UploadService } from '@resumable-upload-kit/server'
import { registerResumableUploadRoutes } from '@resumable-upload-kit/server/fastify'
import {
  FileSystemUploadBlobStore,
  type FileSystemUploadBlobStoreOptions,
} from '@resumable-upload-kit/storage-postgres-filesystem'
import {
  createResumableUploadClient,
  type ResumableUploadClient,
} from '@resumable-upload-kit/client'
import { useResumableUpload, type UseResumableUploadResult } from '@resumable-upload-kit/react'

void tusVersion
void createUploadService
void registerResumableUploadRoutes
void FileSystemUploadBlobStore
void createResumableUploadClient
void useResumableUpload

declare const resource: UploadResourceState
declare const service: UploadService
declare const storageOptions: FileSystemUploadBlobStoreOptions
declare const client: ResumableUploadClient
declare const hookResult: UseResumableUploadResult
void [resource, service, storageOptions, client, hookResult]
`,
      'utf8',
    )
    await writeFile(
      resolve(consumerDirectory, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            lib: ['ES2022', 'DOM'],
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            noEmit: true,
            skipLibCheck: false,
            strict: true,
            target: 'ES2022',
          },
          files: ['types.ts'],
        },
        null,
        2,
      ),
      'utf8',
    )

    run(process.execPath, ['smoke.mjs'], { cwd: consumerDirectory })
    run(process.execPath, ['smoke.cjs'], { cwd: consumerDirectory })
    run(resolve(repositoryRoot, 'node_modules/.bin/tsc'), ['--project', 'tsconfig.json'], {
      cwd: consumerDirectory,
    })
  } finally {
    await rm(consumerDirectory, { force: true, recursive: true })
  }
}

const explicitOutput = outputOption(process.argv.slice(2))
const temporaryOutput = explicitOutput
  ? null
  : await mkdtemp(resolve(tmpdir(), 'resumable-upload-kit-'))
const outputDirectory = explicitOutput ?? temporaryOutput

try {
  await mkdir(outputDirectory, { recursive: true })
  const { version } = await validateRelease()
  const existingFiles = await Promise.all(
    releasePackages.map(async ({ name }) => {
      const filename = `${name.slice(1).replace('/', '-')}-${version}.tgz`
      try {
        await readFile(resolve(outputDirectory, filename))
        return filename
      } catch {
        return null
      }
    }),
  )
  assert.equal(
    existingFiles.filter(Boolean).length,
    0,
    `Output directory already contains release archives: ${existingFiles.filter(Boolean).join(', ')}`,
  )

  const archives = await packPackages(outputDirectory, version)
  await verifyConsumer(archives)
  console.log(
    `\nVerified ${archives.size} release archives and a clean ESM, CommonJS, and TypeScript consumer`,
  )
  if (explicitOutput) {
    console.log(`Release archives are available in ${basename(outputDirectory)}/`)
  }
} finally {
  if (temporaryOutput) await rm(temporaryOutput, { force: true, recursive: true })
}
