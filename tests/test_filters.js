import assert from 'assert';
import {
  clearRegexCache,
  hasNestedQuantifiers,
  parseRegex,
  safeRegexTest,
  getMessageTextAndType,
  shouldForward,
  getRegexPatternsForSource
} from '../src/filters.js';

const nestedPlusFixture = String.fromCodePoint(40, 97, 43, 41, 43, 36);
const alternatingNestedFixture = String.fromCodePoint(40, 97, 124, 98, 43, 41, 43, 36);

function testRegexParsing() {
  console.log("2. Testing parseRegex...");
  const rx1 = parseRegex("hello");
  assert.strictEqual(rx1.test("hello world"), true);
  assert.strictEqual(rx1.test("HELLO world"), true);
  assert.strictEqual(parseRegex("hello"), rx1, 'Compiled patterns should be reused');
  clearRegexCache();
  assert.notStrictEqual(parseRegex("hello"), rx1, 'Config reload must invalidate compiled patterns');

  const rx2 = parseRegex("/\\btest\\b/i");
  assert.strictEqual(rx2.test("this is a test message"), true);
  assert.strictEqual(rx2.test("testing"), false);
  assert.throws(() => parseRegex(nestedPlusFixture), /ReDoS warning/);
  assert.throws(() => parseRegex(alternatingNestedFixture), /ReDoS warning/);
  assert.throws(() => parseRegex("a".repeat(151)), /exceeds maximum length of 150/);
  assert.throws(() => parseRegex("[a-z"), /Invalid regex pattern/);
  assert.throws(
    () => safeRegexTest(new RegExp(nestedPlusFixture), `${'a'.repeat(10_000)}!`, 10),
    /Regex timeout oder Script-Fehler/
  );
  console.log("   -> OK");
}

async function runTests() {
  console.log("=== Running Filters Unit Tests ===");

  // 1. hasNestedQuantifiers
  console.log("1. Testing hasNestedQuantifiers...");
  assert.strictEqual(hasNestedQuantifiers("(a+)+"), true);
  assert.strictEqual(hasNestedQuantifiers("(a|b+)+$"), true);
  assert.strictEqual(hasNestedQuantifiers("(a*)*"), true);
  assert.strictEqual(hasNestedQuantifiers("(a|b)+"), false);
  assert.strictEqual(hasNestedQuantifiers("abc*"), false);
  assert.strictEqual(hasNestedQuantifiers("hello"), false);
  assert.strictEqual(hasNestedQuantifiers("a{1,3}"), false);
  assert.strictEqual(hasNestedQuantifiers("(a{1,3}){1,3}"), true);
  // Character-class awareness: Klammern und Quantoren innerhalb [...] sind literal
  assert.strictEqual(hasNestedQuantifiers("[(]+"), false, "Quantifiers inside character classes should not trigger");
  assert.strictEqual(hasNestedQuantifiers("[a-z()]+"), false, "Parens inside char class are literal");
  assert.strictEqual(hasNestedQuantifiers("([a+])+"), false, "Quantifier inside char class, not in group");
  console.log("   -> OK");

  testRegexParsing();

  // 3. getMessageTextAndType
  console.log("3. Testing getMessageTextAndType...");
  assert.deepStrictEqual(getMessageTextAndType({ content: { _: 'messageText', text: { text: 'hello' } } }), { text: 'hello', type: 'text' });
  assert.deepStrictEqual(getMessageTextAndType({ content: { _: 'messagePhoto', caption: { text: 'my photo' } } }), { text: 'my photo', type: 'photo' });
  assert.deepStrictEqual(getMessageTextAndType({ content: { _: 'messageVideo', caption: { text: 'my video' } } }), { text: 'my video', type: 'video' });
  assert.deepStrictEqual(getMessageTextAndType({ content: { _: 'messageDocument', caption: { text: 'my doc' } } }), { text: 'my doc', type: 'document' });
  assert.deepStrictEqual(getMessageTextAndType({ content: { _: 'messageAudio', caption: { text: 'my audio' } } }), { text: 'my audio', type: 'audio' });
  assert.deepStrictEqual(getMessageTextAndType({ content: { _: 'messageVoiceNote', caption: { text: 'my voice' } } }), { text: 'my voice', type: 'voice' });
  assert.deepStrictEqual(getMessageTextAndType({ content: { _: 'messageVideoNote' } }), { text: '', type: 'video_note' });
  assert.deepStrictEqual(getMessageTextAndType({ content: { _: 'messageAnimation', caption: { text: 'my anim' } } }), { text: 'my anim', type: 'animation' });
  assert.deepStrictEqual(getMessageTextAndType({ content: { _: 'messageSticker' } }), { text: '', type: 'sticker' });
  assert.deepStrictEqual(getMessageTextAndType({ content: { _: 'messageUnknown' } }), { text: '', type: 'messageUnknown' });
  assert.deepStrictEqual(getMessageTextAndType({}), { text: '', type: 'unknown' });
  console.log("   -> OK");

  // 4. shouldForward
  console.log("4. Testing shouldForward...");
  // No filters -> should always forward
  const msg1 = { id: 1, content: { _: 'messageText', text: { text: 'Hello World' } } };
  assert.strictEqual(shouldForward(msg1, {}), true);

  // Type filtering
  assert.strictEqual(shouldForward(msg1, { allowedTypes: ['text'] }), true);
  assert.strictEqual(shouldForward(msg1, { allowedTypes: ['photo'] }), false);

  // Blocked keywords
  assert.strictEqual(shouldForward(msg1, { blockedKeywords: ['world'] }), false);
  assert.strictEqual(shouldForward(msg1, { blockedKeywords: ['foo'] }), true);

  // Allowed keywords
  assert.strictEqual(shouldForward(msg1, { allowedKeywords: ['hello'] }), true);
  assert.strictEqual(shouldForward(msg1, { allowedKeywords: ['foo'] }), false);

  // Custom regex patterns
  assert.strictEqual(shouldForward(msg1, { regexPatterns: ['[a-z]+ World'] }), true);
  assert.strictEqual(shouldForward(msg1, { regexPatterns: ['^World'] }), false);

  // ReDoS text limit (text > 8000 characters is truncated, check that it still behaves safely)
  const longText = "a".repeat(10000);
  const msgLong = { id: 2, content: { _: 'messageText', text: { text: longText } } };
  assert.strictEqual(shouldForward(msgLong, { regexPatterns: ['a{8000}'] }), true);

  // Invalid custom regex pattern should call logCallback and return false
  const logOutputs = [];
  const mockLog = (msg) => { logOutputs.push(msg); };
  assert.strictEqual(shouldForward(msg1, { regexPatterns: ['(a+)+'] }, mockLog), false);
  assert.strictEqual(logOutputs.some(msg => msg.includes('[Filter-FEHLER] Ungültiges Regex-Muster')), true);

  console.log("   -> OK");

  // 5. getRegexPatternsForSource
  console.log("5. Testing getRegexPatternsForSource...");
  
  // Per-source patterns returned when available
  const configWithSource = {
    filters: { regexPatterns: ['global1', 'global2'] },
    sourceFilters: {
      '12345': { regexPatterns: ['source1', 'source2'] },
      '67890': { regexPatterns: ['sourceA'] }
    }
  };
  assert.deepStrictEqual(getRegexPatternsForSource(configWithSource, '12345'), ['source1', 'source2']);
  assert.deepStrictEqual(getRegexPatternsForSource(configWithSource, '67890'), ['sourceA']);
  
  // Fallback to global when source has no entry
  assert.deepStrictEqual(getRegexPatternsForSource(configWithSource, '99999'), ['global1', 'global2']);
  
  // Fallback to global when sourceChatId is null
  assert.deepStrictEqual(getRegexPatternsForSource(configWithSource, null), ['global1', 'global2']);
  
  // Empty sourceFilters -> global fallback
  const configNoSource = {
    filters: { regexPatterns: ['fallback'] },
    sourceFilters: {}
  };
  assert.deepStrictEqual(getRegexPatternsForSource(configNoSource, '12345'), ['fallback']);
  
  // No config -> empty array
  assert.deepStrictEqual(getRegexPatternsForSource(null, '12345'), []);
  
  console.log("   -> OK");

  // 6. shouldForward with per-source regex
  console.log("6. Testing shouldForward with per-source regex...");
  
  const signalMsg = { id: 10, content: { _: 'messageText', text: { text: 'LONG Entry: 100 Target 1: 200 Stoploss: 50' } } };
  const buyMsg = { id: 11, content: { _: 'messageText', text: { text: 'BUY TP: 500' } } };
  
  const perSourceConfig = {
    filters: { regexPatterns: ['(LONG|SHORT)'] },
    sourceFilters: {
      'source_a': { regexPatterns: ['(LONG|SHORT)', 'Entry:\\s*\\d'] },
      'source_b': { regexPatterns: ['BUY|SELL', 'TP:\\s*\\d'] }
    }
  };
  
  // source_a patterns match signalMsg
  assert.strictEqual(shouldForward(signalMsg, perSourceConfig.filters, () => {}, 'source_a', perSourceConfig), true);
  // source_a patterns don't match buyMsg (no LONG/SHORT)
  assert.strictEqual(shouldForward(buyMsg, perSourceConfig.filters, () => {}, 'source_a', perSourceConfig), false);
  
  // source_b patterns match buyMsg
  assert.strictEqual(shouldForward(buyMsg, perSourceConfig.filters, () => {}, 'source_b', perSourceConfig), true);
  // source_b patterns don't match signalMsg (no BUY/SELL)
  assert.strictEqual(shouldForward(signalMsg, perSourceConfig.filters, () => {}, 'source_b', perSourceConfig), false);
  
  // Unknown source falls back to global regex (LONG|SHORT)
  assert.strictEqual(shouldForward(signalMsg, perSourceConfig.filters, () => {}, 'source_c', perSourceConfig), true);
  assert.strictEqual(shouldForward(buyMsg, perSourceConfig.filters, () => {}, 'source_c', perSourceConfig), false);
  
  // Without sourceChatId/config -> uses filters.regexPatterns directly (backward compat)
  assert.strictEqual(shouldForward(signalMsg, perSourceConfig.filters), true);
  assert.strictEqual(shouldForward(buyMsg, perSourceConfig.filters), false);
  
  console.log("   -> OK");
  console.log("\nALL FILTERS UNIT TESTS PASSED!");
}

await runTests().catch(err => {
  console.error("Filters test execution failed:", err);
  process.exit(1);
});
