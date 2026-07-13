import assert from 'assert';
import { validateXmlStructure } from '../src/signal_parser.js';

const SAMPLE_SIGNAL_1 = `
<signal>
    <action>SHORT</action>
    <pair>HYPEUSDT</pair>
    <entry_range>
        <min>68.60</min>
        <max>70.07</max>
    </entry_range>
    <targets>
        <target id="1">67.32</target>
        <target id="2">65.95</target>
    </targets>
    <stoploss>70.97</stoploss>
    <leverage>15</leverage>
</signal>
`;

const SAMPLE_SIGNAL_2 = `
<signal>
    <action>LONG</action>
    <pair>ETHUSDT</pair>
    <entry_range>
        <min>3400.50</min>
        <max>3400.50</max>
    </entry_range>
    <targets>
        <target id="1">3500.00</target>
    </targets>
    <stoploss>3300.00</stoploss>
</signal>
`;

function runTests() {
  let passed = 0;
  let failed = 0;

  function testPass(name) {
    console.log(`  ✓ ${name}`);
    passed++;
  }

  function testFail(name, err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed++;
  }

  console.log('=== Running TS XML Validator Unit Tests ===');

  // Test: valid structure passes
  try {
    validateXmlStructure(SAMPLE_SIGNAL_1);
    testPass('Valid structure (SHORT, entry range, targets, leverage) passes');
  } catch (e) { testFail('Valid structure 1', e); }

  try {
    validateXmlStructure(SAMPLE_SIGNAL_2);
    testPass('Valid structure (LONG, single entry, single target, no leverage) passes');
  } catch (e) { testFail('Valid structure 2', e); }

  // Test: root element check
  try {
    assert.throws(() => validateXmlStructure('<notsignal></notsignal>'), /Root tag must be 'signal'/);
    testPass('Rejects invalid root elements');
  } catch (e) { testFail('Root tag validation', e); }

  // Test: action validation
  try {
    assert.throws(() => validateXmlStructure(`
<signal>
    <action>BUY</action>
    <pair>BTCUSDT</pair>
    <stoploss>90000</stoploss>
</signal>
    `), /Action must be 'LONG' or 'SHORT'/);
    testPass('Rejects invalid action values');
  } catch (e) { testFail('Action validation', e); }

  // Test: missing required tag
  try {
    assert.throws(() => validateXmlStructure(`
<signal>
    <action>LONG</action>
    <stoploss>90000</stoploss>
</signal>
    `), /Missing required tag or value for 'pair'/);
    testPass('Rejects missing required tags (pair)');
  } catch (e) { testFail('Missing required tags', e); }

  // Test: invalid stoploss
  try {
    assert.throws(() => validateXmlStructure(`
<signal>
    <action>LONG</action>
    <pair>BTCUSDT</pair>
    <stoploss>not_a_number</stoploss>
</signal>
    `), /Stoploss must be a valid number/);
    testPass('Rejects invalid stoploss format');
  } catch (e) { testFail('Invalid stoploss', e); }

  // Test: invalid entry range
  try {
    assert.throws(() => validateXmlStructure(`
<signal>
    <action>LONG</action>
    <pair>BTCUSDT</pair>
    <entry_range>
        <min>90000</min>
    </entry_range>
    <stoploss>85000</stoploss>
</signal>
    `), /entry_range is missing 'max'/);
    testPass('Rejects entry range missing min/max');
  } catch (e) { testFail('Invalid entry range structure', e); }

  try {
    assert.throws(() => validateXmlStructure(`
<signal>
    <action>LONG</action>
    <pair>BTCUSDT</pair>
    <entry_range>
        <min>90000</min>
        <max>abc</max>
    </entry_range>
    <stoploss>85000</stoploss>
</signal>
    `), /min\/max in entry_range must be valid numbers/);
    testPass('Rejects non-numeric entry range bounds');
  } catch (e) { testFail('Non-numeric entry range bounds', e); }

  // Test: invalid targets
  try {
    assert.throws(() => validateXmlStructure(`
<signal>
    <action>LONG</action>
    <pair>BTCUSDT</pair>
    <targets>
    </targets>
    <stoploss>85000</stoploss>
</signal>
    `), /targets tag is present but contains no target tags/);
    testPass('Rejects empty targets list container');
  } catch (e) { testFail('Empty targets', e); }

  try {
    assert.throws(() => validateXmlStructure(`
<signal>
    <action>LONG</action>
    <pair>BTCUSDT</pair>
    <targets>
        <target>95000</target>
    </targets>
    <stoploss>85000</stoploss>
</signal>
    `), /target element is missing 'id' attribute/);
    testPass('Rejects targets missing id attribute');
  } catch (e) { testFail('Target ID missing', e); }

  try {
    assert.throws(() => validateXmlStructure(`
<signal>
    <action>LONG</action>
    <pair>BTCUSDT</pair>
    <targets>
        <target id="1">not_a_number</target>
    </targets>
    <stoploss>85000</stoploss>
</signal>
    `), /target value must be a valid number/);
    testPass('Rejects non-numeric target prices');
  } catch (e) { testFail('Non-numeric target prices', e); }

  // Test: invalid leverage
  try {
    assert.throws(() => validateXmlStructure(`
<signal>
    <action>LONG</action>
    <pair>BTCUSDT</pair>
    <stoploss>85000</stoploss>
    <leverage>15.5</leverage>
</signal>
    `), /leverage must be an integer/);
    testPass('Rejects non-integer leverage');
  } catch (e) { testFail('Non-integer leverage', e); }

  // Summary
  console.log(`\\n\${'='.repeat(50)}`);
  console.log(`Tests abgeschlossen: \${passed} bestanden, \${failed} fehlgeschlagen`);
  console.log(`\${'='.repeat(50)}\\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
