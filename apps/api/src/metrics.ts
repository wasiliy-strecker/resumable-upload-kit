import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client'

import type { UploadTelemetry, UploadTelemetryEvent } from '@resumable-upload-kit/server'

export interface MetricsEndpoint {
  readonly contentType: string
  render(): Promise<string>
}

export interface ApiMetrics extends MetricsEndpoint {
  readonly telemetry: UploadTelemetry
}

export interface CreateApiMetricsOptions {
  readonly includeProcessMetrics?: boolean
}

export function createApiMetrics(options: CreateApiMetricsOptions = {}): ApiMetrics {
  const registry = new Registry()

  if (options.includeProcessMetrics ?? true) {
    collectDefaultMetrics({ prefix: 'resumable_upload_node_', register: registry })
  }

  const operations = new Counter({
    help: 'Completed resumable upload service operations',
    labelNames: ['operation', 'outcome'] as const,
    name: 'resumable_upload_operations_total',
    registers: [registry],
  })
  const operationDuration = new Histogram({
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    help: 'Resumable upload service operation duration in seconds',
    labelNames: ['operation', 'outcome'] as const,
    name: 'resumable_upload_operation_duration_seconds',
    registers: [registry],
  })
  const errors = new Counter({
    help: 'Failed resumable upload service operations by bounded error code',
    labelNames: ['operation', 'code'] as const,
    name: 'resumable_upload_errors_total',
    registers: [registry],
  })
  const lifecycle = new Counter({
    help: 'Resumable upload lifecycle transitions',
    labelNames: ['event'] as const,
    name: 'resumable_upload_lifecycle_total',
    registers: [registry],
  })
  const confirmedBytes = new Counter({
    help: 'Bytes durably confirmed by the resumable upload service',
    name: 'resumable_upload_confirmed_bytes_total',
    registers: [registry],
  })
  const cleanupRuns = new Counter({
    help: 'Completed cleanup runs by bounded outcome',
    labelNames: ['outcome'] as const,
    name: 'resumable_upload_cleanup_runs_total',
    registers: [registry],
  })
  const cleanupDuration = new Histogram({
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
    help: 'Cleanup run duration in seconds',
    labelNames: ['outcome'] as const,
    name: 'resumable_upload_cleanup_duration_seconds',
    registers: [registry],
  })
  const cleanupUploads = new Counter({
    help: 'Uploads processed by cleanup runs',
    labelNames: ['result'] as const,
    name: 'resumable_upload_cleanup_uploads_total',
    registers: [registry],
  })

  const telemetry: UploadTelemetry = {
    record(event): void {
      recordEvent(event)
    },
  }

  function recordEvent(event: UploadTelemetryEvent): void {
    switch (event.kind) {
      case 'operation':
        operations.labels(event.operation, event.outcome).inc()
        operationDuration.labels(event.operation, event.outcome).observe(event.durationMs / 1_000)
        if (event.outcome === 'error') errors.labels(event.operation, event.errorCode).inc()
        return
      case 'upload_created':
        lifecycle.labels('created').inc()
        return
      case 'upload_completed':
        lifecycle.labels('completed').inc()
        return
      case 'upload_terminated':
        lifecycle.labels('terminated').inc()
        return
      case 'bytes_confirmed':
        confirmedBytes.inc(event.bytes)
        return
      case 'cleanup':
        cleanupRuns.labels(event.outcome).inc()
        cleanupDuration.labels(event.outcome).observe(event.durationMs / 1_000)
        if (event.outcome !== 'error') {
          cleanupUploads.labels('claimed').inc(event.claimed)
          cleanupUploads.labels('cleaned').inc(event.cleaned)
          cleanupUploads.labels('failed').inc(event.failed)
        }
    }
  }

  return Object.freeze({
    contentType: registry.contentType,
    async render(): Promise<string> {
      return registry.metrics()
    },
    telemetry,
  })
}
