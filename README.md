# ledgerflow
A fault-tolerant REST API that ingests high-volume payment webhooks (simulating Paystack/Flutterwave), guarantees idempotency (never processing the same payment twice), uses ACID transactions in MongoDB to update ledgers, and uses an LLM agent to automatically classify and resolve failed/disputed transaction logs.
