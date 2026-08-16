import { parseUploadMetadata, serializeUploadMetadata } from '@resumable-upload-kit/protocol'
import type {
  AcquireUploadLeaseInput,
  AcquireUploadLeaseResult,
  CommitUploadLeaseInput,
  CommitUploadLeaseResult,
  CreateUploadRecordInput,
  GoneReason,
  ReleaseUploadLeaseInput,
  TerminateUploadInput,
  TerminateUploadResult,
  UploadLookupResult,
  UploadRecord,
  UploadRepository,
  UploadStatus,
} from '@resumable-upload-kit/server'
import type { Pool, PoolClient, QueryResultRow } from 'pg'

interface UploadRow extends QueryResultRow {
  readonly created_at: Date
  readonly expires_at: Date | null
  readonly id: string
  readonly lease_expires_at: Date | null
  readonly lease_id: string | null
  readonly metadata_header: string
  readonly owner_id: string
  readonly status: UploadStatus
  readonly updated_at: Date
  readonly upload_length: string
  readonly upload_offset: string
}

export class PostgresUploadRepository implements UploadRepository {
  public constructor(private readonly pool: Pool) {}

  public async create(input: CreateUploadRecordInput): Promise<UploadRecord> {
    const status: UploadStatus = input.length === 0 ? 'completed' : 'active'
    const result = await this.pool.query<UploadRow>(
      `
        INSERT INTO resumable_uploads (
          id, owner_id, upload_length, upload_offset, status, metadata_header,
          expires_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $7)
        RETURNING *
      `,
      [
        input.id,
        input.ownerId,
        input.length,
        status,
        serializeUploadMetadata(input.metadata),
        input.expiresAt,
        input.now,
      ],
    )

    return rowToUpload(requireRow(result.rows[0]))
  }

  public async findOwned(
    uploadId: string,
    ownerId: string,
    now: Date,
  ): Promise<UploadLookupResult> {
    const client = await this.pool.connect()

    try {
      await client.query('BEGIN')
      await expireAvailableUpload(client, uploadId, ownerId, now)
      const result = await client.query<UploadRow>(
        'SELECT * FROM resumable_uploads WHERE id = $1 AND owner_id = $2',
        [uploadId, ownerId],
      )
      await client.query('COMMIT')
      return lookupResult(result.rows[0])
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  public async acquireLease(input: AcquireUploadLeaseInput): Promise<AcquireUploadLeaseResult> {
    const client = await this.pool.connect()

    try {
      await client.query('BEGIN')
      const selected = await client.query<UploadRow>(
        'SELECT * FROM resumable_uploads WHERE id = $1 AND owner_id = $2 FOR UPDATE',
        [input.uploadId, input.ownerId],
      )
      let row = selected.rows[0]

      if (!row) {
        await client.query('COMMIT')
        return { kind: 'missing' }
      }

      if (
        row.status === 'active' &&
        requireDate(row.expires_at, 'expires_at').getTime() <= input.now.getTime() &&
        (row.lease_expires_at === null || row.lease_expires_at.getTime() <= input.now.getTime())
      ) {
        row = await markExpired(client, row.id, row.owner_id, input.now)
      }

      const goneReason = getGoneReason(row.status)

      if (goneReason) {
        await client.query('COMMIT')
        return { kind: 'gone', reason: goneReason }
      }

      const upload = rowToUpload(row)

      if (upload.status !== 'active' || upload.offset !== input.expectedOffset) {
        await client.query('COMMIT')
        return { currentOffset: upload.offset, kind: 'conflict' }
      }

      if (upload.leaseExpiresAt && upload.leaseExpiresAt.getTime() > input.now.getTime()) {
        await client.query('COMMIT')
        return { kind: 'locked', retryAt: upload.leaseExpiresAt }
      }

      const updated = await client.query<UploadRow>(
        `
          UPDATE resumable_uploads
          SET lease_id = $3, lease_expires_at = $4, updated_at = $5
          WHERE id = $1 AND owner_id = $2
          RETURNING *
        `,
        [input.uploadId, input.ownerId, input.leaseId, input.leaseExpiresAt, input.now],
      )
      await client.query('COMMIT')
      return { kind: 'acquired', upload: rowToUpload(requireRow(updated.rows[0])) }
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  public async commitLease(input: CommitUploadLeaseInput): Promise<CommitUploadLeaseResult> {
    const result = await this.pool.query<UploadRow>(
      `
        UPDATE resumable_uploads
        SET upload_offset = $4,
            status = CASE WHEN $4 = upload_length THEN 'completed' ELSE 'active' END,
            expires_at = CASE WHEN $4 = upload_length THEN NULL ELSE expires_at END,
            lease_id = NULL,
            lease_expires_at = NULL,
            updated_at = $5
        WHERE id = $1
          AND owner_id = $2
          AND status = 'active'
          AND lease_id = $3
          AND $4 BETWEEN upload_offset AND upload_length
        RETURNING *
      `,
      [input.uploadId, input.ownerId, input.leaseId, input.newOffset, input.now],
    )

    const row = result.rows[0]
    return row ? { applied: true, upload: rowToUpload(row) } : { applied: false }
  }

  public async releaseLease(input: ReleaseUploadLeaseInput): Promise<void> {
    await this.pool.query(
      `
        UPDATE resumable_uploads
        SET lease_id = NULL, lease_expires_at = NULL, updated_at = $4
        WHERE id = $1 AND owner_id = $2 AND lease_id = $3
      `,
      [input.uploadId, input.ownerId, input.leaseId, input.now],
    )
  }

  public async terminate(input: TerminateUploadInput): Promise<TerminateUploadResult> {
    const client = await this.pool.connect()

    try {
      await client.query('BEGIN')
      const selected = await client.query<UploadRow>(
        'SELECT * FROM resumable_uploads WHERE id = $1 AND owner_id = $2 FOR UPDATE',
        [input.uploadId, input.ownerId],
      )
      let row = selected.rows[0]

      if (!row) {
        await client.query('COMMIT')
        return { kind: 'missing' }
      }

      if (
        row.status === 'active' &&
        requireDate(row.expires_at, 'expires_at').getTime() <= input.now.getTime() &&
        (row.lease_expires_at === null || row.lease_expires_at.getTime() <= input.now.getTime())
      ) {
        row = await markExpired(client, row.id, row.owner_id, input.now)
      }

      const goneReason = getGoneReason(row.status)

      if (goneReason) {
        await client.query('COMMIT')
        return { kind: 'gone', reason: goneReason }
      }

      if (row.lease_expires_at && row.lease_expires_at.getTime() > input.now.getTime()) {
        await client.query('COMMIT')
        return { kind: 'locked', retryAt: row.lease_expires_at }
      }

      const updated = await client.query<UploadRow>(
        `
          UPDATE resumable_uploads
          SET status = 'terminated', expires_at = NULL, lease_id = NULL,
              lease_expires_at = NULL, updated_at = $3
          WHERE id = $1 AND owner_id = $2
          RETURNING *
        `,
        [input.uploadId, input.ownerId, input.now],
      )
      await client.query('COMMIT')
      return { kind: 'terminated', upload: rowToUpload(requireRow(updated.rows[0])) }
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }
}

async function expireAvailableUpload(
  client: PoolClient,
  uploadId: string,
  ownerId: string,
  now: Date,
): Promise<void> {
  await client.query(
    `
      UPDATE resumable_uploads
      SET status = 'expired', lease_id = NULL, lease_expires_at = NULL, updated_at = $3
      WHERE id = $1
        AND owner_id = $2
        AND status = 'active'
        AND expires_at <= $3
        AND (lease_expires_at IS NULL OR lease_expires_at <= $3)
    `,
    [uploadId, ownerId, now],
  )
}

async function markExpired(
  client: PoolClient,
  uploadId: string,
  ownerId: string,
  now: Date,
): Promise<UploadRow> {
  const result = await client.query<UploadRow>(
    `
      UPDATE resumable_uploads
      SET status = 'expired', lease_id = NULL, lease_expires_at = NULL, updated_at = $3
      WHERE id = $1 AND owner_id = $2
      RETURNING *
    `,
    [uploadId, ownerId, now],
  )
  return requireRow(result.rows[0])
}

function lookupResult(row: UploadRow | undefined): UploadLookupResult {
  if (!row) {
    return { kind: 'missing' }
  }

  const reason = getGoneReason(row.status)
  return reason ? { kind: 'gone', reason } : { kind: 'found', upload: rowToUpload(row) }
}

function getGoneReason(status: UploadStatus): GoneReason | null {
  if (status === 'expired' || status === 'terminated') {
    return status
  }

  return null
}

function rowToUpload(row: UploadRow): UploadRecord {
  return Object.freeze({
    createdAt: requireDate(row.created_at, 'created_at'),
    expiresAt: row.expires_at,
    id: row.id,
    leaseExpiresAt: row.lease_expires_at,
    leaseId: row.lease_id,
    length: safeBigint(row.upload_length, 'upload_length'),
    metadata: parseUploadMetadata(row.metadata_header),
    offset: safeBigint(row.upload_offset, 'upload_offset'),
    ownerId: row.owner_id,
    status: row.status,
    updatedAt: requireDate(row.updated_at, 'updated_at'),
  })
}

function safeBigint(value: string, name: string): number {
  const number = Number(value)

  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`PostgreSQL returned an invalid ${name}`)
  }

  return number
}

function requireDate(value: Date | null, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`PostgreSQL returned an invalid ${name}`)
  }

  return value
}

function requireRow(row: UploadRow | undefined): UploadRow {
  if (!row) {
    throw new Error('PostgreSQL did not return the expected upload row')
  }

  return row
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined)
}
