import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTdjson } from 'prebuilt-tdlib';
import * as tdl from 'tdl';
import { loadEnv } from '../src/env.js';

const modulePath = fileURLToPath(import.meta.url);

export function parseChatId(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed === 0) throw new Error(`${name} must be a non-zero safe integer chat ID.`);
  return parsed;
}

export function extractMessageText(message) {
  const content = message?.content || {};
  return content.text?.text || content.caption?.text || '';
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

async function withTimeout(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function recentMatches(client, targetChatId, marker, notBeforeSeconds) {
  const history = await withTimeout(client.invoke({
    _: 'getChatHistory',
    chat_id: targetChatId,
    from_message_id: 0,
    offset: 0,
    limit: 100,
    only_local: false
  }), 30_000, 'Target history query');
  return (history.messages || []).filter(message =>
    Number(message.date || 0) >= notBeforeSeconds && extractMessageText(message).includes(marker)
  );
}

async function requiredDedicatedDirectory(variable, productionDirectory) {
  const configured = process.env[variable];
  if (!configured) throw new Error(`${variable} is required and must reference dedicated E2E TDLib state.`);
  const directory = path.resolve(configured);
  if (!(await fs.stat(directory)).isDirectory()) throw new Error(`${variable} must reference an existing directory.`);
  if (directory === path.resolve(productionDirectory)) {
    throw new Error('E2E must use a dedicated Telegram account and separate TDLib state.');
  }
  return directory;
}

async function readConfiguration() {
  const apiId = parseChatId(process.env.TELEGRAM_API_ID, 'TELEGRAM_API_ID');
  const apiHash = process.env.TELEGRAM_API_HASH?.trim();
  if (!/^[a-f0-9]{32}$/i.test(apiHash || '')) throw new Error('TELEGRAM_API_HASH must contain 32 hexadecimal characters.');
  const sourceChatId = parseChatId(process.env.E2E_SOURCE_CHAT_ID, 'E2E_SOURCE_CHAT_ID');
  const targetChatId = parseChatId(process.env.E2E_TARGET_CHAT_ID, 'E2E_TARGET_CHAT_ID');
  if (sourceChatId === targetChatId) throw new Error('E2E source and target chats must be different.');
  const databaseDirectory = await requiredDedicatedDirectory('E2E_TDL_DATABASE_DIR', 'session_data');
  const filesDirectory = await requiredDedicatedDirectory('E2E_TDL_FILES_DIR', 'session_files');
  const fixturePath = path.resolve(process.env.E2E_FIXTURE_PATH || 'tests/fixtures/staging_e2e_message.txt');
  const fixture = await fs.readFile(fixturePath, 'utf8');
  if (!fixture.includes('{correlation_id}') || Buffer.byteLength(fixture) > 16 * 1024) {
    throw new Error('E2E fixture must be at most 16 KiB and contain {correlation_id}.');
  }
  const timeoutMs = boundedInteger(process.env.E2E_TIMEOUT_MS, 5 * 60_000, 30_000, 10 * 60_000, 'E2E_TIMEOUT_MS');
  const settleMs = boundedInteger(process.env.E2E_SETTLE_MS, 15_000, 5_000, 60_000, 'E2E_SETTLE_MS');
  return { apiId, apiHash, sourceChatId, targetChatId, databaseDirectory, filesDirectory, fixture, timeoutMs, settleMs };
}

async function waitForForwardedMessage(client, targetChatId, correlationId, notBeforeSeconds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = await recentMatches(client, targetChatId, correlationId, notBeforeSeconds);
    if (matches.length > 0) return matches;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`Synthetic message ${correlationId} did not reach the target within the E2E timeout.`);
}

async function closeE2eClient(client) {
  if (client && !client.isClosed()) await withTimeout(client.close(), 15_000, 'E2E TDLib close').catch(() => {});
}

async function writeEvidence(configuration, sent, received, correlationId, messageText, startedAt) {
  const completedAt = Date.now();
  const receivedText = extractMessageText(received);
  const evidence = {
    schemaVersion: 1,
    correlationId,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    latencyMs: completedAt - startedAt - configuration.settleMs,
    sourceChatId: String(configuration.sourceChatId),
    targetChatId: String(configuration.targetChatId),
    sourceMessageId: String(sent.id),
    targetMessageId: String(received.id),
    fixtureSha256: createHash('sha256').update(messageText).digest('hex'),
    receivedTextSha256: createHash('sha256').update(receivedText).digest('hex'),
    duplicateCount: 0
  };
  const evidenceDirectory = path.resolve('reports', 'staging');
  await fs.mkdir(evidenceDirectory, { recursive: true });
  const evidencePath = path.join(evidenceDirectory, `e2e-${correlationId}.json`);
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  console.log(`STAGING E2E PASSED correlation_id=${correlationId} latency_ms=${evidence.latencyMs} evidence=${evidencePath}`);
}

async function run() {
  loadEnv();
  const configuration = await readConfiguration();
  const correlationId = `qos-${randomUUID()}`;
  const messageText = configuration.fixture.replaceAll('{correlation_id}', correlationId).trim();
  const startedAt = Date.now();
  const notBeforeSeconds = Math.floor(startedAt / 1000) - 30;
  let client;
  try {
    tdl.configure({ tdjson: getTdjson() });
    client = tdl.createClient({
      apiId: configuration.apiId,
      apiHash: configuration.apiHash,
      databaseDirectory: configuration.databaseDirectory,
      filesDirectory: configuration.filesDirectory,
      skipOldUpdates: true
    });
    await withTimeout(client.login(() => {
      throw new Error('Dedicated E2E TDLib session is not authenticated; interactive login is forbidden in the gate.');
    }), 30_000, 'E2E TDLib login');
    await Promise.all([
      withTimeout(client.invoke({ _: 'getChat', chat_id: configuration.sourceChatId }), 30_000, 'Source chat access check'),
      withTimeout(client.invoke({ _: 'getChat', chat_id: configuration.targetChatId }), 30_000, 'Target chat access check')
    ]);
    const sent = await withTimeout(client.invoke({
      _: 'sendMessage',
      chat_id: configuration.sourceChatId,
      input_message_content: {
        _: 'inputMessageText',
        text: { _: 'formattedText', text: messageText }
      }
    }), 30_000, 'Synthetic source send');

    await waitForForwardedMessage(client, configuration.targetChatId, correlationId, notBeforeSeconds, configuration.timeoutMs);
    await new Promise(resolve => setTimeout(resolve, configuration.settleMs));
    const matches = await recentMatches(client, configuration.targetChatId, correlationId, notBeforeSeconds);
    if (matches.length !== 1) throw new Error(`Synthetic message ${correlationId} appeared ${matches.length} times; expected exactly once.`);
    await writeEvidence(configuration, sent, matches[0], correlationId, messageText, startedAt);
  } finally {
    await closeE2eClient(client);
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(modulePath)) {
  try {
    await run();
  } catch (error) {
    console.error(`STAGING E2E FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
