import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TelegramBotApiClient, TelegramViewerCoreApiClient } from './clients.js';
import { startTelegramViewerHealthServer } from './health_server.js';
import { TelegramViewerService } from './service.js';
import { TelegramViewerStateRepository } from './state_repository.js';

const BOT_TOKEN_PATTERN = /^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{20,128}$/;
const SERVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

async function readRuntimeSecret(directory: string, fileName: string, pattern: RegExp): Promise<string> {
  const root = path.resolve(directory);
  const rootStats = await fs.lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('Viewer secret mount is invalid.');
  const target = path.join(root, fileName);
  const stats = await fs.lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 512) throw new Error('Viewer secret file is invalid.');
  const value = (await fs.readFile(target, 'utf8')).trim();
  if (!pattern.test(value) || /[\0\r\n]/.test(value)) throw new Error('Viewer secret value is invalid.');
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function resilientLoop(operation: () => Promise<void>, interval: () => number, service: TelegramViewerService): Promise<never> {
  for (;;) {
    const startedAt = Date.now();
    try {
      await operation();
      service.recordHealthyPoll();
    } catch (error) {
      service.recordFailure(error);
      const message = error instanceof Error ? error.message : 'Viewer cycle failed.';
      console.error(`[TELEGRAM VIEWER] ${message.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]')}`);
    }
    await delay(Math.max(250, interval() - (Date.now() - startedAt)));
  }
}

export async function runTelegramViewer(): Promise<void> {
  const secretDirectory = process.env.TELEGRAM_VIEWER_SECRET_DIR || '/run/secrets/telegram-viewer';
  const serviceToken = () => readRuntimeSecret(secretDirectory, 'viewer_service_token', SERVICE_TOKEN_PATTERN);
  const botToken = () => readRuntimeSecret(secretDirectory, 'bot_token', BOT_TOKEN_PATTERN);
  const state = new TelegramViewerStateRepository(process.env.TELEGRAM_VIEWER_STATE_DB || '/app/state/viewer_state.db');
  await state.initialize();
  const core = new TelegramViewerCoreApiClient(process.env.TELEGRAM_VIEWER_CORE_URL || 'http://forwarder:3000', serviceToken);
  const bot = new TelegramBotApiClient(botToken, process.env.TELEGRAM_BOT_API_BASE || 'https://api.telegram.org/bot');
  const service = new TelegramViewerService({ core, bot, state });
  await service.refreshSettings();
  startTelegramViewerHealthServer({
    port: Number(process.env.TELEGRAM_VIEWER_HEALTH_PORT || 8081),
    serviceToken,
    status: () => service.status(),
  });

  const configuredInterval = () => service.pollingInterval();
  await Promise.all([
    resilientLoop(() => service.refreshSettings().then(() => undefined), () => 30_000, service),
    resilientLoop(() => service.pollTelegramOnce(), configuredInterval, service),
    resilientLoop(async () => {
      await service.pollEventsOnce();
      await service.pollTestEventsOnce();
      await service.deliverPendingOnce();
    }, configuredInterval, service),
  ]);
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  runTelegramViewer().catch(error => {
    const message = error instanceof Error ? error.message : 'Telegram viewer startup failed.';
    console.error(`[TELEGRAM VIEWER] ${message.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]')}`);
    process.exitCode = 1;
  });
}
