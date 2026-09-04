import { randomUUID } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import type { TradingEngine } from './trading_engine.js';
import type { TradingMutationContext } from './trading_mutation_coordinator.js';
import { getTradingAccount, getTradingRuntimeState, updateTradingRuntimeState } from './trading_repository.js';
import { collectAccountReleaseEvidence, type ReleaseEvidenceRequest } from './trading_safety_repository.js';
import { assertTradingSafety, evaluateTradingSafety } from './trading_safety_proof.js';
import type { TradingAccount, TradingAccountSnapshot } from './trading_types.js';
import { tradingAccountTargetIds as releaseAccountIds } from './trading_account_targets.js';

export const GLOBAL_KILL_RELEASE_CONFIRMATION = 'RELEASE GLOBAL KILL SWITCH';

interface RuntimeReleaseDependencies {
  engine: TradingEngine;
  accountSnapshot: (account: TradingAccount) => Promise<TradingAccountSnapshot>;
  assertAuthority: () => void;
}
interface AccountOwner { context: TradingMutationContext; epoch: string }
interface PreparedAccount { owner: AccountOwner; evidence: ReleaseEvidenceRequest }

async function requiredAccount(accountId: string): Promise<TradingAccount> {
  const account = await getTradingAccount(accountId);
  if (!account) throw new Error('ACCOUNT_SCOPE_CHANGED: A release account disappeared or was retired.');
  return account;
}

async function assertAccountScope(expected: string[]): Promise<void> {
  if (JSON.stringify(await releaseAccountIds()) !== JSON.stringify(expected)) {
    throw new Error('ACCOUNT_SCOPE_CHANGED: Trading accounts changed during global release.');
  }
}

/** Canonical lock order; no account holder requests the outer @runtime lock. */
async function withAccountOwners<T>(
  dependencies: RuntimeReleaseDependencies, ids: string[], epochs: Map<string, string>,
  operation: (owners: Map<string, AccountOwner>) => Promise<T>,
  owners = new Map<string, AccountOwner>(), index = 0,
): Promise<T> {
  if (index === ids.length) return operation(owners);
  const accountId = ids[index]!;
  return dependencies.engine.mutations.run(accountId, async context => {
    const epoch = epochs.get(accountId)!;
    dependencies.engine.mutations.assertEpoch(context, epoch);
    owners.set(accountId, { context, epoch });
    return withAccountOwners(dependencies, ids, epochs, operation, owners, index + 1);
  });
}

async function prepareAccount(
  dependencies: RuntimeReleaseDependencies, accountId: string, owner: AccountOwner, requestedAt: number,
): Promise<PreparedAccount> {
  const verificationAccount = await requiredAccount(accountId);
  if (!verificationAccount.enabled || verificationAccount.status !== 'ready' || verificationAccount.lastVerifiedAt === null) {
    throw new Error(`ACCOUNT_NOT_VERIFIED_READY: ${accountId} requires verification before global release.`);
  }
  const options = { force: true, mutation: owner.context };
  await dependencies.engine.reconcileAccount(accountId, options);
  const balanceStartedAt = Date.now();
  const balance = await dependencies.accountSnapshot(verificationAccount);
  const balanceCompletedAt = Date.now();
  const reconciled = await dependencies.engine.reconcileAccount(accountId, options);
  if (!reconciled) throw new Error('ACQUISITION_MISSING: Forced reconciliation returned no release evidence.');
  return { owner, evidence: { verificationAccount, current: verificationAccount, reconciled, epoch: owner.epoch,
    requestedAt, balance, balanceStartedAt, balanceCompletedAt } };
}

function assertOwners(dependencies: RuntimeReleaseDependencies, prepared: PreparedAccount[]): void {
  dependencies.assertAuthority();
  for (const { owner } of prepared) dependencies.engine.mutations.assertEpoch(owner.context, owner.epoch);
}

async function proveAccounts(dependencies: RuntimeReleaseDependencies, prepared: PreparedAccount[]) {
  assertOwners(dependencies, prepared);
  const proofs = [];
  for (const input of prepared) {
    const current = await requiredAccount(input.owner.context.accountId);
    const evidence = await collectAccountReleaseEvidence({ ...input.evidence, current });
    const proof = evaluateTradingSafety(evidence, 'accountRelease');
    assertTradingSafety(proof);
    proofs.push(proof);
  }
  assertOwners(dependencies, prepared);
  return proofs;
}

async function commitGlobalRelease(dependencies: RuntimeReleaseDependencies, ids: string[], prepared: PreparedAccount[]) {
  return withDatabaseTransaction(async () => {
    await assertAccountScope(ids);
    if (!(await getTradingRuntimeState()).killSwitchActive) throw new Error('Global kill switch is no longer active.');
    const safetyProofs = await proveAccounts(dependencies, prepared);
    const state = await updateTradingRuntimeState({ executionEnabled: false, killSwitchActive: false, killSwitchReason: null });
    await getDatabase().run(`INSERT INTO trading_risk_events (id, severity, code, details_json, created_at)
      VALUES (?, 'info', 'GLOBAL_KILL_SWITCH_RELEASE_PROVED', ?, ?)`,
    [randomUUID(), JSON.stringify({ accountIds: ids, safetyProofs }), Date.now()]);
    // Re-read local evidence and freshness after the write; any conflict rolls back the release and its audit together.
    await proveAccounts(dependencies, prepared);
    await assertAccountScope(ids);
    assertOwners(dependencies, prepared);
    return { ...state, safetyProofs };
  });
}

/** Only called under the runtime coordinator; network reads finish before the short write transaction. */
export async function releaseGlobalTradingKillSwitch(dependencies: RuntimeReleaseDependencies) {
  dependencies.assertAuthority();
  if (!(await getTradingRuntimeState()).killSwitchActive) throw new Error('Global kill switch is not active.');
  const ids = await releaseAccountIds();
  if (ids.length === 0) throw new Error('No enabled, verified trading account is available.');
  const requestedAt = Date.now();
  const epochs = new Map(ids.map(id => [id, dependencies.engine.mutations.entryEpoch(id)]));
  return withAccountOwners(dependencies, ids, epochs, async owners => {
    const prepared: PreparedAccount[] = [];
    for (const accountId of ids) {
      prepared.push(await prepareAccount(dependencies, accountId, owners.get(accountId)!, requestedAt));
      assertOwners(dependencies, prepared);
    }
    return commitGlobalRelease(dependencies, ids, prepared);
  });
}
