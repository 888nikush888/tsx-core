import { seedTradingFixtures } from '../trading_fixtures.js';
import { createTradingAccount, listTradingStrategies, updateTradingRuntimeState } from '../../src/trading_repository.js';
import { createWorkflowResourceDraft, publishWorkflowResource, saveWorkflowRevision, WORKFLOW_IMPACT_CONFIRMATION } from '../../src/workflow_repository.js';

export async function workflowFixture() {
  await seedTradingFixtures();
  const account = await createTradingAccount({ name: 'Ingress second', exchange: 'paper', mode: 'paper', initialBalance: '10000' });
  const [strategy] = await listTradingStrategies();
  await updateTradingRuntimeState({ executionEnabled: true });
  const resource = async (kind, name, configuration) => {
    const draft = await createWorkflowResourceDraft({ kind, name, configuration });
    return publishWorkflowResource(draft.id);
  };
  const definitions = [
    ['channel', 'channel', { channelId: '-1001' }],
    ['parser', 'parser', { templateName: 'default', prompt: 'PINNED ORIGINAL PROMPT', timeoutMs: 60000 }],
    ['schema', 'schema', { schemaId: 'standard' }],
    ['contract', 'contract', { contractVersionId: 'standard:v1' }],
    ['strategy', 'strategy', { strategyVersionId: strategy.id }],
    ['sizing', 'sizing', { positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '5', maxAdaptiveRiskPercent: '5', maxLeverage: 1 }],
    ['primary', 'account', { accountId: 'paper-default' }],
    ['secondary', 'account', { accountId: account.id }],
    ['xml', 'output', { mode: 'telegram_xml' }],
  ];
  const nodes = [];
  for (const [id, kind, configuration] of definitions) {
    const version = await resource(kind, id, configuration);
    nodes.push({ id, kind, resourceVersionId: version.id, position: { x: 0, y: 0 } });
  }
  const edges = [
    ['channel', 'parser'], ['parser', 'schema'], ['schema', 'contract'], ['contract', 'strategy'],
    ['strategy', 'sizing'], ['sizing', 'primary'], ['sizing', 'secondary'], ['primary', 'xml'], ['secondary', 'xml'],
  ].map(([source, target]) => ({ id: `${source}-${target}`, kind: 'flow', source, target }));
  const graph = { schemaVersion: 3, nodes, edges };
  const first = await saveWorkflowRevision({ baseRevisionId: null, graph, actorId: 'test:ingress', confirmation: WORKFLOW_IMPACT_CONFIRMATION });
  return { first, graph, resource, account, async revise(nextGraph) {
    return saveWorkflowRevision({ baseRevisionId: first.id, graph: nextGraph, actorId: 'test:ingress', confirmation: WORKFLOW_IMPACT_CONFIRMATION });
  } };
}
