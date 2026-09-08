import { requireString } from './contract_values.js';
import { withDatabaseTransaction } from './db.js';
import { getWorkflowResourceById, publishWorkflowResource } from './workflow_repository.js';
import { getSignalContractVersion, getTradingStrategyVersion, publishSignalContractVersion, publishTradingStrategyVersion } from './trading_repository.js';
import { reviewHash } from './ui_change_review.js';

export async function uiResourcePublication(id: string) {
  const resource = await getWorkflowResourceById(id); if (!resource) throw new Error('Workflow resource not found.');
  let dependency = null;
  if (resource.kind === 'strategy') dependency = await getTradingStrategyVersion(requireString(resource.configuration.strategyVersionId, 'Workflow strategyVersionId'));
  else if (resource.kind === 'contract') dependency = await getSignalContractVersion(requireString(resource.configuration.contractVersionId, 'Workflow contractVersionId'));
  return { dependency, dependencyKind: dependency ? resource.kind : null,
    dependencyRequired: resource.kind === 'strategy' || resource.kind === 'contract',
    publicationHash: reviewHash({ resource, dependency }) };
}

export async function publishUiResourceWithDependency(id: string, baseEditRevision: number, expectedHash: unknown) {
  return withDatabaseTransaction(async () => {
    const publication = await uiResourcePublication(id);
    if (typeof expectedHash !== 'string' || publication.publicationHash !== expectedHash) throw new Error('RESOURCE_PUBLICATION_CONFLICT: Resource or referenced model changed.');
    if (publication.dependencyRequired && !publication.dependency) throw new Error('Referenced model is unavailable.');
    let dependency = publication.dependency;
    if (dependency?.status === 'archived') throw new Error('Archived model cannot be published or reactivated.');
    if (dependency?.status === 'draft') dependency = publication.dependencyKind === 'strategy'
      ? await publishTradingStrategyVersion(dependency.id) : await publishSignalContractVersion(dependency.id);
    const resource = await publishWorkflowResource(id, Date.now(), baseEditRevision);
    return { resource, dependency };
  });
}
