import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TradingExchange } from './trading_types.js';

export type TradingCredentials =
  | { exchange: 'hyperliquid'; privateKey: string; walletAddress: string }
  | { exchange: 'bybit'; apiKey: string; apiSecret: string }
  | { exchange: 'krakenfutures'; apiKey: string; apiSecret: string };

export interface TradingCredentialStatus {
  configured: boolean;
  exchange: Exclude<TradingExchange, 'paper'> | null;
  updatedAt: number | null;
}

interface StoredCredentials {
  version: 1;
  accountId: string;
  exchange: 'hyperliquid' | 'bybit' | 'krakenfutures';
  privateKey?: string;
  walletAddress?: string;
  apiKey?: string;
  apiSecret?: string;
  updatedAt: number;
}

const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const CANDIDATE_ID_PATTERN = /^candidate-[a-f0-9]{32}$/;

function assertAccountId(accountId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error('Invalid trading account identifier.');
  return accountId;
}

function singleLine(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${label} has an invalid format.`);
  }
  return normalized;
}

function storedCredentials(accountId: string, credentials: TradingCredentials, now: number): StoredCredentials {
  if (credentials.exchange === 'hyperliquid') {
    const privateKey = singleLine(credentials.privateKey, 'Hyperliquid private key', 66, 66);
    const walletAddress = singleLine(credentials.walletAddress, 'Hyperliquid wallet address', 42, 42);
    if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) throw new Error('Hyperliquid private key must be a 32-byte 0x-prefixed hex value.');
    if (!/^0x[0-9a-f]{40}$/i.test(walletAddress)) throw new Error('Hyperliquid wallet address must be a 20-byte 0x-prefixed hex value.');
    return { version: 1, accountId, exchange: 'hyperliquid', privateKey, walletAddress, updatedAt: now };
  }
  const exchangeName = credentials.exchange === 'bybit' ? 'Bybit' : 'Kraken Futures';
  const apiKey = singleLine(credentials.apiKey, `${exchangeName} API key`, 8, 256);
  const apiSecret = singleLine(credentials.apiSecret, `${exchangeName} API secret`, 8, 256);
  return { version: 1, accountId, exchange: credentials.exchange, apiKey, apiSecret, updatedAt: now };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } catch (error: any) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle.close();
  }
}

export class TradingCredentialStore {
  private readonly root: string;
  private readonly accountsDirectory: string;

  constructor(secretDirectory: string) {
    this.root = path.resolve(secretDirectory);
    this.accountsDirectory = path.join(this.root, 'trading');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.accountsDirectory, { recursive: true, mode: 0o700 });
    const stats = await fs.lstat(this.accountsDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Trading credential directory must be a real directory.');
    // A process crash may leave a verification-only credential candidate. The
    // process lock guarantees that no live verifier can still own it here.
    let removedCandidate = false;
    for (const entry of await fs.readdir(this.accountsDirectory, { withFileTypes: true })) {
      if (entry.isFile() && CANDIDATE_ID_PATTERN.test(entry.name.replace(/\.json$/, '')) && entry.name.endsWith('.json')) {
        await fs.unlink(path.join(this.accountsDirectory, entry.name));
        removedCandidate = true;
      }
    }
    if (removedCandidate) await syncDirectory(this.accountsDirectory);
    await this.getOrCreateExecutorToken();
  }

  async set(accountId: string, credentials: TradingCredentials, now = Date.now()): Promise<void> {
    const safeAccountId = assertAccountId(accountId);
    const stored = storedCredentials(safeAccountId, credentials, now);
    await this.writeAtomically(this.accountPath(safeAccountId), `${JSON.stringify(stored)}\n`);
  }

  async stageCandidate(credentials: TradingCredentials, now = Date.now()): Promise<string> {
    const candidateId = `candidate-${randomBytes(16).toString('hex')}`;
    await this.set(candidateId, credentials, now);
    return candidateId;
  }

  async promoteCandidate(candidateId: string, accountId: string, now = Date.now()): Promise<void> {
    if (!CANDIDATE_ID_PATTERN.test(candidateId)) throw new Error('Invalid credential candidate identifier.');
    const candidate = await this.read(candidateId);
    const credentials: TradingCredentials = candidate.exchange === 'hyperliquid'
      ? {
          exchange: 'hyperliquid',
          privateKey: candidate.privateKey!,
          walletAddress: candidate.walletAddress!,
        }
      : {
          exchange: candidate.exchange,
          apiKey: candidate.apiKey!,
          apiSecret: candidate.apiSecret!,
        };
    await this.set(accountId, credentials, now);
    await this.remove(candidateId);
  }

  async discardCandidate(candidateId: string): Promise<void> {
    if (!CANDIDATE_ID_PATTERN.test(candidateId)) throw new Error('Invalid credential candidate identifier.');
    await this.remove(candidateId);
  }

  async status(accountId: string): Promise<TradingCredentialStatus> {
    try {
      const stored = await this.read(accountId);
      return { configured: true, exchange: stored.exchange, updatedAt: stored.updatedAt };
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { configured: false, exchange: null, updatedAt: null };
      throw error;
    }
  }

  async remove(accountId: string): Promise<void> {
    await fs.unlink(this.accountPath(assertAccountId(accountId))).catch((error: any) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    await syncDirectory(this.accountsDirectory);
  }

  async clear(): Promise<void> {
    const entries = await fs.readdir(this.accountsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !ACCOUNT_ID_PATTERN.test(entry.name.replace(/\.json$/, '')) || !entry.name.endsWith('.json')) {
        throw new Error(`Factory reset refused unexpected trading credential entry '${entry.name}'.`);
      }
      await fs.unlink(path.join(this.accountsDirectory, entry.name));
    }
    await fs.unlink(this.executorTokenPath()).catch((error: any) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    await syncDirectory(this.accountsDirectory);
    await syncDirectory(this.root);
  }

  async getOrCreateExecutorToken(): Promise<string> {
    try {
      const token = (await fs.readFile(this.executorTokenPath(), 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Exchange executor token is invalid.');
      return token;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      const token = randomBytes(32).toString('hex');
      try {
        await this.writeAtomically(this.executorTokenPath(), `${token}\n`);
        return token;
      } catch (writeError: any) {
        if (writeError?.code !== 'EEXIST') throw writeError;
        return this.getOrCreateExecutorToken();
      }
    }
  }

  private accountPath(accountId: string): string {
    return path.join(this.accountsDirectory, `${accountId}.json`);
  }

  private executorTokenPath(): string {
    return path.join(this.root, 'exchange_executor_token');
  }

  private async read(accountId: string): Promise<StoredCredentials> {
    const filePath = this.accountPath(assertAccountId(accountId));
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 2 || stats.size > 8 * 1024) {
      throw new Error('Trading credential file must be a small regular file.');
    }
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as StoredCredentials;
    if (parsed.version !== 1 || parsed.accountId !== accountId
      || !['hyperliquid', 'bybit', 'krakenfutures'].includes(parsed.exchange)) {
      throw new Error('Trading credential file is invalid.');
    }
    storedCredentials(accountId, parsed.exchange === 'hyperliquid'
      ? { exchange: 'hyperliquid', privateKey: parsed.privateKey!, walletAddress: parsed.walletAddress! }
      : { exchange: parsed.exchange, apiKey: parsed.apiKey!, apiSecret: parsed.apiSecret! }, parsed.updatedAt);
    return parsed;
  }

  private async writeAtomically(destination: string, content: string): Promise<void> {
    const temporary = `${destination}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, destination);
      await syncDirectory(path.dirname(destination));
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export function tradingCredentialStoreFromEnvironment(env: NodeJS.ProcessEnv = process.env): TradingCredentialStore {
  return new TradingCredentialStore(env.MANAGED_SECRET_DIR || path.join(process.cwd(), 'secrets'));
}
