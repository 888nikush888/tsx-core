import { createHash, randomUUID } from 'node:crypto';
import { getDatabase } from './db.js';
import { EntryAdmissionRevokedError } from './trading_mutation_coordinator.js';

export interface ProtectionObservation {
  accountId: string; accountVersion: number; epoch: string; requestedAt: number;
  producerId: string; observationId: string;
}
interface LiveObservation {
  token: ProtectionObservation; epoch: () => string; receiptHash: string | null;
}
const databases = new WeakMap<object, Map<string, LiveObservation>>();
export const protectionReceiptHash = (value: string): string => createHash('sha256').update(value).digest('hex');

function observations(): Map<string, LiveObservation> {
  const database = getDatabase();
  let accounts = databases.get(database);
  if (!accounts) { accounts = new Map(); databases.set(database, accounts); }
  return accounts;
}

/** Invalidation metadata, not trading authority. A restored JSON value cannot create a live producer. */
export function createProtectionObserver(currentEpoch: (accountId: string) => string) {
  const producerId = randomUUID();
  return {
    begin(accountId: string, accountVersion: number): ProtectionObservation {
      const token = Object.freeze({ accountId, accountVersion, epoch: currentEpoch(accountId), requestedAt: Date.now(),
        producerId, observationId: randomUUID() });
      observations().set(accountId, { token, epoch: () => currentEpoch(accountId), receiptHash: null });
      return token;
    },
    invalidate(accountId: string): void { observations().delete(accountId); },
    publish(token: ProtectionObservation, receipt: string): void {
      const live = observations().get(token.accountId);
      assertProtectionObservationCurrent(token);
      if (live?.token !== token) throw new Error('PROTECTION_OBSERVATION_CHANGED');
      live.receiptHash = protectionReceiptHash(receipt);
    },
  };
}

export function assertProtectionObservationCurrent(token: ProtectionObservation): void {
  const live = observations().get(token.accountId);
  if (!live || live.token.observationId !== token.observationId || live.token.producerId !== token.producerId) {
    throw new Error('PROTECTION_OBSERVATION_CHANGED');
  }
  if (live.epoch() !== token.epoch) throw new EntryAdmissionRevokedError();
}

export function protectionObservationCurrent(token: ProtectionObservation, receipt?: string): boolean {
  const live = observations().get(token.accountId);
  return live !== undefined && live.token.producerId === token.producerId
    && live.token.observationId === token.observationId && live.epoch() === token.epoch
    && (receipt === undefined || live.receiptHash === protectionReceiptHash(receipt));
}

/** Once a consumer observes invalidation, restoring old local values cannot resurrect the receipt. */
export function retireProtectionReceipt(accountId: string): void {
  const live = observations().get(accountId);
  if (live) live.receiptHash = null;
}
