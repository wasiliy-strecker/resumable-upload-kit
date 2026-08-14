import type { TusChecksumAlgorithm, TusExtension } from './constants.js'
import type { UploadMetadataEntry } from './metadata.js'

export interface TusServerCapabilities {
  readonly checksumAlgorithms: readonly TusChecksumAlgorithm[]
  readonly extensions: readonly TusExtension[]
  readonly maximumUploadSize: number
  readonly versions: readonly string[]
}

export interface UploadCreation {
  readonly length: number
  readonly metadata: readonly UploadMetadataEntry[]
}

export interface UploadResourceState extends UploadCreation {
  readonly expiresAt: string | null
  readonly offset: number
  readonly uploadUrl: string
}

export type UploadLifecycleStatus = 'active' | 'cancelled' | 'completed' | 'expired' | 'failed'
