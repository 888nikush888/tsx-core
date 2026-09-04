import { getDatabase, withDatabaseTransaction } from './db.js';
import { compareDecimal } from './trading_decimal.js';
import { fxEvidenceDigest, invalidFx, validateFxLegReceipt, type FxContext, type FxLegReceipt } from './trading_fx_contract.js';
import { deriveFxConversion, type FxConversionEvidence } from './trading_fx_quotes.js';
import type { TradingAccount } from './trading_types.js';

type ReadWindow = { startedAt: number; completedAt: number };
type AccountRow = { exchange: string; mode: string; external_account_id: string; credential_generation: string;
  last_verified_at: number | null; capabilities_json: string | null };
type ReceiptRow = { id: string; account_id: string; account_fingerprint: string; credential_generation: string;
  mode: string; profile_hash: string; receipt_hash: string; leg_id: string; provider_response_at: number;
  acquisition_started_at: number; acquisition_completed_at: number; payload_json: string };
export interface StoredFxConversion { id: string; conversion: FxConversionEvidence }
export type FxAccount = Pick<TradingAccount, 'id' | 'exchange' | 'mode' | 'externalAccountId' | 'credentialGeneration' | 'capabilities'>;
/** Capture data before the first await; caller mutation/accessors cannot change the validated account. */
export function snapshotFxAccount(account: FxAccount): FxAccount {
  if (!account || typeof account !== 'object') invalidFx('ACCOUNT_BINDING_CHANGED');
  const descriptors = Object.getOwnPropertyDescriptors(account);
  const result: Record<string, unknown> = {};
  for (const key of ['id', 'exchange', 'mode', 'externalAccountId', 'credentialGeneration', 'capabilities']) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalidFx('ACCOUNT_BINDING_CHANGED');
    result[key] = structuredClone(descriptor.value);
  }
  return result as FxAccount;
}
function parsedPayload(value: string, byteLimit: number): any {
  if (Buffer.byteLength(value) >= byteLimit || value.includes('\0')) invalidFx('STORED_PAYLOAD_INVALID');
  return JSON.parse(value);
}

function profileContext(account: FxAccount, current: AccountRow): FxContext {
  const caps = current.capabilities_json ? JSON.parse(current.capabilities_json) : null;
  if (caps?.profileVersion !== 1 || caps?.executionCapabilities?.provider_api_version !== 'bybit-v5'
    || typeof caps.executionProfileHash !== 'string' || !/^[a-f0-9]{64}$/.test(caps.executionProfileHash)
    || account.capabilities?.executionProfileHash !== caps.executionProfileHash
    || !Number.isSafeInteger(current.last_verified_at) || Number(current.last_verified_at) <= 0
    || Number(current.last_verified_at) > Date.now() + 1000) invalidFx('ACCOUNT_PROFILE_UNVERIFIED');
  return { mode: current.mode as FxContext['mode'], profileHash: caps.executionProfileHash };
}
/** Authority comes from the verified local account, never from a receipt's own hash. */
export async function requireFxAccountContext(account: FxAccount): Promise<FxContext> {
  account = snapshotFxAccount(account);
  const current = await getDatabase().get<AccountRow>(`SELECT exchange,mode,external_account_id,credential_generation,
    last_verified_at,capabilities_json FROM trading_accounts WHERE id=?`, [account.id]);
  if (!current || current.exchange !== 'bybit' || account.exchange !== current.exchange
    || !['live', 'testnet'].includes(current.mode) || account.mode !== current.mode
    || account.externalAccountId !== current.external_account_id || account.credentialGeneration !== current.credential_generation
    || !/^[a-f0-9]{64}$/.test(current.external_account_id) || !/^[a-f0-9]{64}$/.test(current.credential_generation)) invalidFx('ACCOUNT_BINDING_CHANGED');
  return profileContext(account, current);
}
function binding(account: FxAccount): Record<string, string> {
  return { accountId: account.id, accountFingerprint: account.externalAccountId!, credentialGeneration: account.credentialGeneration! };
}
function receiptId(account: FxAccount, receiptHash: string): string {
  return fxEvidenceDigest('tsx-fx-observation-v1', { ...binding(account), receiptHash });
}
function conversionId(account: FxAccount, evidenceHash: string): string {
  return fxEvidenceDigest('tsx-fx-account-conversion-v1', { ...binding(account), evidenceHash });
}
function assertWindow(receipt: FxLegReceipt, read: ReadWindow): void {
  if (![read.startedAt, read.completedAt].every(Number.isSafeInteger) || read.startedAt < 0
    || read.completedAt < read.startedAt || read.completedAt - read.startedAt > 35000
    || receipt.startedAt < read.startedAt || receipt.completedAt > read.completedAt) invalidFx('READ_WINDOW_MISMATCH');
}
function decodeReceipt(account: FxAccount, row: ReceiptRow, context: FxContext): FxLegReceipt {
  const receipt = validateFxLegReceipt(parsedPayload(row.payload_json, 131072), context);
  if (row.account_id !== account.id || row.account_fingerprint !== account.externalAccountId
    || row.credential_generation !== account.credentialGeneration || row.mode !== context.mode || row.profile_hash !== context.profileHash
    || row.id !== receiptId(account, receipt.receiptHash) || row.receipt_hash !== receipt.receiptHash
    || row.leg_id !== receipt.legId || row.provider_response_at !== receipt.providerResponseAt) invalidFx('STORED_RECEIPT_CHANGED');
  assertWindow(receipt, { startedAt: row.acquisition_started_at, completedAt: row.acquisition_completed_at });
  return receipt;
}
/** Stores only original observations. The caller still owns transport, request and shared-budget validation. */
export async function captureFxReceipts(account: FxAccount, values: unknown[], read: ReadWindow): Promise<void> {
  account = snapshotFxAccount(account);
  await withDatabaseTransaction(async () => {
    const context = await requireFxAccountContext(account);
    if (!Array.isArray(values) || values.length > 3) invalidFx();
    const receipts = values.map(value => validateFxLegReceipt(structuredClone(value), context));
    if (new Set(receipts.map(row => row.legId)).size !== receipts.length) invalidFx();
    for (const receipt of receipts) {
      assertWindow(receipt, read);
      await getDatabase().run(`INSERT INTO trading_fx_receipts (id,account_id,account_fingerprint,credential_generation,
        mode,profile_hash,receipt_hash,leg_id,provider_response_at,acquisition_started_at,acquisition_completed_at,payload_json,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      [receiptId(account, receipt.receiptHash), account.id, account.externalAccountId, account.credentialGeneration,
        context.mode, context.profileHash, receipt.receiptHash, receipt.legId, receipt.providerResponseAt,
        read.startedAt, read.completedAt, JSON.stringify(receipt), Date.now()]);
    }
  });
}
async function asOfReceipts(account: FxAccount, context: FxContext, at: number): Promise<ReceiptRow[]> {
  if (!Number.isSafeInteger(at) || at < 0 || at > Date.now() + 1000) invalidFx();
  const rows = await getDatabase().all<ReceiptRow[]>(`SELECT * FROM trading_fx_receipts WHERE account_id=?
    AND account_fingerprint=? AND credential_generation=? AND mode=? AND profile_hash=?
    AND provider_response_at BETWEEN ? AND ? ORDER BY provider_response_at DESC,id LIMIT 257`,
  [account.id, account.externalAccountId, account.credentialGeneration, context.mode, context.profileHash, Math.max(0, at - 10000), at]);
  if (rows.length > 256) invalidFx('QUOTE_SET_UNBOUNDED');
  return rows;
}
async function assertNoContradictedOriginal(account: FxAccount, context: FxContext, receipt: FxLegReceipt): Promise<void> {
  const peers = await getDatabase().all<ReceiptRow[]>(`SELECT * FROM trading_fx_receipts WHERE account_id=?
    AND account_fingerprint=? AND credential_generation=? AND mode=? AND profile_hash=?
    AND leg_id=? AND provider_response_at=? AND receipt_hash<>? ORDER BY id LIMIT 257`,
  [account.id, account.externalAccountId, account.credentialGeneration, context.mode, context.profileHash,
    receipt.legId, receipt.providerResponseAt, receipt.receiptHash]);
  if (peers.length > 256) invalidFx('QUOTE_SET_UNBOUNDED');
  for (const row of peers) {
    if (compareDecimal(decodeReceipt(account, row, context).value, receipt.value) !== 0) invalidFx('QUOTE_CONFLICT');
  }
}
export async function persistFxConversion(account: FxAccount, baseAsset: string, quoteAsset: string, at: number): Promise<StoredFxConversion> {
  account = snapshotFxAccount(account);
  return withDatabaseTransaction(async () => {
    const context = await requireFxAccountContext(account), rows = await asOfReceipts(account, context, at);
    const conversion = deriveFxConversion(rows.map(row => decodeReceipt(account, row, context)), baseAsset, quoteAsset, at, context);
    const id = conversionId(account, conversion.evidenceHash);
    await getDatabase().run(`INSERT INTO trading_fx_conversions
      (id,account_id,account_fingerprint,credential_generation,evidence_hash,payload_json,recorded_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    [id, account.id, account.externalAccountId, account.credentialGeneration, conversion.evidenceHash, JSON.stringify(conversion), Date.now()]);
    for (const [ordinal, hash] of conversion.receiptHashes.entries()) {
      await getDatabase().run(`INSERT INTO trading_fx_conversion_receipts (account_id,conversion_id,receipt_id,ordinal)
        VALUES (?,?,?,?) ON CONFLICT(conversion_id,ordinal) DO NOTHING`, [account.id, id, receiptId(account, hash), ordinal]);
    }
    return readFxConversion(account, id);
  });
}
/** Recomputes the pinned recipe from retained originals; a self-consistent public hash is not authorization. */
export async function readFxConversion(account: FxAccount, id: string): Promise<StoredFxConversion> {
  account = snapshotFxAccount(account);
  return withDatabaseTransaction(async () => {
    const context = await requireFxAccountContext(account);
    const row = await getDatabase().get<{ payload_json: string; evidence_hash: string }>(`SELECT payload_json,evidence_hash
      FROM trading_fx_conversions WHERE id=? AND account_id=? AND account_fingerprint=? AND credential_generation=?`,
    [id, account.id, account.externalAccountId, account.credentialGeneration]);
    if (!row) return invalidFx('CONVERSION_UNAVAILABLE');
    const proof = parsedPayload(row.payload_json, 16384) as FxConversionEvidence;
    const originals = await getDatabase().all<ReceiptRow[]>(`SELECT r.* FROM trading_fx_conversion_receipts j
      JOIN trading_fx_receipts r ON r.id=j.receipt_id AND r.account_id=j.account_id
      WHERE j.conversion_id=? AND j.account_id=? ORDER BY j.ordinal LIMIT 4`, [id, account.id]);
    if (originals.length < 1 || originals.length > 3) invalidFx('CONVERSION_ORIGINALS_MISSING');
    const receipts = originals.map(item => decodeReceipt(account, item, context));
    for (const receipt of receipts) await assertNoContradictedOriginal(account, context, receipt);
    const conversion = deriveFxConversion(receipts, proof.baseAsset, proof.quoteAsset, proof.at, context);
    if (row.evidence_hash !== conversion.evidenceHash || id !== conversionId(account, conversion.evidenceHash)
      || fxEvidenceDigest('tsx-fx-account-conversion-v1', proof) !== fxEvidenceDigest('tsx-fx-account-conversion-v1', conversion)) invalidFx('CONVERSION_CHANGED');
    return { id, conversion };
  });
}
