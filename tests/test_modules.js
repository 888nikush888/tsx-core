import assert from 'assert';
import { isValidTargetChannel, mergeConfigDefaults } from '../src/config.js';
import { hasNestedQuantifiers, parseRegex } from '../src/filters.js';
import { ConcurrencyQueue } from '../src/queue.js';
import { maskPII } from '../src/ui.js';

async function runTests() {
  console.log("=== Running Modular Unit Tests ===");

  // 1. Target channel validation
  console.log("1. Testing target channel identifier formats...");
  assert.strictEqual(isValidTargetChannel("@my_chan_123"), true);
  assert.strictEqual(isValidTargetChannel("-100123456789"), true);
  assert.strictEqual(isValidTargetChannel("123456789"), true);
  assert.strictEqual(isValidTargetChannel(""), false);
  assert.strictEqual(isValidTargetChannel("@shrt"), false); // Under 5 chars username excluding @
  assert.strictEqual(isValidTargetChannel("not_an_id_or_username"), false);
  console.log("   -> OK");

  const mergedConfig = mergeConfigDefaults({
    apiId: 1,
    xmlParsing: {
      aiLimits: {
        primaryAttempts: 99,
        fallbackAttempts: 0,
        dailyTokenLimit: '5000'
      }
    }
  });
  assert.strictEqual(mergedConfig.xmlParsing.aiLimits.primaryAttempts, 2, 'Out-of-range AI limits must reset to the safe default');
  assert.strictEqual(mergedConfig.xmlParsing.aiLimits.fallbackAttempts, 0);
  assert.strictEqual(mergedConfig.xmlParsing.aiLimits.dailyTokenLimit, 5000);

  // 2. ReDoS checking and regex parsing
  console.log("2. Testing ReDoS protection and regex parsing...");
  // Nested quantifier checks
  assert.strictEqual(hasNestedQuantifiers("(a+)+"), true);
  assert.strictEqual(hasNestedQuantifiers("(a|b+)+$"), true);
  assert.strictEqual(hasNestedQuantifiers("(a|b)+"), false);
  assert.strictEqual(hasNestedQuantifiers("abc*"), false);
  assert.strictEqual(hasNestedQuantifiers("(a*)*"), true);

  // Parsing checks
  assert.throws(() => parseRegex("(a+)+"), /ReDoS warning/);
  assert.throws(() => parseRegex("(a|b+)+$"), /ReDoS warning/);
  
  // Valid patterns must succeed
  const rx1 = parseRegex("/\\btest\\b/i");
  assert.strictEqual(rx1.test("this is a test message"), true);
  assert.strictEqual(rx1.test("testing"), false);

  const rx2 = parseRegex("hello");
  assert.strictEqual(rx2.test("HELLO world"), true);
  console.log("   -> OK");

  // 3. Concurrency Queue
  console.log("3. Testing Concurrency Queue execution limit...");
  const queue = new ConcurrencyQueue(2);
  let activeJobs = 0;
  let maxActiveJobs = 0;

  const makeJob = (delay) => {
    return async () => {
      activeJobs++;
      if (activeJobs > maxActiveJobs) {
        maxActiveJobs = activeJobs;
      }
      await new Promise(r => setTimeout(r, delay));
      activeJobs--;
    };
  };

  await Promise.all([
    queue.add(makeJob(50)),
    queue.add(makeJob(50)),
    queue.add(makeJob(50)),
    queue.add(makeJob(50)),
  ]);

  assert.strictEqual(maxActiveJobs <= 2, true);
  assert.strictEqual(activeJobs, 0);
  console.log("   -> OK");

  // 4. GDPR PII Masking
  console.log("4. Testing GDPR PII Masking...");
  const rawText = "Contact me at +49 170 1234567 or pay to EVM address 0xdCad3a6d3569DF655070DEd06cb7A1b2Ccd1D3AF or BTC address bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfJHXYT12.";
  const maskedText = maskPII(rawText);
  assert.strictEqual(maskedText.includes("+49"), false, "Phone number should be masked");
  assert.strictEqual(maskedText.includes("0xdCad3a6d3569DF655070DEd06cb7A1b2Ccd1D3AF"), false, "EVM address should be masked");
  assert.strictEqual(maskedText.includes("bc1qxy"), false, "BTC address should be masked");
  assert.strictEqual(maskedText.includes("[MASKED_PHONE]"), true, "Phone number masking placeholder not found");
  assert.strictEqual(maskedText.includes("[MASKED_EVM_ADDR]"), true, "EVM address masking placeholder not found");
  assert.strictEqual(maskedText.includes("[MASKED_BTC_ADDR]"), true, "BTC address masking placeholder not found");
  console.log("   -> OK");

  console.log("\nALL MODULE UNIT TESTS PASSED!");
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
