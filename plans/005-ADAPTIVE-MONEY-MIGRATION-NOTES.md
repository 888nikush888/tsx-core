# 005 — M46 adaptive monetary evaluation schema

## Scope and preflight (2026-09-03)

Migration 46, `exact_adaptive_risk_money_and_source_provenance`, changes only
`trading_channel_risk_evaluations` and `workflow_adaptive_risk_evaluations`.
Both were already required database tables; the required-table list did not change.
All earlier migrations, checksums and money/source tables remain untouched.

Before implementation, a real temporary schema45 database was inspected using every
table's `foreign_key_list`, the target `table_info`/`index_list`, and dependent
view/trigger definitions. Neither target has incoming FKs or dependent views/triggers.
Each has its original primary key, scoped policy/week unique constraint and descending
time index. Workflow evaluations additionally reference `workflow_adaptive_risk_state`
with `ON DELETE RESTRICT`. The permanent migration test repeats this preflight.

Each table is rebuilt inside the existing migration transaction with foreign keys still
enabled: create the v46 target, copy explicitly named original columns **and original
rowid**, drop the old table, rename, and recreate the original index. All remaining
column constraints, foreign keys and unique semantics are retained.

## Exact additions

- Existing `realized_pnl` and `return_percent` become nullable, without changing a single
  original value. No zero, rounding, normalization or historical backfill is introduced.
- Nullable `realized_pnl_value_json` and `return_percent_value_json`: valid JSON, fewer
  than 16384 BLOB bytes, and no literal NUL. Shape and MoneyValue semantics remain the
  consumer's responsibility.
- Nullable `reporting_currency`.
- Nullable `source_hash`: exactly 64 lowercase hexadecimal characters **and 64 BLOB
  bytes**. The byte check rejects SQLite's otherwise accepted NUL-suffixed hash.
- Nullable `source_json`: valid JSON, fewer than 262144 BLOB bytes, no literal NUL.
  `source_hash` and `source_json` must both be null or both nonnull.
- Nullable `invalidated_at` (nonnegative when present) and `invalidation_reason`.

All seven added fields start at NULL for every old row. There is no invented past source
proof or historical invalidation timestamp. This schema alone does not implement cache
validation, economic evaluation or conservative adaptive decisions; those consumers
are a separate coordinated task.

## Tests and fixture rewind

New `test_trading_adaptive_money_migration.js` is in the normal runner. It was first red
against actual schema45 (the two economic columns remained NOT NULL), then green with
M46. An additional genuine red hash-suffix test drove the final byte-length check.

Permanent cases cover:

- Actual 45→46 upgrade; negative tiny losses, signed/zero-padded decimal strings, a
  literal NUL in preexisting free text, sparse rowids and parent rows remain byte-exact.
- All new values initially NULL; metadata comparison verifies every original column,
  FK, unique index and descending index apart from the two explicitly nullable fields.
- Exact old action/NOT NULL/policy hash/unique/FK guards, including parent delete RESTRICT.
- Nullable aliases with retained exact negative MoneyValue JSON; syntax, literal NUL,
  multibyte byte-count limits and both just-below/at-limit JSON boundaries.
- Paired source fields, lowercase hash/NUL suffix checks, zero vs negative invalidation
  times, and preservation of source/invalidated records through backup/reopen.
- Genuine schema45 and current SQLite backups reopened independently, repeated reopen,
  foreign-key and integrity checks.
- Obstructions at the first table, second table after the first rebuild, and final index
  after both rebuilds: the migration fails and its complete DDL/data effects roll back.
  The old schema, old text and original obstruction remain; removing only the fixture
  obstruction allows a successful retry.

The central fixture helper `dropAdaptiveMoneySchema` restores the original schema45
constraints and copies every original column/rowid before dropping M46. It is the first
part of `dropFxMoneySchema`, so existing 45/44/43/42/41/40/37/36 test rewinds also remove
M46 correctly. It checks **before any DDL** that no nullable alias, new evidence,
currency or invalidation data would be lost. Such a rewind is deliberately rejected
via its SQL JSON guard; it never manufactures an old decimal or deletes economic rows.
This is a test helper, not a production downgrade facility.

The coordinated viewer test correction removes its stale latest-schema=42 assumption.
It now compares the actual database version and every applied version/name/checksum
against this binary's expected migrations, while still checking M42's specific identity.

## Focused gate status at handoff

Passed: new M46 test, M45 FX money migration, M43 FX migration, M44 schedule migration,
M42 quantity migration, trading risk repository, ingress migration, M40 fill migration,
M41 cashleg migration and Telegram viewer core (10 distinct files). ESLint with zero
warnings for all touched files and the whitespace/diff check pass.

Separate integration issue, reported to Root: `test_trading_money_migration.js:82`
expects the first immutable accounting projection evidence to retain original
`source.position.realized_pnl = '999'`; current unrelated accounting source normalization
returns NULL. No M46 schema or test adjustment hides this failure.

The attempted typecheck also sees the actively edited ChannelRisk/Engine consumer
interfaces and old helper references; M46 adds no such imports or types. No complete
suite, coverage or all-project-green claim was made for this narrow schema handoff.
Only temporary local databases were used. No server/provider/credential contact or
commit/push occurred. Schema/test scope is frozen after this handoff.
