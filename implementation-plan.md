# LedgerFlow implementation plan

Goal: deliver a runnable JavaScript financial ledger backend with transaction-backed webhook processing.
Architecture: one Express service and MongoDB replica set; deterministic in-process anomaly model.
Tech stack: Node 24, Express 5, MongoDB Node driver 7, Node test runner.
Spec: docs/design.md.
Execution: native implementation in this workspace.

## Global constraints

Single tenant. No decimal/floating-point amounts accepted. Four documented currencies. Balance cap 9,000,000,000,000. Signed webhook bodies include the idempotency key. Every write belonging to a transfer shares one MongoDB session. No parallel operations in a transaction callback. No TTL on financial identities.

## Tasks

- [x] Define signature and money validation tests before implementing src/security.js and src/validation.js.
- [x] Define API integration tests in test/integration.test.js: 100 duplicate deliveries, changed payload conflicts, cross-channel retries, 30 competing debits and post-debit rollback.
- [x] Implement src/database.js (replica-set requirement, collections/indexes, zero clearing accounts) and src/ledger.js (postTransfer).
- [x] Implement src/reconciliation.js snapshot reconciliation and tampering tests.
- [x] Implement src/anomaly.js amount Isolation Forest and cold-start/outlier unit tests.
- [x] Expose authenticated routes, body limits, errors, readiness and shutdown in src/app.js and src/server.js.
- [x] Add portable configuration generation, local Docker replica set, live demo and API documentation.
- [x] Attempt full replica-set integration suite and record the environment blocker in docs/verification.md.
- [x] Run syntax/dependency checks, review security boundaries and package source without secrets/dependencies.

## Review focus

- Unknown commit outcome: clients must retry the same key and payload.
- New event ID for the same business key: creates a delivery receipt without reposting money.
- Invalid JSON, signature bytes, signature time windows and numeric limits: reject before financial mutations.
- Reconciliation on malformed/tampered records: return discrepancies, not a silent success.
- Insufficient ML history: expose missing evidence, never fabricate a fraud probability.
