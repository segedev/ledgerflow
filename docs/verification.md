# Verification record — 22 October 2026

## Verified in this workspace

- Node.js 24.19.0, npm 11.9.0.
- Dependencies installed successfully; lockfile included.
- Final `npm test`: **23 tests total; 13 passed, 10 failed at the shared MongoDB startup hook, 0 skipped**. The integration test bodies did not execute.
- `npm run test:unit`: 13 checks passed for exact-byte HMAC verification, missing/invalid signatures, stale/future timestamps, HTTP authentication, JSON/type/size/field validation, limiter/health behavior, anomaly cold start/outlier ranking, and pure snapshot reconciliation including malformed records.
- `npm audit --omit=dev`: no reported vulnerabilities (0 total) at the time checked. This does not establish application security.
- JavaScript syntax checked; OpenAPI JSON parses; source formatted consistently.

## Integration blocker

`mongodb-memory-server` downloaded and tried to start real MongoDB 8.2.6 and 8.0.17. Both exited before accepting connections with:

```
std::exception in initAndListen, terminating
open: Operation not permitted
```

The test runner consequently reports `UnexpectedCloseError`, exit code 100. Diagnostic tracing is also unavailable in this execution environment. The exact denied operation is unverified. No transaction test has been replaced with a mock or silently skipped. The final test configuration pins MongoDB 8.0.17 to match the development compose image.

The 10 integration scenarios cover duplicate delivery, identity conflicts, competing debits, rollback after a debit, error paths, actual database-backed reconciliation, and read-only anomaly requests. Their behavior remains **unverified** until the suite runs against a permitted MongoDB process. Source review and passing unit tests do not establish ACID correctness.

## Run the missing verification

From the extracted project on a machine able to run MongoDB:

```sh
npm ci
npm test
npm run setup
docker compose up --build -d
npm run demo
```

`npm test` uses a disposable local replica set, independent of `.env`. It must finish with all 23 tests passing before relying on the concurrency and rollback claims. The GitHub Actions workflow runs the same suite on Ubuntu after this folder becomes a repository root. It has been authored but has not run remotely.

Docker is not installed in this workspace, so the compose configuration and live demo were not executed here. Configuration generation was smoke-tested separately. Real throughput, multi-node failover, crash recovery, external bank reconciliation and fraud-detection accuracy have not been measured. No zero-corruption or production-readiness certification is claimed.
