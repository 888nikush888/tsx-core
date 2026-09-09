import { requireString } from './contract_values.js';
import { withDatabaseTransaction } from './db.js';
import { getWorkflowResourceById, publishWorkflowResource } from './workflow_repository.js';
import { getSignalContractVersion, getTradingStrategyVersion, publishSignalContractVersion, publishTradingStrategyVersion } from './trading_repository.js';
import type { SignalContractVersion, TradingStrategyVersion, WorkflowResourceVersion } from './trading_types.js';
import { reviewHash } from './ui_change_review.js';

type PublicationDependency = SignalContractVersion | TradingStrategyVersion | null;

async function publicationDependency(resource: WorkflowResourceVersion): Promise<PublicationDependency> {
  if (resource.kind === 'strategy') return getTradingStrategyVersion(requireString(resource.configuration.strategyVersionId, 'Workflow strategyVersionId'));
  if (resource.kind === 'contract') return getSignalContractVersion(requireString(resource.configuration.contractVersionId, 'Workflow contractVersionId'));
  return null;
}

function assertPublicationHashMatches(publication: { publicationHash: string }, expectedHash: unknown): void {
  if (typeof expectedHash !== 'string' || publication.publicationHash !== expectedHash) throw new Error('RESOURCE_PUBLICATION_CONFLICT: Resource or referenced model changed.');
}

function assertDependencyAvailable(dependencyRequired: boolean, dependency: PublicationDependency): void {
  if (dependencyRequired && !dependency) throw new Error('Referenced model is unavailable.');
}

async function publishableDependency(dependency: PublicationDependency, dependencyKind: string | null): Promise<PublicationDependency> {
  if (!dependency) return dependency;
  if (dependency.status === 'archived') throw new Error('Archived model cannot be published or reactivated.');
  if (dependency.status !== 'draft') return dependency;
  return dependencyKind === 'strategy'
    ? publishTradingStrategyVersion(dependency.id) : publishSignalContractVersion(dependency.id);
}

export async function uiResourcePublication(id: string) {
  const resource = await getWorkflowResourceById(id); if (!resource) throw new Error('Workflow resource not found.');
  const dependency = await publicationDependency(resource);
  return { dependency, dependencyKind: dependency ? resource.kind : null,
    dependencyRequired: resource.kind === 'strategy' || resource.kind === 'contract',
    publicationHash: reviewHash({ resource, dependency }) };
}

export async function publishUiResourceWithDependency(id: string, baseEditRevision: number, expectedHash: unknown) {
  return withDatabaseTransaction(async () => {
    const publication = await uiResourcePublication(id);
    assertPublicationHashMatches(publication, expectedHash);
    assertDependencyAvailable(publication.dependencyRequired, publication.dependency);
    const dependency = await publishableDependency(publication.dependency, publication.dependencyKind);
    const resource = await publishWorkflowResource(id, Date.now(), baseEditRevision);
    return { resource, dependency };
  });
}
