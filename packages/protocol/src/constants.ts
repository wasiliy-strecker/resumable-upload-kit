export const tusVersion = '1.0.0' as const
export const tusVersions = [tusVersion] as const
export const tusOffsetContentType = 'application/offset+octet-stream' as const

export const tusExtensions = ['creation', 'checksum', 'expiration', 'termination'] as const
export type TusExtension = (typeof tusExtensions)[number]

export const tusChecksumAlgorithms = ['sha1', 'sha256'] as const
export type TusChecksumAlgorithm = (typeof tusChecksumAlgorithms)[number]

export const tusHeader = {
  checksumAlgorithm: 'Tus-Checksum-Algorithm',
  extension: 'Tus-Extension',
  maxSize: 'Tus-Max-Size',
  resumable: 'Tus-Resumable',
  version: 'Tus-Version',
  uploadChecksum: 'Upload-Checksum',
  uploadExpires: 'Upload-Expires',
  uploadLength: 'Upload-Length',
  uploadMetadata: 'Upload-Metadata',
  uploadOffset: 'Upload-Offset',
} as const

export type TusHeaderName = (typeof tusHeader)[keyof typeof tusHeader]
