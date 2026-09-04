import { getDatabase } from './db.js';
import { validateAcquisitionEvidence } from './exchange_contract_validation.js';
import { fillQuantityDigest, validateFillQuantityNormalization } from './trading_fill_quantity_contract.js';
import { provenFillIdentity } from './trading_fill_identity.js';
import { compareDecimal } from './trading_decimal.js';
import type { ExchangeAcquisitionEvidence, ExchangeFill, TradingAccount } from './trading_types.js';

async function assertBinding(account: TradingAccount): Promise<void> {
  const current = await getDatabase().get<{ exchange: string; mode: string; external_account_id: string; credential_generation: string }>(
    'SELECT exchange,mode,external_account_id,credential_generation FROM trading_accounts WHERE id=?', [account.id]);
  if (!current || current.exchange !== 'krakenfutures' || current.exchange !== account.exchange || current.mode !== account.mode
    || current.external_account_id !== account.externalAccountId || current.credential_generation !== account.credentialGeneration
    || !/^[a-f0-9]{64}$/.test(current.external_account_id) || !/^[a-f0-9]{64}$/.test(current.credential_generation)) {
    throw new Error('FILL_QUANTITY_ACCOUNT_BINDING_CHANGED');
  }
}
function readBinding(read: ExchangeAcquisitionEvidence | undefined, normalizedAt: number): ExchangeAcquisitionEvidence {
  if (!read) throw new Error('FILL_QUANTITY_READ_MISSING');
  const clean = validateAcquisitionEvidence(read);
  if (normalizedAt < clean.startedAt || normalizedAt > clean.completedAt) throw new Error('FILL_QUANTITY_READ_WINDOW_MISMATCH');
  return clean;
}
/** In the existing fill transaction only: preserves a calculation, never values a fee or proves historical units. */
export async function captureFillQuantityEvidence(account: TradingAccount, fill: ExchangeFill, fillId: string,
  initial: boolean, read?: ExchangeAcquisitionEvidence): Promise<void> {
  if (fill.quantityNormalization === undefined) return;
  const normalization = validateFillQuantityNormalization(fill.quantityNormalization, fill);
  const acquisition = readBinding(read, normalization.normalizedAt);
  await assertBinding(account);
  const proof = provenFillIdentity(account, fill);
  const stored = await getDatabase().get<{ account_fingerprint: string; remote_fill_key: string; raw_json: string; identity_status: string; quantity: string }>(
    'SELECT account_fingerprint,remote_fill_key,raw_json,identity_status,quantity FROM trading_fills WHERE account_id=? AND id=?', [account.id, fillId]);
  if (!proof || !stored || stored.account_fingerprint !== account.externalAccountId || stored.remote_fill_key !== proof.key
    || stored.identity_status !== 'proven' || compareDecimal(stored.quantity, fill.quantity) !== 0) throw new Error('FILL_QUANTITY_ORIGINAL_BINDING_MISMATCH');
  const originalHash = fillQuantityDigest('kraken-normalization-original-v1', JSON.parse(stored.raw_json));
  if (normalization.originalExecutionHash !== originalHash) throw new Error('FILL_QUANTITY_ORIGINAL_HASH_MISMATCH');
  const providerUid = (fill.raw as { info: { accountUid: string } }).info.accountUid;
  if (acquisition.history?.some(item => item.checkpoint.source === 'fills' && item.checkpoint.providerAccountUid != null
    && item.checkpoint.providerAccountUid !== providerUid)) throw new Error('FILL_QUANTITY_READ_PROVIDER_BINDING_MISMATCH');
  // Re-reading an identical calculation is not a new economic event or an unlimited poll log.
  // A changed actual recipe/generation has its own immutable observation; none replaces the first.
  const { normalizedAt: _time, ...recipe } = normalization;
  const id = fillQuantityDigest('tsx-fill-quantity-observation-v1', { accountId: account.id, fillId,
    accountFingerprint: account.externalAccountId, credentialGeneration: account.credentialGeneration, recipe });
  await getDatabase().run(`INSERT INTO trading_fill_quantity_evidence
    (id,fill_id,account_id,account_fingerprint,credential_generation,remote_fill_key,provider_account_uid,
      original_raw_hash,normalization_json,acquisition_json,observation_kind,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
  [id, fillId, account.id, account.externalAccountId, account.credentialGeneration, proof.key, providerUid, originalHash,
    JSON.stringify(normalization), JSON.stringify(acquisition), initial ? 'initial' : 'later_observation', Date.now()]);
}
