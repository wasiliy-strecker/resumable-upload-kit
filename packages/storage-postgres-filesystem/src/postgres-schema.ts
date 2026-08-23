import type { Pool } from 'pg'

const migrationLockNamespace = 1_704_195_611
const migrationLockKey = 1

export async function runUploadMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      migrationLockNamespace,
      migrationLockKey,
    ])
    await client.query(`
      CREATE TABLE IF NOT EXISTS resumable_upload_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS resumable_uploads (
        id uuid PRIMARY KEY,
        owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
        upload_length bigint NOT NULL CHECK (
          upload_length BETWEEN 0 AND 9007199254740991
        ),
        upload_offset bigint NOT NULL DEFAULT 0 CHECK (
          upload_offset BETWEEN 0 AND upload_length
        ),
        status text NOT NULL CHECK (
          status IN ('active', 'completed', 'expired', 'terminated')
        ),
        metadata_header text NOT NULL DEFAULT '',
        expires_at timestamptz,
        lease_id uuid,
        lease_expires_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
        CHECK (lease_id IS NULL OR status = 'active'),
        CHECK (status <> 'active' OR expires_at IS NOT NULL),
        CHECK (status <> 'completed' OR (
          upload_offset = upload_length AND expires_at IS NULL
        )),
        CHECK (status NOT IN ('terminated') OR expires_at IS NULL)
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS resumable_uploads_expiration_idx
      ON resumable_uploads (expires_at)
      WHERE status = 'active'
    `)
    await client.query(`
      INSERT INTO resumable_upload_migrations (version)
      VALUES (1)
      ON CONFLICT (version) DO NOTHING
    `)
    await client.query(`
      ALTER TABLE resumable_uploads
        ADD COLUMN IF NOT EXISTS cleanup_claim_id uuid,
        ADD COLUMN IF NOT EXISTS cleanup_claim_expires_at timestamptz,
        ADD COLUMN IF NOT EXISTS cleanup_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS purged_at timestamptz
    `)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'resumable_uploads_cleanup_claim_pair'
            AND conrelid = 'resumable_uploads'::regclass
        ) THEN
          ALTER TABLE resumable_uploads
          ADD CONSTRAINT resumable_uploads_cleanup_claim_pair
          CHECK ((cleanup_claim_id IS NULL) = (cleanup_claim_expires_at IS NULL));
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'resumable_uploads_purge_state'
            AND conrelid = 'resumable_uploads'::regclass
        ) THEN
          ALTER TABLE resumable_uploads
          ADD CONSTRAINT resumable_uploads_purge_state
          CHECK (
            purged_at IS NULL OR (
              status IN ('expired', 'terminated')
              AND cleanup_claim_id IS NULL
              AND cleanup_claim_expires_at IS NULL
            )
          );
        END IF;
      END
      $$
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS resumable_uploads_cleanup_idx
      ON resumable_uploads (cleanup_claim_expires_at, updated_at, id)
      WHERE status IN ('expired', 'terminated') AND purged_at IS NULL
    `)
    await client.query(`
      INSERT INTO resumable_upload_migrations (version)
      VALUES (2)
      ON CONFLICT (version) DO NOTHING
    `)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
