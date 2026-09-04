import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODULE_COVERAGE_PARALLEL_TESTS, MODULE_COVERAGE_SERIAL_BARRIERS,
  moduleCoverageConcurrency, runTestFile, runTestSchedule,
} from '../scripts/test_scheduler.js';
import { runRegisteredTests } from './run_all.js';

const names = ['test_trading_state_transitions.js', 'test_trading_mutation_coordinator.js',
  'test_frontend_bundle.js', 'test_trading_ownership.js'];
// Individually reviewed M43-M46 additions; no prefix grants permission to future tests.
const reviewedFxTests = [
  'test_trading_money_value.js', 'test_trading_money_risk.js',
  'test_trading_recovery_schedule_contract.js', 'test_trading_recovery_schedule_transport.js',
  'test_trading_fx_repository.js', 'test_trading_fx_valuation.js', 'test_trading_fx_fill_accounting.js',
  'test_trading_fx_risk_admission.js', 'test_trading_fx_risk_reservations.js',
  'test_trading_fx_sizing.js', 'test_trading_fx_sizing_python.js', 'test_trading_fx_sizing_admission.js',
  'test_trading_fx_engine.js', 'test_trading_fx_funding.js', 'test_trading_fx_automatic_valuation.js',
  'test_trading_fx_money_reporting.js', 'test_trading_fx_analytics.js', 'test_trading_fx_journal_viewer.js',
  'test_trading_fx_migration.js', 'test_trading_fx_money_migration.js', 'test_trading_adaptive_money_migration.js',
  'test_trading_recovery_schedule.js', 'test_trading_recovery_schedule_commit.js', 'test_trading_recovery_schedule_migration.js',
];
const root = await mkdtemp(path.join(os.tmpdir(), 'tsx-test-scheduler-'));
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function testFourSlotsWithQueuedWork() {
  assert.equal(await runTestSchedule([], { concurrency: 4, runTest: async () => 0 }), 0);
  const selected = [names[0], names[1], names[3], 'test_trading_control_races.js',
    'test_trading_order_repository.js', 'test_trading_order_identity_requests.js', names[2], 'test_trading_core.js'];
  const held = new Map(selected.map(name => [name, deferred()]));
  const starts = [];
  let active = 0, maximum = 0;
  const scheduled = runTestSchedule(selected, { concurrency: 4, runTest: async name => {
    starts.push(name); maximum = Math.max(maximum, ++active);
    const result = await held.get(name).promise;
    active--;
    return result;
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, selected.slice(0, 4), 'Only four eligible children may start before any child completes.');
  for (let index = 0; index < selected.length; index++) {
    held.get(selected[index]).resolve(0);
    await new Promise(resolve => setImmediate(resolve));
    const expectedStarts = index < 5 ? Math.min(6, index + 5) : Math.min(8, index + 2);
    assert.deepEqual(starts, selected.slice(0, expectedStarts), 'The serial barrier waits for all six eligible predecessors.');
  }
  assert.equal(await scheduled, 0);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.deepEqual(starts, selected, 'Queued work and the exclusive barrier execute exactly once.');
}

function testExplicitOptInAndScope() {
  assert.equal(MODULE_COVERAGE_PARALLEL_TESTS.length, 191);
  assert.equal(new Set(MODULE_COVERAGE_PARALLEL_TESTS).size, 191);
  assert.equal(Object.isFrozen(MODULE_COVERAGE_PARALLEL_TESTS), true);
  assert.deepEqual(MODULE_COVERAGE_SERIAL_BARRIERS,
    ['test_web_server.js', 'test_frontend_bundle.js', 'test_frontend_behavior.js', 'test_mcp_server.js']);
  assert.equal(Object.isFrozen(MODULE_COVERAGE_SERIAL_BARRIERS), true);
  for (const file of ['test_trading_future.js', 'test_trading_fx_future.js', ...MODULE_COVERAGE_SERIAL_BARRIERS]) {
    assert.equal(MODULE_COVERAGE_PARALLEL_TESTS.includes(file), false, `${file} has no reviewed parallel permission.`);
  }
  for (const file of ['test_trading_rational.js', 'test_trading_fx_contract.js', 'test_repository_governance.js']) {
    assert.equal(MODULE_COVERAGE_PARALLEL_TESTS.includes(file), true);
  }
  assert.equal(new Set(reviewedFxTests).size, 24);
  for (const file of reviewedFxTests) assert.equal(MODULE_COVERAGE_PARALLEL_TESTS.includes(file), true, file);
  assert.equal(moduleCoverageConcurrency([], {}), 1);
  for (const workers of ['2', '4']) {
    assert.equal(moduleCoverageConcurrency([], { TSX_MODULE_COVERAGE_WORKERS: workers }), Number(workers));
    assert.equal(moduleCoverageConcurrency([names[0]], { TSX_MODULE_COVERAGE_WORKERS: workers }), 1,
      'Focused TDD must remain serial even inside a coverage environment.');
  }
  for (const workers of ['0', '1', '3', '5', '8', '04', '', 4]) {
    assert.throws(() => moduleCoverageConcurrency([], { TSX_MODULE_COVERAGE_WORKERS: workers }), /workers/i);
  }
}

async function testEveryExclusiveBarrier() {
  const predecessors = [names[0], names[1], names[3], 'test_trading_control_races.js'];
  for (const barrier of [...MODULE_COVERAGE_SERIAL_BARRIERS, 'test_trading_future.js', 'test_trading_fx_future.js']) {
    const selected = [...predecessors, barrier, 'test_trading_core.js'];
    const held = new Map(selected.map(name => [name, deferred()]));
    const starts = [];
    let active = 0;
    const scheduled = runTestSchedule(selected, { concurrency: 4, runTest: async name => {
      starts.push(name); active++;
      if (name === barrier) assert.equal(active, 1, `${barrier} must be the only active test.`);
      const result = await held.get(name).promise;
      active--;
      return result;
    } });
    assert.deepEqual(starts, predecessors);
    for (const name of predecessors.slice(0, 3)) held.get(name).resolve(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(starts, predecessors, `${barrier} waits for the last active predecessor.`);
    held.get(predecessors[3]).resolve(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(starts, selected.slice(0, 5), 'No successor can cross a running barrier.');
    held.get(barrier).resolve(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(starts, selected);
    held.get(selected[5]).resolve(0);
    assert.equal(await scheduled, 0);
    assert.equal(active, 0);
  }
}

async function testFourWorkerFailureStopsQueuedWork() {
  const selected = [names[0], names[1], names[3], 'test_trading_control_races.js', 'test_trading_core.js', names[2]];
  for (const rejected of [false, true]) {
    const held = selected.slice(0, 4).map(() => deferred());
    const starts = [], errors = [];
    let settled = false;
    const scheduled = runTestSchedule(selected, { concurrency: 4,
      runTest: name => { starts.push(name); return held[selected.indexOf(name)].promise; },
      error: value => errors.push(value),
    }).then(status => { settled = true; return status; });
    assert.deepEqual(starts, selected.slice(0, 4));
    if (rejected) held[0].reject(new Error('four-worker fixture rejection'));
    else held[0].resolve(7);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'All three active peers must still be observed after the first failure.');
    assert.deepEqual(starts, selected.slice(0, 4), 'No fifth child starts after observing an error or rejection.');
    held[2].resolve(8); held[3].resolve(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'A later failure cannot bypass the remaining active peer.');
    held[1].resolve(0);
    assert.equal(await scheduled, rejected ? 1 : 7, 'The first observed failure remains the terminal status.');
    assert.deepEqual(starts, selected.slice(0, 4));
    assert.equal(errors.length, rejected ? 1 : 0);
  }
  for (const barrier of MODULE_COVERAGE_SERIAL_BARRIERS) {
    const starts = [];
    assert.equal(await runTestSchedule([...selected.slice(0, 4), barrier, selected[4]], {
      concurrency: 4, runTest: async name => { starts.push(name); return name === barrier ? 9 : 0; },
    }), 9);
    assert.deepEqual(starts, [...selected.slice(0, 4), barrier], 'A failed exclusive barrier prevents all successors.');
  }
}

async function testTwoSlotsWithQueuedWork() {
  const selected = [names[0], names[1], names[3], 'test_trading_control_races.js', names[2]];
  const held = new Map(selected.map(name => [name, deferred()]));
  const starts = [];
  let active = 0, maximum = 0;
  const scheduled = runTestSchedule(selected, { concurrency: 2, runTest: async name => {
    starts.push(name); maximum = Math.max(maximum, ++active);
    const result = await held.get(name).promise;
    active--;
    return result;
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, selected.slice(0, 2), 'A third eligible test cannot start without a released slot.');
  for (let index = 0; index < selected.length; index++) {
    held.get(selected[index]).resolve(0);
    await new Promise(resolve => setImmediate(resolve));
    const expectedStarts = index < 2 ? index + 3 : index === 2 ? 4 : 5;
    assert.deepEqual(starts, selected.slice(0, expectedStarts));
  }
  assert.equal(await scheduled, 0);
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.deepEqual(starts, selected, 'Every selected test executes exactly once, including the serial barrier.');
}

async function testDeterministicBarriersAndFailure() {
  const held = new Map(names.map(name => [name, deferred()]));
  const starts = [];
  const schedule = runTestSchedule(names, { concurrency: 2, runTest: name => {
    starts.push(name); return held.get(name).promise;
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, names.slice(0, 2));
  held.get(names[0]).resolve(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, names.slice(0, 2), 'A serial barrier waits for every active predecessor.');
  held.get(names[1]).resolve(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, names.slice(0, 3));
  held.get(names[2]).resolve(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, names);
  held.get(names[3]).resolve(0);
  assert.equal(await schedule, 0);

  const active = deferred(), failure = deferred(), failures = [];
  let settled = false;
  const failed = runTestSchedule([names[0], names[1], names[3], names[2]], {
    concurrency: 2, runTest: name => {
      failures.push(name); return name === names[0] ? failure.promise : active.promise;
    },
  }).then(code => { settled = true; return code; });
  failure.resolve(7);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'Failure must observe the already running sibling through completion.');
  assert.deepEqual(failures, names.slice(0, 2), 'Do not schedule new work after observing a failure.');
  active.resolve(0);
  assert.equal(await failed, 7);
  const errors = [];
  assert.equal(await runTestSchedule([names[0], names[1]], {
    concurrency: 1, runTest: async () => { throw new Error('fixture rejection'); }, error: message => errors.push(message),
  }), 1);
  assert.match(errors[0], /fixture rejection/);
  await assert.rejects(runTestSchedule(names, { concurrency: 3, runTest: async () => 0 }), /concurrency/i);
}

async function createFixture(label, selected = names) {
  const directory = path.join(root, label, 'tests');
  const events = path.join(root, label, 'events');
  const coverage = path.join(root, label, 'coverage');
  await mkdir(directory, { recursive: true });
  await mkdir(events); await mkdir(coverage);
  await writeFile(path.join(path.dirname(directory), 'package.json'), '{"type":"module"}');
  await symlink(path.join(repository, 'node_modules'), path.join(path.dirname(directory), 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of selected) {
    await writeFile(path.join(directory, name), `
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const name = ${JSON.stringify(name)};
const record = phase => writeFileSync(path.join(process.env.FIXTURE_EVENTS, name + '.' + phase), JSON.stringify({
  name, phase, time: Date.now(), pid: process.pid, cwd: process.cwd(),
  coverage: process.env.NODE_V8_COVERAGE, config: process.env.CONFIG_PATH, preserved: process.env.FIXTURE_PRESERVED,
  python: process.env.TSX_TEST_PYTHON,
}));
record('start');
const peers = JSON.parse(process.env.FIXTURE_PEERS ?? '[]');
if (peers.includes(name)) {
  const deadline = Date.now() + 5_000;
  while (!peers.every(peer => existsSync(path.join(process.env.FIXTURE_EVENTS, peer + '.start')))) {
    if (Date.now() >= deadline) throw new Error('An expected worker never entered the parallel fixture.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
await new Promise(resolve => setTimeout(resolve, 25));
record('end');
if (process.env.FIXTURE_FAIL === name) process.exitCode = 7;
`);
  }
  return { directory, events, coverage, environment: { ...process.env, CONFIG_PATH: path.join(root, 'fixture-config.json'),
    NODE_V8_COVERAGE: coverage, FIXTURE_EVENTS: events, FIXTURE_PRESERVED: 'retained', TSX_MODULE_COVERAGE_WORKERS: undefined } };
}

async function fixtureEvents(fixture) {
  const entries = await readdir(fixture.events);
  return Promise.all(entries.map(name => readFile(path.join(fixture.events, name), 'utf8').then(JSON.parse)));
}

function assertChildEvidence(events, fixture, selected) {
  assert.equal(events.length, selected.length * 2);
  assert.deepEqual(events.filter(event => event.phase === 'start').map(event => event.name).sort(), [...selected].sort());
  assert.equal(new Set(events.filter(event => event.phase === 'start').map(event => event.pid)).size, selected.length,
    'Every selected test retains its own process, not an in-process import batch.');
  for (const event of events) {
    assert.equal(event.cwd, path.dirname(fixture.directory));
    assert.equal(event.coverage, fixture.coverage);
    assert.equal(event.config, fixture.environment.CONFIG_PATH);
    assert.equal(event.preserved, 'retained');
    assert.equal(event.python, fixture.environment.TSX_TEST_PYTHON, 'Children retain the explicitly selected isolated Python interpreter.');
  }
}

function assertFixtureTiming(events, selected, peers) {
  const time = (name, phase) => events.find(event => event.name === name && event.phase === phase).time;
  if (peers.length > 1) {
    assert.ok(Math.max(...peers.map(name => time(name, 'start'))) < Math.min(...peers.map(name => time(name, 'end'))),
      'Every opted-in worker must actually overlap the other workers.');
  }
  for (let index = Math.max(1, peers.length); index < selected.length; index++) {
    assert.ok(time(selected[index], 'start') >= Math.max(...selected.slice(0, index).map(name => time(name, 'end'))),
      'Every exclusive barrier, default run and focused run waits for all predecessors.');
  }
}

async function assertChildCoverage(events, fixture) {
  const recorded = (await readdir(fixture.coverage)).filter(file => /^coverage-.*\.json$/.test(file));
  for (const event of events.filter(event => event.phase === 'start')) {
    assert.ok(recorded.some(file => file.startsWith(`coverage-${event.pid}-`)), 'Each completed child contributes V8 coverage.');
  }
}

function fourWorkerFixtureNames() {
  return [names[0], names[1], names[3], 'test_trading_control_races.js',
    ...MODULE_COVERAGE_SERIAL_BARRIERS, 'test_trading_core.js'];
}

async function runActualFixture(label, workers = 1, focused = false, selection) {
  const registeredTests = selection ?? (workers === 4 ? fourWorkerFixtureNames() : names);
  const fixture = await createFixture(label, registeredTests);
  if (workers > 1) fixture.environment.TSX_MODULE_COVERAGE_WORKERS = String(workers);
  const peers = workers > 1 && !focused ? registeredTests.slice(0, workers) : [];
  fixture.environment.FIXTURE_PEERS = JSON.stringify(peers);
  const logs = [], errors = [], selected = focused ? registeredTests.slice(0, workers) : registeredTests;
  const status = await runRegisteredTests(focused ? selected : [], {
    registeredTests, testsDirectory: fixture.directory, environment: fixture.environment,
    log: value => logs.push(value), error: value => errors.push(value),
  });
  assert.equal(status, 0, errors.join('\n'));
  assert.deepEqual(errors, []);
  assert.match(logs.at(-1), new RegExp(`ALL ${selected.length} TEST FILES PASSED`));
  const events = await fixtureEvents(fixture);
  assertChildEvidence(events, fixture, selected);
  assertFixtureTiming(events, selected, peers);
  await assertChildCoverage(events, fixture);
}

async function testActualFourWorkerFailure() {
  const registeredTests = fourWorkerFixtureNames();
  const fixture = await createFixture('four-worker-failure', registeredTests);
  fixture.environment.TSX_MODULE_COVERAGE_WORKERS = '4';
  fixture.environment.FIXTURE_PEERS = JSON.stringify(registeredTests.slice(0, 4));
  fixture.environment.FIXTURE_FAIL = registeredTests[0];
  const logs = [], errors = [];
  assert.equal(await runRegisteredTests([], { registeredTests, testsDirectory: fixture.directory,
    environment: fixture.environment, log: value => logs.push(value), error: value => errors.push(value) }), 7);
  assert.equal(logs.some(value => value.includes('PASSED')), false);
  assert.match(errors[0], /exit code 7/);
  const events = await fixtureEvents(fixture);
  assertChildEvidence(events, fixture, registeredTests.slice(0, 4));
  assertFixtureTiming(events, registeredTests.slice(0, 4), registeredTests.slice(0, 4));
  await assertChildCoverage(events, fixture);
}

async function testActualPreflightAndExit() {
  const fixture = await createFixture('preflight');
  const calls = [], errors = [], logs = [];
  const options = { registeredTests: names, testsDirectory: fixture.directory, environment: fixture.environment,
    runTest: async name => { calls.push(name); return 0; }, log: value => logs.push(value), error: value => errors.push(value) };
  await writeFile(path.join(fixture.directory, 'test_unregistered.js'), '// preflight fixture');
  assert.notEqual(await runRegisteredTests([], options), 0);
  assert.match(errors.pop(), /unregistered/i);
  assert.deepEqual(calls, [], 'Full registry validation happens before any child starts.');
  assert.equal(await runRegisteredTests([names[0], 'test_unknown.js'], options), 2);
  assert.deepEqual(calls, [], 'Validate the entire requested selection before execution.');
  assert.equal(await runRegisteredTests([names[0]], options), 0, 'Focused TDD does not require a finished registry.');
  calls.length = 0;
  await rm(path.join(fixture.directory, 'test_unregistered.js'));
  for (const registeredTests of [[...names, names[0]], [...names, 'test_missing.js'], names.slice(0, 3)]) {
    assert.notEqual(await runRegisteredTests([], { ...options, registeredTests }), 0);
    assert.deepEqual(calls, [], 'Duplicate, missing and unregistered files cannot produce a partial green run.');
  }
  logs.length = 0;
  fixture.environment.FIXTURE_FAIL = names[0];
  assert.equal(await runRegisteredTests(names.slice(0, 2), { ...options, runTest: undefined }), 7);
  assert.equal(logs.some(value => value.includes('PASSED')), false);
  assert.equal((await fixtureEvents(fixture)).some(event => event.name === names[1]), false);
  const cli = spawnSync(process.execPath, [path.join(repository, 'tests/run_all.js'), 'test_does_not_exist.js'], {
    cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /Unknown test file/);
}

async function testProcessFailureContracts() {
  const fixture = await createFixture('process-failures');
  const options = { testsDirectory: fixture.directory, environment: fixture.environment, error: () => {} };
  const terminalCases = [
    { code: 0, signal: 'SIGTERM' }, { code: null, signal: null }, { code: 0, signal: null, killed: true },
    { code: 0, signal: null, failure: new Error('spawn failed') },
  ];
  for (const terminal of terminalCases) {
    assert.equal(await runTestFile(names[0], { ...options, spawnImpl: (executable, args, settings) => {
      assert.equal(executable, process.execPath);
      assert.deepEqual(args, ['--import', 'tsx', path.join(fixture.directory, names[0])]);
      assert.equal(settings.timeout, 120_000);
      assert.equal(settings.shell, false); assert.equal(settings.windowsHide, true); assert.equal(settings.stdio, 'inherit');
      assert.equal(settings.env, fixture.environment);
      const child = new EventEmitter(); child.killed = terminal.killed ?? false;
      queueMicrotask(() => { if (terminal.failure) child.emit('error', terminal.failure); child.emit('close', terminal.code, terminal.signal); });
      return child;
    } }), 1, 'Signal, missing status, spawn error and timeout-caused zero exits are never successful.');
  }
  assert.equal(await runTestFile(names[0], { ...options, spawnImpl: () => { throw new Error('synchronous spawn failure'); } }), 1);
  assert.equal(await runTestFile(names[0], { ...options, spawnImpl: (executable, _args, settings) => {
    assert.equal(settings.timeout, 120_000, 'Only this injected local fixture gets an accelerated timeout.');
    return spawn(executable, ['--input-type=module', '-e', 'setInterval(() => {}, 1000)'], { ...settings, timeout: 50 });
  } }), 1, 'A genuine killed subprocess is a failed test.');
}

try {
  await testFourSlotsWithQueuedWork();
  testExplicitOptInAndScope();
  const registeredSource = await readFile(path.join(repository, 'tests/run_all.js'), 'utf8');
  for (const name of [...MODULE_COVERAGE_PARALLEL_TESTS, ...MODULE_COVERAGE_SERIAL_BARRIERS]) {
    assert.ok(registeredSource.includes(`'${name}'`), `${name} must remain part of the full registry.`);
  }
  const moduleSource = await readFile(path.join(repository, 'scripts/check_module_coverage.js'), 'utf8');
  assert.match(moduleSource, /env: \{ \.\.\.process\.env, TSX_MODULE_COVERAGE_WORKERS: '4' \}/);
  assert.match(moduleSource, /timeout: 300_000/);
  assert.match(moduleSource, /'--config', 'c8\.modules\.json'/);
  await testTwoSlotsWithQueuedWork();
  await testEveryExclusiveBarrier();
  await testFourWorkerFailureStopsQueuedWork();
  await testDeterministicBarriersAndFailure();
  await runActualFixture('default');
  await runActualFixture('parallel-two', 2);
  await runActualFixture('parallel-four', 4);
  await runActualFixture('reviewed-fx-four', 4, false, [
    'test_trading_fx_sizing_python.js', 'test_trading_recovery_schedule_transport.js',
    'test_trading_adaptive_money_migration.js', 'test_trading_money_risk.js',
    ...MODULE_COVERAGE_SERIAL_BARRIERS, 'test_trading_fx_future.js', 'test_trading_fx_repository.js',
  ]);
  await runActualFixture('focused-two', 2, true);
  await runActualFixture('focused-four', 4, true);
  await testActualFourWorkerFailure();
  await testActualPreflightAndExit();
  await testProcessFailureContracts();
  console.log('Test scheduling: explicit two/four-worker scope, process/coverage isolation, all serial barriers, registry preflight and failure contracts passed.');
} finally {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.match(path.basename(root), /^tsx-test-scheduler-/);
  await rm(root, { recursive: true, force: true });
}
