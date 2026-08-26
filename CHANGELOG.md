# Changelog

All notable changes to Resumable Upload Kit are documented in this file. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-08-26

### Added

- A deliberately bounded tus 1.0 server with creation, offset discovery, sequential append,
  checksum, expiration, and termination support
- PostgreSQL coordination with writer leases, filesystem staging, durable append, and crash-tail
  reconciliation
- A framework-independent browser client with IndexedDB checkpoints, offset reconciliation,
  bounded retries, pause, resume, and cancellation
- StrictMode-safe React hooks that keep the upload state machine independent from rendering
- Authenticated Fastify and React examples using external JWT validation and OIDC Authorization
  Code with PKCE
- Restart-safe cleanup, provider-neutral telemetry, Prometheus metrics, health checks, startup
  migrations, and graceful shutdown
- PostgreSQL integration tests and failure-driven Chromium scenarios for ambiguous responses,
  recovery after reload, concurrent writers, and server restart
- Dual ESM/CommonJS archives with generated declarations and clean-consumer package verification
- A production-oriented operations runbook and an attested GitHub release pipeline

### Security

- Upload ownership is derived exclusively from verified JWT subjects
- Unknown and foreign upload identifiers deliberately share the same `404` response
- Tokens, file contents, owners, filenames, metadata, and upload identifiers are excluded from
  persisted checkpoints and telemetry labels

[Unreleased]: https://github.com/wasiliy-strecker/resumable-upload-kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/wasiliy-strecker/resumable-upload-kit/releases/tag/v0.1.0
