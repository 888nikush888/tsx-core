import { exportPortableSetupBundle, type PortableSetupBundle } from './setup_bundle.js';
import { getActiveWorkflow, listWorkflowResources } from './workflow_repository.js';
import { listSignalContracts, listTradingStrategies, listTradingSignalSchemas, listTradingAccounts } from './trading_repository.js';
import { listChannelRiskPolicies } from './trading_channel_risk.js';
import { redactReview } from './ui_change_review.js';

const effect = 'Setup wird ersetzt. Vorhandene ungebundene Ressourcen und Modelle werden nach Referenzprüfung archiviert bzw. stillgelegt. Konten werden nur ausdrücklich zugeordnet. Historische Trades bleiben gepinnt. Secrets sind ausgeschlossen.';
export function setupContentReview(current: Awaited<ReturnType<typeof uiSetupCurrentState>>, bundle: PortableSetupBundle) {
  const content = { before: current.content, after: setupReviewContent(bundle), existingLibrary: current.library };
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > 256 * 1024) return { paged: true, effect,
    interpretation: 'Großer Prüfbestand: vollständige Werte werden in begrenzten Abschnitten gelesen. Jede Seite bleibt an dieselbe Vorschau und den unveränderten Ausgangsbestand gebunden.' };
  return { ...redactReview(content), paged: false, effect };
}

export function setupReviewContent(bundle: PortableSetupBundle) {
  return { systemConfig: bundle.systemConfig, workflow: bundle.workflow, models: bundle.models, accountReferences: bundle.accountReferences };
}

/** Includes unbound drafts because replacement can retire them too. No creation clock or secret values enter the preview. */
export async function uiSetupCurrentState(systemConfig: Record<string, unknown>) {
  const active = await getActiveWorkflow();
  return {
    revisionId: active?.id ?? null,
    content: setupReviewContent(await exportPortableSetupBundle(systemConfig)),
    library: { resources: await listWorkflowResources(), contracts: await listSignalContracts(), strategies: await listTradingStrategies(),
      schemas: await listTradingSignalSchemas(), riskPolicies: await listChannelRiskPolicies() },
    accounts: (await listTradingAccounts()).map(account => ({ id: account.id, name: account.name, exchange: account.exchange, mode: account.mode,
      status: account.status, enabled: account.enabled, updatedAt: account.updatedAt })),
  };
}
