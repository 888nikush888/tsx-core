# Isolated WSL TLS runtime smoke for `0e6346b7`

The probe ran against detached source revision `0e6346b7ebded36897cbb6e8624db5dd0d712124` on 2026-09-24. It used an external test TLS bundle, synthetic service tokens, internal-only Docker networks and no real exchange credentials. No orders or alert deliveries were sent. The probe's own Compose project was removed afterward; `cleanup.json` records zero remaining project containers, volumes and networks.

`probe.mjs` checked five HTTPS listeners: dashboard, metrics, Executor health from the Forwarder container, Viewer status and alert relay. Each responded over a trusted CA and rejected an untrusted CA, a wrong certificate hostname and cleartext HTTP. It also checked that the Executor origin parser rejects HTTP, unauthorized Viewer and alert requests return 401, and Prometheus reports `up=1` for its HTTPS metrics scrape. `evidence.json` records the result and exact image IDs. `compose-isolation.yml` confined this one-off probe to internal Docker networks.

The Executor check did not execute a dashboard API workflow. The Viewer and relay checks used isolated listeners from the built image, not complete bot or outbound delivery services. Host-published ports were not exercised. The evidence applies to `0e6346b7` only; it does not verify the later integration head, the eventual live host, an exchange order lifecycle or a release gate by itself.

SHA-256: `evidence.json` `88793419CBA583AA21BEA56B3A397DF05AD21D3065A9151D23591B03B97DB382`; `cleanup.json` `CFAC05A298F5DA284A2A9836770698F4B4D0A231888FD11CEB69232F1EB39AEC`; `probe.mjs` `FED32FAD640DF901AEF8474D5EA3F5E692417D616823A4552F288AAAA51123B3`.
