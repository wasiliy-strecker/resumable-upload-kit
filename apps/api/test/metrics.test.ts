import { describe, expect, it } from 'vitest'

import type { UploadTelemetryEvent } from '@resumable-upload-kit/server'

import { createApiMetrics } from '../src/metrics.js'

describe('API metrics', () => {
  it('renders bounded upload and cleanup metrics without high-cardinality data', async () => {
    const metrics = createApiMetrics({ includeProcessMetrics: false })
    const events: UploadTelemetryEvent[] = [
      { kind: 'upload_created' },
      { kind: 'upload_completed' },
      { kind: 'upload_terminated' },
      { bytes: 512, kind: 'bytes_confirmed' },
      { durationMs: 25, kind: 'operation', operation: 'append', outcome: 'success' },
      {
        durationMs: 10,
        errorCode: 'checksum_mismatch',
        kind: 'operation',
        operation: 'append',
        outcome: 'error',
      },
      {
        claimed: 3,
        cleaned: 2,
        durationMs: 1_500,
        failed: 1,
        kind: 'cleanup',
        outcome: 'partial',
      },
      { durationMs: 500, kind: 'cleanup', outcome: 'error' },
    ]

    for (const event of events) metrics.telemetry.record(event)
    metrics.telemetry.record({
      durationMs: 1,
      kind: 'operation',
      operation: 'head',
      outcome: 'success',
      ownerId: 'sensitive-owner',
      uploadId: 'sensitive-upload',
    } as UploadTelemetryEvent)
    const output = await metrics.render()

    expect(metrics.contentType).toContain('text/plain')
    expect(output).toContain(
      'resumable_upload_operations_total{operation="append",outcome="success"} 1',
    )
    expect(output).toContain(
      'resumable_upload_errors_total{operation="append",code="checksum_mismatch"} 1',
    )
    expect(output).toContain('resumable_upload_lifecycle_total{event="created"} 1')
    expect(output).toContain('resumable_upload_lifecycle_total{event="completed"} 1')
    expect(output).toContain('resumable_upload_lifecycle_total{event="terminated"} 1')
    expect(output).toContain('resumable_upload_confirmed_bytes_total 512')
    expect(output).toContain('resumable_upload_cleanup_runs_total{outcome="partial"} 1')
    expect(output).toContain('resumable_upload_cleanup_runs_total{outcome="error"} 1')
    expect(output).toContain('resumable_upload_cleanup_uploads_total{result="cleaned"} 2')
    expect(output).not.toContain('sensitive-owner')
    expect(output).not.toContain('sensitive-upload')
  })

  it('uses isolated registries and can include Node.js process collectors', async () => {
    const first = createApiMetrics()
    const second = createApiMetrics()
    first.telemetry.record({ kind: 'upload_created' })

    const [firstOutput, secondOutput] = await Promise.all([first.render(), second.render()])

    expect(firstOutput).toContain('resumable_upload_node_process_cpu_user_seconds_total')
    expect(firstOutput).toContain('resumable_upload_lifecycle_total{event="created"} 1')
    expect(secondOutput).not.toContain('resumable_upload_lifecycle_total{event="created"}')
  })
})
