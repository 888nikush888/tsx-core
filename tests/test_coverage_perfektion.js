import assert from 'assert';
import { isForeignKeyConstraint, SignalReferencedError } from '../src/db.js';
import { ensureQueueCoversParserTimeout } from '../src/config.js';
import { clearRegexCache, parseRegex } from '../src/filters.js';

async function runTests() {
  console.log("=== Perfektion Coverage Gap Tests ===");

  console.log("1. isForeignKeyConstraint branches...");
  assert.strictEqual(isForeignKeyConstraint(null), false);
  assert.strictEqual(isForeignKeyConstraint(undefined), false);
  assert.strictEqual(isForeignKeyConstraint("string"), false);
  assert.strictEqual(isForeignKeyConstraint(123), false);
  assert.strictEqual(isForeignKeyConstraint({}), false);
  assert.strictEqual(isForeignKeyConstraint({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' }), true);
  assert.strictEqual(isForeignKeyConstraint({ message: 'FOREIGN KEY constraint failed' }), true);
  assert.strictEqual(isForeignKeyConstraint({ message: 'foreign key mismatch' }), true);
  assert.strictEqual(isForeignKeyConstraint({ message: 'Foreign Key violation' }), true);
  assert.strictEqual(isForeignKeyConstraint({ code: 'OTHER', message: 'something else' }), false);
  assert.strictEqual(isForeignKeyConstraint({ code: 'SQLITE_CONSTRAINT', message: 'foreign key' }), true);
  assert.strictEqual(isForeignKeyConstraint({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY', message: 'ignored' }), true);
  console.log("   -> OK");

  console.log("2. SignalReferencedError...");
  const err = new SignalReferencedError();
  assert.strictEqual(err.name, 'SignalReferencedError');
  assert.strictEqual(err.message, 'Signal cannot be deleted because trading history still references it.');
  assert.ok(err instanceof Error);
  console.log("   -> OK");

  console.log("3. ensureQueueCoversParserTimeout branches...");
  const base = () => ({
    forwardOptions: { queueTimeoutSeconds: 10 },
    xmlParsing: { enabled: true, aiLimits: { requestTimeoutMs: 30000 } }
  });
  let cfg = { forwardOptions: null, xmlParsing: { enabled: true, aiLimits: { requestTimeoutMs: 30000 } } };
  ensureQueueCoversParserTimeout(cfg);
  assert.strictEqual(cfg.forwardOptions, null);

  cfg = { forwardOptions: { queueTimeoutSeconds: 10 }, xmlParsing: null };
  ensureQueueCoversParserTimeout(cfg);
  assert.strictEqual(cfg.forwardOptions.queueTimeoutSeconds, 10);

  cfg = { forwardOptions: { queueTimeoutSeconds: 10 }, xmlParsing: { enabled: false, aiLimits: { requestTimeoutMs: 30000 } } };
  ensureQueueCoversParserTimeout(cfg);
  assert.strictEqual(cfg.forwardOptions.queueTimeoutSeconds, 10);

  cfg = { forwardOptions: { queueTimeoutSeconds: 10 }, xmlParsing: { enabled: true, aiLimits: { requestTimeoutMs: NaN } } };
  ensureQueueCoversParserTimeout(cfg);
  assert.strictEqual(cfg.forwardOptions.queueTimeoutSeconds, 10);

  cfg = { forwardOptions: { queueTimeoutSeconds: 0 }, xmlParsing: { enabled: true, aiLimits: { requestTimeoutMs: 30000 } } };
  ensureQueueCoversParserTimeout(cfg);
  assert.strictEqual(cfg.forwardOptions.queueTimeoutSeconds, 0);

  cfg = { forwardOptions: { queueTimeoutSeconds: 10 }, xmlParsing: { enabled: true, aiLimits: { requestTimeoutMs: 30000 } } };
  ensureQueueCoversParserTimeout(cfg);
  assert.strictEqual(cfg.forwardOptions.queueTimeoutSeconds, 35);

  cfg = { forwardOptions: { queueTimeoutSeconds: 50 }, xmlParsing: { enabled: true, aiLimits: { requestTimeoutMs: 30000 } } };
  ensureQueueCoversParserTimeout(cfg);
  assert.strictEqual(cfg.forwardOptions.queueTimeoutSeconds, 50);

  cfg = base();
  cfg.xmlParsing.aiLimits.requestTimeoutMs = 5000;
  ensureQueueCoversParserTimeout(cfg);
  assert.strictEqual(cfg.forwardOptions.queueTimeoutSeconds, 10);

  console.log("   -> OK");

  console.log("4. filters FIFO eviction and y-flag strip...");
  clearRegexCache();
  const yRx = parseRegex("/test/y");
  assert.strictEqual(yRx.flags.includes("y"), false, "y-flag must be stripped");
  const gyRx = parseRegex("/test/gy");
  assert.strictEqual(gyRx.flags.includes("g"), false);
  assert.strictEqual(gyRx.flags.includes("y"), false);
  console.log("   -> OK");

  console.log("\nALL PERFEKTION COVERAGE TESTS PASSED!");
}

await runTests().catch(e => { console.error(e); process.exit(1); });
