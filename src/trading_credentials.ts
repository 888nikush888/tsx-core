import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tradingExchangeId } from './trading_types.js';

export const TRADING_CREDENTIAL_FIELD_IDS = [
  'apiKey', 'secret', 'uid', 'accountId', 'login', 'password', 'twofa',
  'privateKey', 'walletAddress', 'token',
] as const;
export type TradingCredentialFieldId = typeof TRADING_CREDENTIAL_FIELD_IDS[number];
export type TradingCredentialValues = Partial<Record<TradingCredentialFieldId, string>>;

export type TradingCredentials =
  | { exchange: 'hyperliquid'; privateKey: string; walletAddress: string }
  | { exchange: 'bybit' | 'krakenfutures'; apiKey: string; apiSecret: string }
  | { exchange: string; credentials: TradingCredentialValues };

export interface TradingCredentialStatus {
  configured: boolean;
  exchange: string | null;
  updatedAt: number | null;
}

interface StoredCredentialsV1 {
  version: 1;
  accountId: string;
  exchange: string;
  privateKey?: string;
  walletAddress?: string;
  apiKey?: string;
  apiSecret?: string;
  updatedAt: number;
}

interface StoredCredentialsV2 {
  version: 2;
  accountId: string;
  exchange: string;
  credentials: TradingCredentialValues;
  updatedAt: number;
}

const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const CANDIDATE_ID_PATTERN = /^candidate-[a-f0-9]{32}$/;
const CREDENTIAL_FIELD_IDS = new Set<string>(TRADING_CREDENTIAL_FIELD_IDS);

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

function validateCredentialValues(input: unknown): TradingCredentialValues {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Trading credentials must be an object.');
  }
  const values: TradingCredentialValues = {};
  for (const [field, value] of Object.entries(input)) {
    if (!CREDENTIAL_FIELD_IDS.has(field)) {
      throw new Error(`Trading credentials contain an unsupported credential field '${field}'.`);
    }
    values[field as TradingCredentialFieldId] = singleLine(value, `Trading credential ${field}`, 1, 4096);
  }
  if (Object.keys(values).length === 0) throw new Error('At least one trading credential field is required.');
  return values;
}

function normalizedInput(credentials: TradingCredentials): { exchange: string; credentials: TradingCredentialValues } {
  const exchange = tradingExchangeId(credentials?.exchange);
  if (exchange === 'paper') throw new Error('Paper accounts do not accept exchange credentials.');
  let values: TradingCredentialValues;
  if ('credentials' in credentials) {
    values = validateCredentialValues(credentials.credentials);
  } else if (exchange === 'hyperliquid' && 'privateKey' in credentials) {
    values = {
      privateKey: singleLine(credentials.privateKey, 'Hyperliquid private key', 66, 66),
      walletAddress: singleLine(credentials.walletAddress, 'Hyperliquid wallet address', 42, 42),
    };
  } else if ((exchange === 'bybit' || exchange === 'krakenfutures') && 'apiKey' in credentials) {
    const exchangeName = exchange === 'bybit' ? 'Bybit' : 'Kraken Futures';
    values = {
      apiKey: singleLine(credentials.apiKey, `${exchangeName} API key`, 8, 256),
      secret: singleLine(credentials.apiSecret, `${exchangeName} API secret`, 8, 256),
    };
  } else {
    throw new Error('Trading credentials do not match the selected exchange.');
  }
  if (exchange === 'hyperliquid') {
    const privateKey = singleLine(values.privateKey, 'Hyperliquid private key', 66, 66);
    const walletAddress = singleLine(values.walletAddress, 'Hyperliquid wallet address', 42, 42);
    if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) {
      throw new Error('Hyperliquid private key must be a 32-byte 0x-prefixed hex value.');
    }
    if (!/^0x[0-9a-f]{40}$/i.test(walletAddress)) {
      throw new Error('Hyperliquid wallet address must be a 20-byte 0x-prefixed hex value.');
    }
    if (Object.keys(values).length !== 2) throw new Error('Hyperliquid credentials contain unsupported fields.');
    values = { privateKey, walletAddress };
  } else if (exchange === 'bybit' || exchange === 'krakenfutures') {
    const exchangeName = exchange === 'bybit' ? 'Bybit' : 'Kraken Futures';
    const apiKey = singleLine(values.apiKey, `${exchangeName} API key`, 8, 256);
    const secret = singleLine(values.secret, `${exchangeName} API secret`, 8, 256);
    if (Object.keys(values).length !== 2) throw new Error(`${exchangeName} credentials contain unsupported fields.`);
    values = { apiKey, secret };
  }
  return { exchange, credentials: values };
}

function storedCredentials(
  accountId: string,
  credentials: TradingCredentials,
  now: number,
): StoredCredentialsV2 {
  const normalized = normalizedInput(credentials);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Trading credential timestamp is invalid.');
  return { version: 2, accountId, ...normalized, updatedAt: now };
}

function normalizeStored(accountId: string, value: unknown): {
  stored: StoredCredentialsV2;
  migrated: boolean;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Trading credential file is invalid.');
  }
  const input = value as Record<string, any>;
  if (input.accountId !== accountId || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) {
    throw new Error('Trading credential file is invalid.');
  }
  if (input.version === 1) {
    const legacy = input as StoredCredentialsV1;
    if (!['hyperliquid', 'bybit', 'krakenfutures'].includes(legacy.exchange)) {
      throw new Error('Trading credential file is invalid.');
    }
    const allowed = legacy.exchange === 'hyperliquid'
      ? new Set(['version', 'accountId', 'exchange', 'privateKey', 'walletAddress', 'updatedAt'])
      : new Set(['version', 'accountId', 'exchange', 'apiKey', 'apiSecret', 'updatedAt']);
    if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('Trading credential file is invalid.');
    return {
      stored: storedCredentials(accountId, legacy.exchange === 'hyperliquid'
        ? { exchange: 'hyperliquid', privateKey: legacy.privateKey!, walletAddress: legacy.walletAddress! }
        : { exchange: legacy.exchange as 'bybit' | 'krakenfutures', apiKey: legacy.apiKey!, apiSecret: legacy.apiSecret! }, legacy.updatedAt),
      migrated: true,
    };
  }
  if (input.version !== 2
    || Object.keys(input).some(key => !['version', 'accountId', 'exchange', 'credentials', 'updatedAt'].includes(key))
    || Object.keys(input).length !== 5) {
    throw new Error('Trading credential file is invalid.');
  }
  const normalized = normalizedInput({ exchange: input.exchange, credentials: input.credentials });
  return {
    stored: { version: 2, accountId, ...normalized, updatedAt: input.updatedAt },
    migrated: false,
  };
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
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Trading credential directory must be a real directory.');
    }
    let changed = false;
    const filesToMigrate: string[] = [];
    for (const entry of await fs.readdir(this.accountsDirectory, { withFileTypes: true })) {
      const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
      if (entry.isFile() && CANDIDATE_ID_PATTERN.test(id)) {
        await fs.unlink(path.join(this.accountsDirectory, entry.name));
        changed = true;
      } else if (entry.isFile() && ACCOUNT_ID_PATTERN.test(id)) {
        filesToMigrate.push(id);
      }
    }
    for (const accountId of filesToMigrate) {
      const result = await this.readNormalized(accountId);
      if (result.migrated) {
        await this.writeAtomically(this.accountPath(accountId), `${JSON.stringify(result.stored)}\n`);
        changed = true;
      }
    }
    if (changed) await syncDirectory(this.accountsDirectory);
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
    await this.set(accountId, { exchange: candidate.exchange, credentials: candidate.credentials }, now);
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

  private async read(accountId: string): Promise<StoredCredentialsV2> {
    return (await this.readNormalized(accountId)).stored;
  }

  private async readNormalized(accountId: string): Promise<{
    stored: StoredCredentialsV2;
    migrated: boolean;
  }> {
    const filePath = this.accountPath(assertAccountId(accountId));
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 2 || stats.size > 16 * 1024) {
      throw new Error('Trading credential file must be a small regular file.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      throw new Error('Trading credential file is invalid.');
    }
    return normalizeStored(accountId, parsed);
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
