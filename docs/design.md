# LedgerFlow design

## Goal and scope

Implement the supplied JavaScript transactional webhook/reconciliation backend. This is a single-tenant service for an administrator and a trusted settlement provider, with four currencies (NGN, USD, EUR, GBP). Each wallet starts at zero. No frontend, real bank connector, payouts, FX conversion, multi-tenant identity system or external AI account is assumed.

## Invariants

Amounts and cached balances are safe integers in minor units. Each operation posts equal negative and positive entries in one currency. Wallets cannot be negative. All balances are bounded by 9,000,000,000,000 minor units in magnitude. Only signed settlement webhooks can debit system clearing accounts; a negative clearing balance represents the external funding liability. Every committed transfer has one journal and one permanent idempotency receipt. A webhook event maps to a committed result. Clearing accounts are initialized at zero and wallet creation cannot introduce money.

## Architecture

Express validates the raw signed body before parsing webhook JSON; all remaining financial routes require an administrator Bearer secret. MongoDB's driver executes all operations sequentially in a transaction with snapshot reads and journaled majority writes. Unique _id identities on receipts and events prevent competing requests from applying the same operation twice. Conditional balance updates prevent overdrafts. Driver transaction/commit retries handle labeled transient failures; bounded fresh-transaction retries resolve unique-key races. A success response is emitted only after commit. No external side effects execute in retry callbacks.

REST transfers use a header idempotency key. Webhooks embed the key in the signed body. A canonical semantic transfer fingerprint means whitespace and field order do not create conflicts; changed financial fields do. Event IDs additionally bind the business key. Receipts have no TTL. All valid deliveries of the same logical transfer must share the same business key. Distinct keys and event IDs cannot be deduplicated semantically without an upstream payment reference contract.

## Reconciliation

Read accounts, transfers, journals, receipts and events in one snapshot. Rebuild wallet balances from entries with BigInt arithmetic, check each journal against its transfer, check receipt/event references and per-currency zero totals. Return discrepancies without modifying records. Bound online scans to 50,000 documents per collection and return at most 200 issues with the complete issue count. External bank statement matching is outside this initial internal reconciliation scope.

## Anomaly model

Train a seeded, 100-tree, one-dimensional Isolation Forest on up to 2,000 recent outgoing transfers for one account/currency. Input feature: log(1+amount). Fewer than 30 samples returns insufficient_data. A score threshold is illustrative and explicitly uncalibrated. The endpoint never blocks or changes a transfer. No records leave the service.

## Verification and operational limits

Use actual MongoDB replica-set integration tests for concurrent duplicate requests, unique concurrent overdrafts, key conflicts and transaction rollback. Unit-test signatures and anomaly ranking. A single-node development replica set demonstrates transaction behavior, not node failover or high availability. Multi-node fault injection, independent security review and realistic throughput measurements remain production work. No universal zero-corruption guarantee is claimed.
