import assert from 'assert';
import { normalizeSignalXml, isDuplicateSignal } from '../src/dupe_blocker.js';
import { closeDb, initDb, saveSignal } from '../src/db.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import os from 'os';
import { mkdtemp, rm } from 'fs/promises';

const SAMPLE_SIGNAL_1 = `<signal>
    <action>SHORT</action>
    <pair>BTCUSDT</pair>
    <entry_range>
        <min>65700.00000000</min>
        <max>66710.87500000</max>
    </entry_range>
    <targets>
        <target id="1">64739.12500000</target>
        <target id="2">63753.25000000</target>
    </targets>
    <stoploss>67411.20656250</stoploss>
    <leverage>15</leverage>
</signal>`;

const SAMPLE_SIGNAL_1_DIFFERENT_WHITESPACE = `<signal><action>SHORT</action><pair>BTCUSDT</pair><entry_range><min>65700.00000000</min><max>66710.87500000</max></entry_range><targets><target id="1">64739.12500000</target><target id="2">63753.25000000</target></targets><stoploss>67411.20656250</stoploss><leverage>15</leverage></signal>`;

const SAMPLE_SIGNAL_2 = `<signal>
    <action>LONG</action>
    <pair>ETHUSDT</pair>
    <entry_range>
        <min>3500.00000000</min>
        <max>3600.00000000</max>
    </entry_range>
    <targets>
        <target id="1">3700.00000000</target>
    </targets>
    <stoploss>3400.00000000</stoploss>
    <leverage>10</leverage>
</signal>`;

const SAMPLE_SIGNAL_WITH_XML_DECL = `<?xml version="1.0" encoding="UTF-8"?>
<signal>
    <action>SHORT</action>
    <pair>BTCUSDT</pair>
    <entry_range>
        <min>65700.00000000</min>
        <max>66710.87500000</max>
    </entry_range>
    <targets>
        <target id="1">64739.12500000</target>
        <target id="2">63753.25000000</target>
    </targets>
    <stoploss>67411.20656250</stoploss>
    <leverage>15</leverage>
</signal>`;

function runNormalizationTests(testPass, testFail) {
  console.log('\n=== 1. normalizeSignalXml Tests ===');
  try {
    assert.strictEqual(normalizeSignalXml(SAMPLE_SIGNAL_1), normalizeSignalXml(SAMPLE_SIGNAL_1_DIFFERENT_WHITESPACE));
    testPass('Whitespace-Toleranz: Identische Signale mit verschiedenem Whitespace');
  } catch (error) { testFail('Whitespace-Toleranz', error); }
  try {
    assert.strictEqual(normalizeSignalXml(SAMPLE_SIGNAL_1), normalizeSignalXml(SAMPLE_SIGNAL_WITH_XML_DECL));
    testPass('XML-Declaration wird entfernt');
  } catch (error) { testFail('XML-Declaration wird entfernt', error); }
  try {
    assert.notStrictEqual(normalizeSignalXml(SAMPLE_SIGNAL_1), normalizeSignalXml(SAMPLE_SIGNAL_2));
    testPass('Unterschiedliche Signale ergeben unterschiedliche Normalisierung');
  } catch (error) { testFail('Unterschiedliche Signale', error); }
  try {
    assert.strictEqual(normalizeSignalXml(''), '');
    assert.strictEqual(normalizeSignalXml(null), '');
    assert.strictEqual(normalizeSignalXml(undefined), '');
    testPass('Leere/null/undefined Eingaben werden behandelt');
  } catch (error) { testFail('Leere Eingaben', error); }
}

async function runTests() {
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

  // Always use an isolated database. This test must never mutate runtime data.
  const testDir = await mkdtemp(path.join(os.tmpdir(), 'forwarder-dupe-test-'));
  const dbPath = path.join(testDir, 'forwarder.db');
  await initDb(dbPath);

  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  await db.exec(`DELETE FROM signals`);

  runNormalizationTests(testPass, testFail);

  // ========== isDuplicateSignal Tests ==========
  console.log('\n=== 2. isDuplicateSignal Tests ===');

  // Test: Leerer Signal-Ordner (Datenbank leer)
  try {
    await db.exec(`DELETE FROM signals`);
    const result = await isDuplicateSignal(SAMPLE_SIGNAL_1, '', 24);
    assert.strictEqual(result.isDupe, false, 'Empty DB should not find duplicates');
    testPass('Leere Datenbank: Kein Duplikat');
  } catch (e) { testFail('Leere Datenbank', e); }

  // Test: Kein Duplikat (verschiedenes Signal vorhanden)
  try {
    await db.exec(`DELETE FROM signals`);
    await saveSignal('sig_2', 'channel1', 2, SAMPLE_SIGNAL_2, normalizeSignalXml(SAMPLE_SIGNAL_2));
    const result = await isDuplicateSignal(SAMPLE_SIGNAL_1, '', 24);
    assert.strictEqual(result.isDupe, false, 'Different signal should not be a duplicate');
    testPass('Verschiedenes Signal: Kein Duplikat');
  } catch (e) { testFail('Verschiedenes Signal', e); }

  // Test: Duplikat innerhalb des Cooldowns (gerade erstellt)
  try {
    await db.exec(`DELETE FROM signals`);
    await saveSignal('sig_1', 'channel1', 1, SAMPLE_SIGNAL_1, normalizeSignalXml(SAMPLE_SIGNAL_1));
    const result = await isDuplicateSignal(SAMPLE_SIGNAL_1, '', 24);
    assert.strictEqual(result.isDupe, true, 'Recent identical signal should be a duplicate');
    assert.ok(result.matchFile, 'Should have a matchFile');
    testPass('Duplikat innerhalb Cooldown: Blockiert');
  } catch (e) { testFail('Duplikat innerhalb Cooldown', e); }

  // Test: Duplikat mit verschiedenem Whitespace wird erkannt
  try {
    await db.exec(`DELETE FROM signals`);
    await saveSignal('sig_1', 'channel1', 1, SAMPLE_SIGNAL_1_DIFFERENT_WHITESPACE, normalizeSignalXml(SAMPLE_SIGNAL_1_DIFFERENT_WHITESPACE));
    const result = await isDuplicateSignal(SAMPLE_SIGNAL_1, '', 24);
    assert.strictEqual(result.isDupe, true, 'Same signal with different whitespace should be detected');
    testPass('Whitespace-Toleranz: Duplikat trotz verschiedenem Whitespace');
  } catch (e) { testFail('Whitespace-Toleranz Duplikat', e); }

  // Test: Duplikat mit XML-Declaration wird erkannt
  try {
    await db.exec(`DELETE FROM signals`);
    await saveSignal('sig_1', 'channel1', 1, SAMPLE_SIGNAL_WITH_XML_DECL, normalizeSignalXml(SAMPLE_SIGNAL_WITH_XML_DECL));
    const result = await isDuplicateSignal(SAMPLE_SIGNAL_1, '', 24);
    assert.strictEqual(result.isDupe, true, 'Signal with XML declaration should match same signal without it');
    testPass('XML-Declaration-Toleranz: Duplikat trotz XML-Header');
  } catch (e) { testFail('XML-Declaration-Toleranz', e); }

  try {
    await db.exec(`DELETE FROM signals`);
    await saveSignal('signal_channel1_1', 'channel1', 1, SAMPLE_SIGNAL_1, normalizeSignalXml(SAMPLE_SIGNAL_1));
    const retryResult = await isDuplicateSignal(SAMPLE_SIGNAL_1, '', 24, 'signal_channel1_1');
    assert.strictEqual(retryResult.isDupe, false, 'A retry must not be blocked by its own previously persisted signal');
    testPass('Crash-Retry ignoriert den eigenen Signal-Datensatz');
  } catch (e) { testFail('Crash-Retry Self-Deduplication', e); }

  // Test: Cooldown abgelaufen — Signal wird erlaubt
  try {
    await db.exec(`DELETE FROM signals`);
    await saveSignal('sig_1', 'channel1', 1, SAMPLE_SIGNAL_1, normalizeSignalXml(SAMPLE_SIGNAL_1));
    // Simulate signal was created 25 hours ago
    const pastTime = Date.now() - 25 * 60 * 60 * 1000;
    await db.run(`UPDATE signals SET created_at = ? WHERE id = ?`, [pastTime, 'sig_1']);
    
    const result = await isDuplicateSignal(SAMPLE_SIGNAL_1, '', 24);
    assert.strictEqual(result.isDupe, false, 'Signal outside cooldown should be allowed');
    testPass('Cooldown abgelaufen: Signal erlaubt');
  } catch (e) { testFail('Cooldown abgelaufen', e); }

  // Test: Cooldown 0 = immer blockieren
  try {
    await db.exec(`DELETE FROM signals`);
    await saveSignal('sig_1', 'channel1', 1, SAMPLE_SIGNAL_1, normalizeSignalXml(SAMPLE_SIGNAL_1));
    const pastTime = Date.now() - 100 * 60 * 60 * 1000;
    await db.run(`UPDATE signals SET created_at = ? WHERE id = ?`, [pastTime, 'sig_1']);
    
    const result = await isDuplicateSignal(SAMPLE_SIGNAL_1, '', 0);
    assert.strictEqual(result.isDupe, true, 'Cooldown 0 should always block duplicates');
    assert.ok(result.reason.includes('permanent'), `Reason should mention permanent cooldown, got: ${result.reason}`);
    testPass('Cooldown 0: Immer blockieren');
  } catch (e) { testFail('Cooldown 0', e); }

  // Cleanup DB connections
  await db.close();
  await closeDb();
  await rm(testDir, { recursive: true, force: true });

  // Summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Tests abgeschlossen: ${passed} bestanden, ${failed} fehlgeschlagen`);
  console.log(`${'='.repeat(50)}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

await runTests().catch(err => {
  console.error('Test-Fehler:', err);
  process.exit(1);
});
