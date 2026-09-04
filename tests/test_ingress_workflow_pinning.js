import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, listOutboxTasks, saveSignal, withDatabaseTransaction } from '../src/db.js';
import { acceptIncomingMessage, enqueueWorkflowOutputs, processIncomingWork, pinnedWorkflowParserSelection, persistedParsedSignal } from '../src/incoming_work_repository.js';
import { createWorkflowTradingIntents, getWorkflowSignalPlans, isWorkflowExecutionAuthorized, saveWorkflowRevision, WORKFLOW_IMPACT_CONFIRMATION } from '../src/workflow_repository.js';
import { parseSignalToXml } from '../src/signal_parser.js';
import { workflowFixture } from './fixtures/ingress_workflow_fixture.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-ingress-workflow-'));
const originalKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = 'test-local-only';
try {
  await initDb(path.join(directory, 'test.db'));
  const fixture = await workflowFixture();
  const message = { id: 1, chat_id: -1001, media_group_id: 'album-caption',
    content: { _: 'messagePhoto', caption: { text: 'LONG BTCUSDT entry 90 target 95 stop 85' } } };
  const config = { sourceChannels: ['-1001'], xmlParsing: { enabled: true }, filters: {} };
  const receivedAt = Date.now() - 10000;
  const work = await acceptIncomingMessage(message, config, receivedAt);
  const parser2 = await fixture.resource('parser', 'parser v2', { templateName: 'default', prompt: 'NEW PROMPT MUST NOT BE USED', timeoutMs: 60000 });
  const revisedGraph = structuredClone(fixture.graph);
  revisedGraph.nodes.find(node => node.id === 'parser').resourceVersionId = parser2.id;
  const revised = await fixture.revise(revisedGraph);
  await processIncomingWork();
  const [task] = await listOutboxTasks();
  assert.ok(task, JSON.stringify(await getDatabase().all('SELECT id, status, reason FROM incoming_work')));
  assert.equal(task.workflowRevisionId, fixture.first.id);
  assert.equal(task.type, 'single', 'Workflow album captions must follow the same parser path as text.');
  assert.equal(task.config.durableIngress.receivedAt, receivedAt);
  assert.equal(task.config.durableIngress.workflow.definitionSha256, fixture.first.definitionSha256);
  const [plan] = await getWorkflowSignalPlans({ channelId: '-1001', text: message.content.caption.text, contentType: 'photo', workflowRevisionId: work.workflowRevisionId });
  assert.equal(plan.executionPathIds.length, 2);
  assert.equal(plan.prompt, 'PINNED ORIGINAL PROMPT');
  assert.deepEqual(plan.outputModes, ['telegram_xml']);
  const selection = pinnedWorkflowParserSelection(task.config, plan);
  await getDatabase().run("UPDATE trading_signal_contract_versions SET status = 'archived' WHERE id = 'standard:v1'");
  const parsed = await parseSignalToXml(message.content.caption.text, plan.templateName, { primaryModel: 'test-fake' }, {
    promptTemplate: plan.prompt, executableSchema: selection,
    requestCompletion: async request => {
      assert.match(request.messages[0].content, /PINNED ORIGINAL PROMPT/);
      assert.doesNotMatch(request.messages[0].content, /NEW PROMPT/);
      return { choices: [{ finish_reason: 'stop', message: { content: '<signal><action>LONG</action><pair>BTCUSDT</pair><entry_range><min>90</min><max>90</max></entry_range><targets><target id="1">95</target></targets><stoploss>85</stoploss></signal>' } }], usage: { total_tokens: 12 } };
    }
  });
  await saveSignal('pinned-signal', '-1001', 1, parsed.xml, parsed.xml, { ...parsed.provenance, workflowRevisionId: fixture.first.id });
  assert.equal((await persistedParsedSignal('pinned-signal', plan.templateName, selection, fixture.first.id)).xml, parsed.xml);
  const input = { sourceSignalId: 'pinned-signal', channelId: '-1001', sourceText: message.content.caption.text,
    signal: parsed.signal.execution, workflowRevisionId: fixture.first.id, receivedAt };
  await assert.rejects(createWorkflowTradingIntents({ ...input, workflowRevisionId: undefined }), /Pinned workflow revision is required/);
  assert.equal(await isWorkflowExecutionAuthorized(plan.executionPathIds[0]), true, 'Changing resource versions alone preserves the authorized structural route.');
  const partial = await createWorkflowTradingIntents({ ...input, executionPathIds: [plan.executionPathIds[0]] });
  const all = await createWorkflowTradingIntents({ ...input, executionPathIds: plan.executionPathIds });
  assert.equal(all.length, 2);
  assert.ok(all.some(intent => intent.id === partial[0].id));
  assert.ok(all.every(intent => intent.workflowRevisionId === fixture.first.id && intent.createdAt === receivedAt));
  await saveSignal('pinned-signal', '-1001', 1, parsed.xml, parsed.xml, { ...parsed.provenance, workflowRevisionId: fixture.first.id });
  assert.deepEqual(await createWorkflowTradingIntents({ ...input, executionPathIds: plan.executionPathIds }), all);
  await withDatabaseTransaction(() => enqueueWorkflowOutputs(task.id, message, task.config, parsed.xml, new Set(plan.outputModes)));
  await withDatabaseTransaction(() => enqueueWorkflowOutputs(task.id, message, task.config, parsed.xml, new Set(plan.outputModes)));
  assert.equal((await listOutboxTasks()).length, 2, 'An equivalent Telegram output has exactly one durable child across account paths.');
  await getDatabase().run("UPDATE trading_accounts SET enabled = 0 WHERE id = 'paper-default'");
  await saveSignal('locked-signal', '-1001', 2, parsed.xml, parsed.xml, { ...parsed.provenance, attemptId: 'second-attempt', workflowRevisionId: fixture.first.id });
  const blocked = await createWorkflowTradingIntents({ ...input, sourceSignalId: 'locked-signal', executionPathIds: plan.executionPathIds });
  assert.equal(blocked.find(intent => intent.accountId === 'paper-default').blockReason, 'ACCOUNT_NOT_READY');
  await getDatabase().run("UPDATE trading_accounts SET enabled = 1 WHERE id = 'paper-default'");
  await getDatabase().run("UPDATE trading_signal_contract_versions SET status = 'published' WHERE id = 'standard:v1'");
  const replacementGraph = structuredClone(revisedGraph);
  replacementGraph.nodes.find(node => node.id === 'parser').id = 'replacement-parser';
  for (const edge of replacementGraph.edges) {
    if (edge.source === 'parser') edge.source = 'replacement-parser';
    if (edge.target === 'parser') edge.target = 'replacement-parser';
  }
  const replacement = await saveWorkflowRevision({ baseRevisionId: revised.id, graph: replacementGraph,
    actorId: 'test:revocation', confirmation: WORKFLOW_IMPACT_CONFIRMATION });
  assert.ok(replacement.compiled.paths.some(candidate => candidate.accountId === 'paper-default' && candidate.channelId === '-1001'));
  assert.equal(await isWorkflowExecutionAuthorized(plan.executionPathIds[0]), false, 'A different path to the same channel/account cannot revive a revoked original route.');
  const paper = new PaperExchangeAdapter();
  let submits = 0;
  paper.submitOrder = async () => { submits += 1; throw new Error('Revoked workflow must not submit.'); };
  const engine = new TradingEngine([paper]);
  await engine.processIntent(all[0].id);
  assert.equal(submits, 0);
  assert.equal((await getDatabase().get('SELECT block_reason FROM trading_trade_intents WHERE id = ?', [all[0].id])).block_reason, 'ROUTE_NO_LONGER_AUTHORIZED');
  assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
  console.log('Workflow/resource/time pinning, fanout retry and fresh locks passed.');
} finally {
  await closeDb();
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  await rm(directory, { recursive: true, force: true });
}
