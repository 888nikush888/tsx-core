import { createHash } from 'node:crypto';
import { getAiUsage } from './db.js';
import { maskPII } from './logger.js';
import { getActiveWorkflow } from './workflow_repository.js';
import { getSignalContractVersion, listTradingSignalSchemas, getTradingSignalSchemaForTemplate } from './trading_repository.js';
import { classifyAiError, DEFAULT_AI_LIMITS, loadSignalPromptTemplate, parseSignalToXml, type ParseSignalOptions } from './signal_parser.js';
import { AI_LIMIT_RANGES } from './ui_contracts.js';
import type { ExecutableSignalSchemaSelection } from './signal_schema.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = (value: unknown) => { if (value !== undefined && value !== '' && (typeof value !== 'string' || !/^[\w-]{1,64}$/.test(value))) throw new Error('Invalid parser path identifier.'); return String(value || ''); };

export async function uiParserMetadata(config: any, queue: unknown) {
  const workflow = await getActiveWorkflow(); const usageDay = new Date().toISOString().slice(0, 10);
  return { version: 1, observedAt: Date.now(), usageDay, usage: await getAiUsage(usageDay), queue,
    limits: { ...DEFAULT_AI_LIMITS, ...config.xmlParsing?.aiLimits }, primaryModel: config.xmlParsing?.primaryModel ?? null,
    fallbackModel: config.xmlParsing?.fallbackModel ?? null, externalDataPolicyAccepted: config.xmlParsing?.externalDataPolicyAccepted === true,
    providerConfigured: Boolean(process.env.OPENROUTER_API_KEY?.trim() && process.env.OPENROUTER_API_KEY !== 'your_openrouter_api_key_here'),
    activeRevisionId: workflow?.id ?? null, paths: (workflow?.compiled.paths ?? []).map(item => ({ id: item.id, channelId: item.channelId, accountId: item.accountId, parserResourceVersionId: item.parserResourceVersionId, enabled: item.enabled })),
    scope: 'Parser and validation only. No signals, intents, orders, outbox tasks or files are created. Global persistent AI quotas apply.',
  };
}

function testLimits(xml: any) {
  const limits = { ...DEFAULT_AI_LIMITS, ...xml.aiLimits };
  for (const [key, [minimum, maximum]] of Object.entries(AI_LIMIT_RANGES)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < minimum || limits[key] > maximum) throw new Error(`Invalid configured AI limit: ${key}.`);
  }
  return limits;
}
function testSource(value: unknown, maxInputChars: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxInputChars) throw new Error(`Source text must contain 1–${maxInputChars} characters.`);
  return value;
}
async function selectedTestParser(pathId: string) {
  const workflow = pathId ? await getActiveWorkflow() : null;
  const selected = workflow?.compiled.paths.find(item => item.id === pathId);
  if (pathId && !selected) throw new Error('The selected path is not part of the active revision. Refresh the selection.');
  const resources = selected?.effectiveConfiguration.resources as Record<string, any> | undefined;
  const parser = resources?.parser ?? {};
  const templateName = parser.templateName || 'default';
  const promptTemplate = parser.prompt || (await loadSignalPromptTemplate(templateName)).promptTemplate;
  return { workflow, selected, resources, parser, templateName, promptTemplate };
}
async function selectedTestSchema(context: Awaited<ReturnType<typeof selectedTestParser>>) {
  const { selected, resources, templateName } = context;
  const schema = selected ? (await listTradingSignalSchemas()).find(item => item.id === resources?.schema?.schemaId) : await getTradingSignalSchemaForTemplate(templateName);
  const contractId = selected ? resources?.contract?.contractVersionId : schema?.contractVersionId;
  const contract = contractId ? await getSignalContractVersion(contractId) : null;
  if (selected && (!schema || !contract || contract.status !== 'published')) throw new Error('The selected path requires an available schema and published pinned contract.');
  return { schema, contract };
}
function testExecutableSchema({ schema, contract }: Awaited<ReturnType<typeof selectedTestSchema>>): ExecutableSignalSchemaSelection | null {
  return schema ? { id: schema.id, parserSchema: schema.parserSchema, schemaDefinition: schema.definition,
    contractVersionId: contract?.id ?? null, contractDefinition: contract?.definition ?? null } : null;
}
function testPreviewIdentity(pathId: string, context: Awaited<ReturnType<typeof selectedTestParser>>, model: Awaited<ReturnType<typeof selectedTestSchema>>) {
  return { version: 1, provider: 'OpenRouter', pathId: pathId || null, workflowRevisionId: context.workflow?.id ?? null,
    parserResourceVersionId: context.selected?.parserResourceVersionId ?? null, schemaId: model.schema?.id ?? null, contractVersionId: model.contract?.id ?? null };
}
/** Resolve from server-owned configuration; callers cannot inject models, adapters or quota overrides. */
export async function prepareUiParserTest(config: any, input: { pathId?: unknown; sourceText?: unknown }) {
  const pathId = identifier(input.pathId); const xml = structuredClone(config.xmlParsing ?? {});
  const limits = testLimits(xml); const sourceText = testSource(input.sourceText, limits.maxInputChars);
  const context = await selectedTestParser(pathId); const model = await selectedTestSchema(context);
  const executableSchema = testExecutableSchema(model);
  const { parser, promptTemplate, templateName } = context;
  const models = { primaryModel: parser.primaryModel || xml.primaryModel, fallbackModel: parser.fallbackModel || xml.fallbackModel };
  const timeoutMs = context.selected ? parser.timeoutMs : limits.requestTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new Error('Invalid configured parser test timeout.');
  const preview = { ...testPreviewIdentity(pathId, context, model), models,
    modelOrigins: { primary: parser.primaryModel ? 'workflow parser' : 'global configuration', fallback: parser.fallbackModel ? 'workflow parser' : 'global configuration' },
    limits, totalTimeoutMs: timeoutMs, templateName, promptSha256: hash(promptTemplate), schemaSha256: hash(executableSchema),
    sourceSha256: hash(sourceText), sourceChars: sourceText.length, sourceBytes: Buffer.byteLength(sourceText),
    externalDataPolicyAccepted: xml.externalDataPolicyAccepted === true,
    providerConfigured: providerConfigured(), validatesExecutionContract: Boolean(model.contract),
    scope: 'KI-Aufruf, XML und Grounding; keine Handels-, Versand- oder Dateiaktion. Globale Tagesquoten und Reservierungen gelten auch für Tests.',
  };
  return { preview: { ...preview, previewHash: hash(preview), observedAt: Date.now() }, sourceText, templateName, models, options: { limits, promptTemplate, executableSchema } as ParseSignalOptions, timeoutMs };
}
function providerConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim() && process.env.OPENROUTER_API_KEY !== 'your_openrouter_api_key_here');
}
export async function runUiParserTest(prepared: Awaited<ReturnType<typeof prepareUiParserTest>>, parse = parseSignalToXml) {
  if (!prepared.preview.externalDataPolicyAccepted || !prepared.preview.providerConfigured) throw new Error('External data consent and configured provider are required.');
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), prepared.timeoutMs);
  try {
    const result = await parse(prepared.sourceText, prepared.templateName, prepared.models, { ...prepared.options, signal: controller.signal });
    const redactedXml = maskPII(result.xml);
    const xml = boundedXml(redactedXml);
    return { stages: ['provider-response', 'xml-validation', 'source-grounding'], tradeExecuted: false, deliveryCreated: false,
      preview: prepared.preview, xml, xmlTruncated: xml.length < redactedXml.length,
      provenance: { model: result.provenance.model, parserVersion: result.provenance.parserVersion, promptSha256: result.provenance.promptSha256, attemptId: result.provenance.attemptId },
      usageDay: new Date().toISOString().slice(0, 10), usage: await getAiUsage(new Date().toISOString().slice(0, 10)), completedAt: Date.now() };
  } catch (error) { throw new Error(`Parser test ${classifyAiError(error).code}. Quota reservations may remain charged for an unknown provider outcome; no automatic operator replay.`, { cause: error }); }
  finally { clearTimeout(timeout); }
}

// The durable job budget counts UTF-8 JSON bytes, including escape sequences, not JS characters.
function boundedXml(xml: string): string {
  let low = 0; let high = xml.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(xml.slice(0, middle))) <= 24_000) low = middle;
    else high = middle - 1;
  }
  // Do not return an isolated high surrogate when the boundary splits a Unicode character.
  if (low && /[\uD800-\uDBFF]/.test(xml[low - 1]!)) low--;
  return xml.slice(0, low);
}
