export const workspacePackageDirectories = [
  'apps/api',
  'apps/e2e',
  'apps/web',
  'packages/client',
  'packages/protocol',
  'packages/react',
  'packages/server',
  'packages/storage-postgres-filesystem',
]

export const releasePackages = [
  { directory: 'packages/protocol', name: '@resumable-upload-kit/protocol' },
  { directory: 'packages/server', name: '@resumable-upload-kit/server' },
  {
    directory: 'packages/storage-postgres-filesystem',
    name: '@resumable-upload-kit/storage-postgres-filesystem',
  },
  { directory: 'packages/client', name: '@resumable-upload-kit/client' },
  { directory: 'packages/react', name: '@resumable-upload-kit/react' },
]

export const internalPackageNames = new Set(releasePackages.map(({ name }) => name))
