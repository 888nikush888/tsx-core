# External incident receiver candidate

This Cloudflare Worker remains **disabled**. It is a candidate HTTPS endpoint for `src/alert_relay.ts`; no Worker, D1 database, Telegram bot, or on-call route was deployed or contacted by its offline tests. The [adoption blockers](FULL-CONTRACT-BLOCKERS.md) remain open.

It accepts the relay's Bearer token and exact `X-Alert-Source: tsx-core` header at `POST /alerts`. It bounds the body to 1 MiB, validates zero through 100 alerts, and rejects positive `truncatedAlerts` rather than acknowledging an incomplete group. Required `alertname`/`severity` and any present `service`/`correlation_id` must be strings; this avoids rounding numeric IDs. Each complete input produces one Telegram `sendDocument` call. The attached JSON preserves those values exactly, including long, empty, escaped, and Unicode strings. Annotations, other labels, and the raw body are not forwarded to Telegram, stored in D1, or logged. `GET /healthz` establishes process response only; host-down monitoring is separate.

A D1 row with a unique HMAC delivery key is reserved before Telegram. The same key is printed as a receipt in the Telegram caption so an operator can match an uncertain D1 row to a document. Telegram success requires a positive message ID, the configured chat ID, and a document file ID before D1 can mark delivery. A duplicate receives 202 only after previously confirmed Telegram delivery and D1 completion. Pending or uncertain deliveries return 503 without another Telegram call. A verified Telegram 429 with `ok:false` and bounded `retry_after` is the sole automatic retry case. Successful rows are deduplicated for 20 minutes, allowing Alertmanager's current 30-minute reminders. A network uncertainty or post-send D1 failure stays blocked for manual reconciliation; Telegram has no idempotency key. A 202 does not mean a human viewed the document.

## Operator preparation; no deployment performed

1. Create a Cloudflare Worker and D1 database, bind it as `DB`, then apply `schema.sql`. `wrangler.toml.example` intentionally has no real database ID.
2. Configure `RELAY_TOKEN`, `DEDUPE_SECRET`, and `TELEGRAM_BOT_TOKEN` as independent **Worker secret bindings**, not plaintext Wrangler variables or repository files. Scope `TELEGRAM_CHAT_ID` to the intended private chat. Keep the bot token and chat ID off the VPS.
3. Set the VPS relay's `ALERT_WEBHOOK_URL` to the Worker's HTTPS `/alerts` endpoint and `ALERT_WEBHOOK_TOKEN` to the same value as `RELAY_TOKEN`. Do this only after the blocker record's boundary, quota, and end-to-end tests pass.
4. Do not use the current Alertmanager `max_alerts: 100` for a full-delivery claim: it can truncate above 100. Test any grouping change before routing production traffic.
5. Name an on-call operator. Confirm an authorized synthetic firing/resolved alert and the exact `correlation_id` in the received JSON document. Independently test the host-down heartbeat.

For an `unknown` or stuck `pending` D1 row, inspect the delivery key and timestamp and check Telegram. Mark it delivered only after confirming the document exists; remove it for retry only after proving no document was sent. Do not clear it based only on a timeout or HTTP status. Daily cron removes at most 1,000 expired **delivered** rows and never erases unresolved outcomes.

The Worker uses no Node APIs or third-party packages. `node tests/test_incident_receiver_worker.js` runs offline with fake Telegram and D1 bindings; it never calls Telegram. Real Cloudflare D1 concurrency, CPU, Bot API delivery, and public endpoint availability still need staging evidence. The `services/**` directory is outside the current exchange implementation source inventory, so integration requires a deliberate source/release evidence decision.
