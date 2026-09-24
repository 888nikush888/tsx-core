# Full alert contract: remaining adoption blockers

This is a disabled implementation candidate, not deployment approval. Offline tests cover the relay's 0–100 alerts and 1 MiB input boundary. For each complete accepted envelope the Worker sends **one** Telegram JSON document containing the exact `alertname`, `severity`, optional `service`, and optional `correlation_id` values of every received alert. It omits annotations and other labels. A 202 requires both a confirmed Telegram message ID and a confirmed D1 delivered record. Uncertain outcomes remain blocked for operator reconciliation.

## Upstream loss remains possible

`monitoring/alertmanager.yml` still sets `max_alerts: 100`. Alertmanager omits additional alerts and reports their count in `truncatedAlerts`. Neither the relay nor this Worker can recover omitted alerts. The Worker returns 422 if `truncatedAlerts` is positive; it never claims that batch was complete. Before deployment, test an Alertmanager route using `group_by: ['...']` and `max_alerts: 0`, then prove more than 100 distinct synthetic alerts arrive with exact IDs. Do not change routing without volume and timing tests. A single alert with unbounded labels or annotations can still exceed the relay's 1 MiB limit. Rule `for` and Alertmanager `group_wait` also intentionally suppress some short-lived conditions; that is distinct from losing an already-sent webhook.

## Free-platform and external delivery remain unproved

Cloudflare Workers Free permits 10 ms CPU per HTTP invocation, 50 subrequests, and 128 MB per isolate. One Telegram `sendDocument` avoids pagination, but 1 MiB JSON parsing, selected-label serialization, HMAC, D1 operations, and multipart preparation have not been measured on Cloudflare. The relay's outbound timeout defaults to 10 seconds and is configurable up to 60 seconds. Telegram currently permits documents up to 50 MB; this Worker caps its generated document at 2 MiB. Any cap or quota failure returns non-2xx. Offline tests cannot establish CPU headroom, D1 consistency under actual concurrency, Telegram acceptance, or availability.

Telegram offers no idempotency key for a document send. A lost Telegram response or failed D1 commit after a successful send leaves an `unknown` or `pending` reservation and returns 503. Automatic retry could duplicate the incident, so an independent on-call path must detect and reconcile these states. Repeatedly failing Alertmanager notifications need their own externally visible alarm. A 202 proves Telegram and D1 confirmations, not human acknowledgment.

## Activation evidence required

1. Run the offline suite, then test zero and 100 alerts, exactly 1 MiB, a near-1-MiB Unicode `correlation_id`, escaped/control characters, positive `truncatedAlerts`, 429, network uncertainty, malformed Bot API response, D1 failure, concurrent retries, and resolved alerts on the intended Cloudflare account. Record CPU, memory, quotas, one Telegram call, and the actual document's IDs. If Free limits fail, use a receiver with a measured larger budget.
2. Test changed Alertmanager grouping with more than 100 distinct synthetic alerts and a failure/retry. Prove no upstream truncation and observe volume. Keep the 1 MiB sender ceiling detected and independently alarmed; do not claim an unbounded alert contract.
3. On the actual live host, configure secrets and D1, then send an explicitly authorized synthetic firing/resolved alert. A named operator must verify the exact `correlation_id` in the Telegram document and rehearse unknown-outcome reconciliation. Test an independent host-down heartbeat. No live evidence has been collected here.

Official limits: [Alertmanager webhook and grouping](https://prometheus.io/docs/alerting/latest/configuration/), [Telegram `sendDocument`](https://core.telegram.org/bots/api#senddocument), [Workers Free limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 Free quotas](https://developers.cloudflare.com/d1/platform/pricing/).
