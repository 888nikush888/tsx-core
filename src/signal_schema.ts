import type { ExecutableSignal } from './trading_types.js';

export type SignalSchemaName = 'standard' | 'cryptodanielvip' | 'loma' | 'speculantca';

interface XmlNode {
  name: string;
  id?: number;
  text: string;
  children: XmlNode[];
}

export interface ValidatedSignal {
  xml: string;
  schema: SignalSchemaName;
  action: 'LONG' | 'SHORT';
  pair: string;
  groundingNumbers: string[];
  groundingComment?: string;
  execution?: ExecutableSignal;
}

export class SignalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalValidationError';
  }
}

function tokenizeXml(xml: string): { source: string; tokens: string[] } {
  if (typeof xml !== 'string' || xml.length === 0 || xml.length > 64 * 1024) {
    throw new SignalValidationError('Signal XML must be a non-empty string no larger than 64 KiB.');
  }
  const source = xml.trim();
  if (!source.startsWith('<signal>') || !source.endsWith('</signal>')) {
    throw new SignalValidationError("Root tag must be 'signal' and properly closed.");
  }
  if (/<!|<\?|\/>/.test(source)) {
    throw new SignalValidationError('XML declarations, comments, entities, DTDs, and self-closing tags are forbidden.');
  }

  const tokens = source.match(/<[^>]*>|[^<]+/g) || [];
  if (tokens.join('') !== source) throw new SignalValidationError('Malformed XML token sequence.');
  return { source, tokens };
}

function appendTextToken(token: string, stack: XmlNode[]): void {
  if (stack.length === 0) {
    if (token.trim()) {
      throw new SignalValidationError('Text outside the signal root is forbidden.');
    }
    return;
  }
  if (/[<>]/.test(token)) {
    throw new SignalValidationError('Unescaped angle brackets are forbidden in XML text.');
  }
  stack[stack.length - 1]!.text += token;
}

function createXmlNode(token: string): XmlNode {
  const opening = token.match(/^<([a-z_]+)(?: id="([1-9]\d*)")?>$/);
  if (!opening) throw new SignalValidationError(`Malformed or disallowed XML tag '${token}'.`);
  const node: XmlNode = {
    name: opening[1]!,
    id: opening[2] ? Number(opening[2]) : undefined,
    text: '',
    children: [],
  };
  if (node.id !== undefined && node.name !== 'target') {
    throw new SignalValidationError(`Attribute 'id' is not allowed on '${node.name}'.`);
  }
  return node;
}

function consumeTagToken(token: string, stack: XmlNode[], root: XmlNode | null): XmlNode | null {
  const closing = token.match(/^<\/([a-z_]+)>$/);
  if (closing) {
    const node = stack.pop();
    if (!node || node.name !== closing[1]) {
      throw new SignalValidationError(`Mismatched closing tag '${closing[1]}'.`);
    }
    return root;
  }
  const node = createXmlNode(token);
  if (stack.length > 0) stack[stack.length - 1]!.children.push(node);
  else if (root) throw new SignalValidationError('Multiple XML root elements are forbidden.');
  else root = node;
  stack.push(node);
  return root;
}

function parseXml(xml: string): XmlNode {
  const { tokens } = tokenizeXml(xml);
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      appendTextToken(token, stack);
      continue;
    }
    root = consumeTagToken(token, stack, root);
  }
  if (stack.length > 0) {
    throw new SignalValidationError(`Unclosed XML tag '${stack[stack.length - 1]!.name}'.`);
  }
  if (!root || root.name !== 'signal') {
    throw new SignalValidationError("Root tag must be 'signal' and properly closed.");
  }
  return root;
}

function assertAllowedChildren(node: XmlNode, allowed: string[]): void {
  if (node.text.trim()) throw new SignalValidationError(`Mixed text is not allowed inside '${node.name}'.`);
  const allowedSet = new Set(allowed);
  for (const child of node.children) {
    if (!allowedSet.has(child.name)) throw new SignalValidationError(`Unknown tag '${child.name}' in '${node.name}'.`);
  }
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter(child => child.name === name);
}

function required(node: XmlNode, name: string): XmlNode {
  const matches = children(node, name);
  if (matches.length !== 1) throw new SignalValidationError(`Required tag '${name}' must appear exactly once.`);
  return matches[0]!;
}

function optional(node: XmlNode, name: string): XmlNode | undefined {
  const matches = children(node, name);
  if (matches.length > 1) throw new SignalValidationError(`Optional tag '${name}' may appear at most once.`);
  return matches[0];
}

function leaf(node: XmlNode): string {
  if (node.children.length > 0) throw new SignalValidationError(`Tag '${node.name}' must contain text only.`);
  const value = node.text.trim();
  if (!value) throw new SignalValidationError(`Tag '${node.name}' must not be empty.`);
  if (/[<>&]/.test(value)) throw new SignalValidationError(`Tag '${node.name}' contains forbidden markup characters.`);
  return value;
}

function actionValue(node: XmlNode): 'LONG' | 'SHORT' {
  const action = leaf(required(node, 'action'));
  if (action !== 'LONG' && action !== 'SHORT') {
    throw new SignalValidationError(`Action must be 'LONG' or 'SHORT', got '${action}'.`);
  }
  return action;
}

function pairValue(node: XmlNode, requireQuoteAsset: boolean): string {
  const pair = leaf(required(node, 'pair'));
  const genericPair = /^[A-Z0-9]{2,20}$/.test(pair) && /[A-Z]/.test(pair);
  const quotedPair = /^(?=.{5,20}$)[A-Z0-9]+(?:USDT|USDC|USD|BTC|ETH|EUR)$/.test(pair);
  if (!(requireQuoteAsset ? quotedPair : genericPair)) {
    throw new SignalValidationError(`Pair '${pair}' is not a normalized uppercase trading symbol.`);
  }
  return pair;
}

function decimal(node: XmlNode, label = node.name): string {
  const value = leaf(node);
  if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(value)) {
    throw new SignalValidationError(`${label} must be a positive plain decimal without suffixes, got '${value}'.`);
  }
  if (compareDecimals(value, '0') <= 0) throw new SignalValidationError(`${label} must be greater than zero.`);
  return value;
}

function compareDecimals(left: string, right: string): number {
  const [leftInteger, leftFraction = ''] = left.split('.');
  const [rightInteger, rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftValue = BigInt(leftInteger + leftFraction.padEnd(scale, '0'));
  const rightValue = BigInt(rightInteger + rightFraction.padEnd(scale, '0'));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function range(node: XmlNode): { min: string; max: string } {
  assertAllowedChildren(node, ['min', 'max']);
  const min = decimal(required(node, 'min'), `${node.name}.min`);
  const max = decimal(required(node, 'max'), `${node.name}.max`);
  if (compareDecimals(min, max) > 0) throw new SignalValidationError(`${node.name}.min must be less than or equal to max.`);
  return { min, max };
}

function scalarTargets(node: XmlNode): string[] {
  assertAllowedChildren(node, ['target']);
  const targetNodes = children(node, 'target');
  if (targetNodes.length < 1 || targetNodes.length > 20) {
    throw new SignalValidationError('Targets must contain between 1 and 20 target elements.');
  }
  return targetNodes.map((target, index) => {
    if (target.id !== index + 1) throw new SignalValidationError('Target ids must be sequential and start at 1.');
    return decimal(target, `target ${index + 1}`);
  });
}

function assertScalarGeometry(
  action: 'LONG' | 'SHORT',
  stoploss: string,
  targets: string[],
  entry?: { min: string; max: string }
): void {
  if (entry) {
    if (action === 'LONG' && compareDecimals(stoploss, entry.min) >= 0) {
      throw new SignalValidationError('LONG stoploss must be below the entry range.');
    }
    if (action === 'SHORT' && compareDecimals(stoploss, entry.max) <= 0) {
      throw new SignalValidationError('SHORT stoploss must be above the entry range.');
    }
  }

  targets.forEach((target, index) => {
    const baseline = entry ? (action === 'LONG' ? entry.max : entry.min) : stoploss;
    if (action === 'LONG' && compareDecimals(target, baseline) <= 0) {
      throw new SignalValidationError(`LONG target ${index + 1} must be above ${entry ? 'the entry range' : 'stoploss'}.`);
    }
    if (action === 'SHORT' && compareDecimals(target, baseline) >= 0) {
      throw new SignalValidationError(`SHORT target ${index + 1} must be below ${entry ? 'the entry range' : 'stoploss'}.`);
    }
    if (index > 0) {
      const order = compareDecimals(targets[index - 1]!, target);
      if ((action === 'LONG' && order >= 0) || (action === 'SHORT' && order <= 0)) {
        throw new SignalValidationError(`${action} targets must be strictly ordered away from entry.`);
      }
    }
  });
}

function scalarExecution(input: {
  schema: 'standard' | 'cryptodanielvip';
  action: 'LONG' | 'SHORT';
  pair: string;
  entry?: { min: string; max: string };
  targets: string[];
  stoploss: string;
  leverage?: string;
  averaging?: string;
  risk?: string;
}): ExecutableSignal {
  return {
    schema: input.schema,
    action: input.action,
    symbol: input.pair,
    entry: input.entry ? { type: 'range', ...input.entry } : { type: 'market' },
    targets: input.targets.map(target => ({ min: target, max: target })),
    stopLoss: input.stoploss,
    suggestedLeverage: input.leverage ? Number(input.leverage) : undefined,
    averagingPrice: input.averaging,
    suggestedRiskPercent: input.risk,
  };
}

function validateStandard(root: XmlNode): Omit<ValidatedSignal, 'xml' | 'schema'> {
  assertAllowedChildren(root, ['action', 'pair', 'entry_range', 'targets', 'stoploss', 'leverage']);
  const action = actionValue(root);
  const pair = pairValue(root, true);
  const entryNode = optional(root, 'entry_range');
  const entry = entryNode ? range(entryNode) : undefined;
  const targets = scalarTargets(required(root, 'targets'));
  const stoploss = decimal(required(root, 'stoploss'));
  const leverageNode = optional(root, 'leverage');
  let leverage: string | undefined;
  if (leverageNode) {
    leverage = leaf(leverageNode);
    if (!/^[1-9]\d{0,2}$/.test(leverage) || Number(leverage) > 125) {
      throw new SignalValidationError('Leverage must be an integer between 1 and 125.');
    }
  }
  assertScalarGeometry(action, stoploss, targets, entry);
  return {
    action,
    pair,
    execution: scalarExecution({ schema: 'standard', action, pair, entry, targets, stoploss, leverage }),
    groundingNumbers: [...(entry ? [entry.min, entry.max] : []), ...targets, stoploss, ...(leverage ? [leverage] : [])]
  };
}

function validateCryptoDaniel(root: XmlNode): Omit<ValidatedSignal, 'xml' | 'schema'> {
  assertAllowedChildren(root, ['action', 'pair', 'entry_type', 'entry_range', 'averaging', 'targets', 'stoploss', 'risk_percent']);
  const action = actionValue(root);
  const pair = pairValue(root, true);
  const entryType = leaf(required(root, 'entry_type'));
  if (entryType !== 'MARKET' && entryType !== 'LIMIT') throw new SignalValidationError("entry_type must be 'MARKET' or 'LIMIT'.");
  const entryNode = optional(root, 'entry_range');
  if (entryType === 'LIMIT' && !entryNode) throw new SignalValidationError('LIMIT signals require entry_range.');
  if (entryType === 'MARKET' && entryNode) throw new SignalValidationError('MARKET signals must omit entry_range.');
  const entry = entryNode ? range(entryNode) : undefined;
  const averagingNode = optional(root, 'averaging');
  const averaging = averagingNode ? decimal(averagingNode) : undefined;
  const targets = scalarTargets(required(root, 'targets'));
  const stoploss = decimal(required(root, 'stoploss'));
  const riskNode = optional(root, 'risk_percent');
  let risk: string | undefined;
  if (riskNode) {
    risk = decimal(riskNode, 'risk_percent');
    if (compareDecimals(risk, '100') > 0) throw new SignalValidationError('risk_percent must not exceed 100.');
  }
  assertScalarGeometry(action, stoploss, targets, entry);
  return {
    action,
    pair,
    execution: scalarExecution({ schema: 'cryptodanielvip', action, pair, entry, targets, stoploss, averaging, risk }),
    groundingNumbers: [
      ...(entry ? [entry.min, entry.max] : []),
      ...(averaging ? [averaging] : []),
      ...targets,
      stoploss,
      ...(risk ? [risk] : [])
    ]
  };
}

function validateLoma(root: XmlNode): Omit<ValidatedSignal, 'xml' | 'schema'> {
  assertAllowedChildren(root, ['pair', 'timeframe', 'action', 'entry_range', 'stoploss', 'targets']);
  const action = actionValue(root);
  const pair = pairValue(root, true);
  const timeframe = leaf(required(root, 'timeframe'));
  if (!/^(?:M|H|D|W)\d{1,3}(?:\/(?:M|H|D|W)\d{1,3})*$/.test(timeframe)) {
    throw new SignalValidationError(`Invalid timeframe '${timeframe}'.`);
  }
  const entry = range(required(root, 'entry_range'));
  const stoploss = decimal(required(root, 'stoploss'));
  const targetsNode = required(root, 'targets');
  assertAllowedChildren(targetsNode, ['target']);
  const targetNodes = children(targetsNode, 'target');
  if (targetNodes.length < 1 || targetNodes.length > 20) throw new SignalValidationError('Targets must contain between 1 and 20 target elements.');
  const targets = targetNodes.map((target, index) => {
    if (target.id !== index + 1) throw new SignalValidationError('Target ids must be sequential and start at 1.');
    return range(target);
  });
  if (action === 'LONG' && compareDecimals(stoploss, entry.min) >= 0) throw new SignalValidationError('LONG stoploss must be below the entry range.');
  if (action === 'SHORT' && compareDecimals(stoploss, entry.max) <= 0) throw new SignalValidationError('SHORT stoploss must be above the entry range.');
  targets.forEach((target, index) => {
    if (action === 'LONG' && compareDecimals(target.min, entry.max) <= 0) throw new SignalValidationError(`LONG target ${index + 1} must be above entry.`);
    if (action === 'SHORT' && compareDecimals(target.max, entry.min) >= 0) throw new SignalValidationError(`SHORT target ${index + 1} must be below entry.`);
    if (index > 0) {
      const previous = targets[index - 1]!;
      if (action === 'LONG' && compareDecimals(target.min, previous.max) <= 0) throw new SignalValidationError('LONG target ranges must be strictly increasing.');
      if (action === 'SHORT' && compareDecimals(target.max, previous.min) >= 0) throw new SignalValidationError('SHORT target ranges must be strictly decreasing.');
    }
  });
  return {
    action,
    pair,
    execution: {
      schema: 'loma',
      action,
      symbol: pair,
      entry: { type: 'range', ...entry },
      targets,
      stopLoss: stoploss,
    },
    groundingNumbers: [
      entry.min,
      entry.max,
      stoploss,
      ...targets.flatMap(target => [target.min, target.max])
    ]
  };
}

function validateSpeculant(root: XmlNode): Omit<ValidatedSignal, 'xml' | 'schema'> {
  assertAllowedChildren(root, ['type', 'action', 'pair', 'conviction', 'timeframe', 'comment', 'risk_warning']);
  if (leaf(required(root, 'type')) !== 'MANIPULATION') throw new SignalValidationError("type must be 'MANIPULATION'.");
  const action = actionValue(root);
  const pair = pairValue(root, false);
  const conviction = leaf(required(root, 'conviction'));
  if (!['HIGH', 'MEDIUM', 'LOW'].includes(conviction)) throw new SignalValidationError('conviction must be HIGH, MEDIUM, or LOW.');
  const timeframe = leaf(required(root, 'timeframe'));
  if (!['SHORT_TERM', 'MID_TERM'].includes(timeframe)) throw new SignalValidationError('timeframe must be SHORT_TERM or MID_TERM.');
  const comment = leaf(required(root, 'comment'));
  if (comment.length > 500) throw new SignalValidationError('comment must not exceed 500 characters.');
  const riskWarning = leaf(required(root, 'risk_warning'));
  if (riskWarning !== 'true' && riskWarning !== 'false') throw new SignalValidationError('risk_warning must be true or false.');
  return { action, pair, groundingNumbers: [], groundingComment: comment };
}

export function schemaForTemplate(templateName?: string): SignalSchemaName {
  const normalized = (templateName || 'default').trim().toLowerCase();
  if (normalized === 'cryptodanielvip') return 'cryptodanielvip';
  if (normalized === 'loma') return 'loma';
  if (normalized === 'speculantca') return 'speculantca';
  return 'standard';
}

export function validateSignalXml(xml: string, templateName?: string): ValidatedSignal {
  if (typeof xml !== 'string') {
    throw new SignalValidationError('Signal XML must be a non-empty string no larger than 64 KiB.');
  }
  const normalizedXml = xml.trim();
  const root = parseXml(normalizedXml);
  const schema = schemaForTemplate(templateName);
  const common = schema === 'cryptodanielvip'
    ? validateCryptoDaniel(root)
    : schema === 'loma'
      ? validateLoma(root)
      : schema === 'speculantca'
        ? validateSpeculant(root)
        : validateStandard(root);
  return { xml: normalizedXml, schema, ...common };
}

function normalizedGroundingText(value: string): string {
  return value.normalize('NFKC').toLocaleUpperCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function assertSignalGrounded(signal: ValidatedSignal, sourceText: string): void {
  if (typeof sourceText !== 'string' || !sourceText.trim()) {
    throw new SignalValidationError('Signal source text is empty and cannot ground an AI result.');
  }
  const compactSource = sourceText.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!compactSource.includes(signal.pair)) {
    throw new SignalValidationError(`Pair '${signal.pair}' is not grounded in the source text.`);
  }

  const actionPattern = signal.action === 'LONG'
    ? /(?:^|[^A-Z])(LONG|BUY|CALL)(?:$|[^A-Z])/i
    : /(?:^|[^A-Z])(SHORT|SELL|PUT)(?:$|[^A-Z])/i;
  if (!actionPattern.test(sourceText.normalize('NFKC'))) {
    throw new SignalValidationError(`Action '${signal.action}' is not grounded in the source text.`);
  }

  const sourceNumbers = Array.from(
    sourceText.matchAll(/(?<![\p{L}\p{N}_])(?<!\d\.)(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?(?=(?:[xX%])?(?![\p{L}\p{N}_]|\.\d))/gu),
    match => match[0]
  );
  for (const value of signal.groundingNumbers) {
    if (!sourceNumbers.some(sourceValue => compareDecimals(sourceValue, value) === 0)) {
      throw new SignalValidationError(`Output number '${value}' is not grounded in the source text.`);
    }
  }

  if (signal.groundingComment) {
    const normalizedSource = normalizedGroundingText(sourceText);
    const normalizedComment = normalizedGroundingText(signal.groundingComment);
    if (!normalizedComment || !normalizedSource.includes(normalizedComment)) {
      throw new SignalValidationError('Signal comment must be a contiguous excerpt grounded in the source text.');
    }
  }
}
