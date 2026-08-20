import type {
  ExecutableSignal,
  ExecutableSignalSchemaContract,
  SignalContractAdditionalField,
  SignalContractDefinition,
} from './trading_types.js';
import { validateSignalContractDefinition } from './signal_contract.js';

export interface ExecutableSignalSchemaSelection {
  id: string;
  parserSchema: ExecutableSignalSchemaContract;
  contractVersionId?: string;
  contractDefinition?: SignalContractDefinition;
}

interface XmlNode {
  name: string;
  id?: number;
  text: string;
  children: XmlNode[];
}

export interface ValidatedSignal {
  xml: string;
  schema: string;
  action: 'LONG' | 'SHORT';
  pair: string;
  groundingNumbers: string[];
  groundingFields: GroundingField[];
  groundingComment?: string;
  groundingPolicy?: { action: boolean; pair: boolean };
  execution?: ExecutableSignal;
}

export type GroundingFieldKind = 'entry' | 'averaging' | 'target' | 'stop' | 'leverage' | 'risk';

export interface GroundingField {
  kind: GroundingFieldKind;
  values: string[];
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

  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === '<') {
      const end = source.indexOf('>', cursor + 1);
      if (end < 0) throw new SignalValidationError('Malformed XML token sequence.');
      tokens.push(source.slice(cursor, end + 1));
      cursor = end + 1;
      continue;
    }
    const end = source.indexOf('<', cursor);
    if (end < 0) {
      tokens.push(source.slice(cursor));
      break;
    }
    tokens.push(source.slice(cursor, end));
    cursor = end;
  }
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
  stack.at(-1)!.text += token;
}

function createXmlNode(token: string): XmlNode {
  const opening = /^<([a-z_]+)(?: id="([1-9]\d*)")?>$/.exec(token);
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
  const closing = /^<\/([a-z_]+)>$/.exec(token);
  if (closing) {
    const node = stack.pop();
    if (node?.name !== closing[1]) {
      throw new SignalValidationError(`Mismatched closing tag '${closing[1]}'.`);
    }
    return root;
  }
  const node = createXmlNode(token);
  if (stack.length > 0) stack.at(-1)!.children.push(node);
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
    throw new SignalValidationError(`Unclosed XML tag '${stack.at(-1)!.name}'.`);
  }
  if (root?.name !== 'signal') {
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
  const quotedPair = /^(?=.{5,20}$)[A-Z0-9]+(?:USDT|USDC|USD)$/.test(pair);
  if (requireQuoteAsset && !quotedPair) {
    throw new SignalValidationError(`Pair '${pair}' must use the USD, USDC, or USDT quote asset.`);
  }
  if (!requireQuoteAsset && !genericPair) {
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
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
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
  assertStopGeometry(action, stoploss, entry);
  let baseline = stoploss;
  if (entry) baseline = action === 'LONG' ? entry.max : entry.min;
  const boundaryLabel = entry ? 'the entry range' : 'stoploss';
  targets.forEach((target, index) => assertTargetGeometry(action, target, index, targets, baseline, boundaryLabel));
}

function assertStopGeometry(action: 'LONG' | 'SHORT', stoploss: string, entry?: { min: string; max: string }): void {
  if (!entry) return;
  if (action === 'LONG' && compareDecimals(stoploss, entry.min) >= 0) {
    throw new SignalValidationError('LONG stoploss must be below the entry range.');
  }
  if (action === 'SHORT' && compareDecimals(stoploss, entry.max) <= 0) {
    throw new SignalValidationError('SHORT stoploss must be above the entry range.');
  }
}

function assertTargetGeometry(
  action: 'LONG' | 'SHORT',
  target: string,
  index: number,
  targets: string[],
  baseline: string,
  boundaryLabel: string,
): void {
  if (action === 'LONG' && compareDecimals(target, baseline) <= 0) {
    throw new SignalValidationError(`LONG target ${index + 1} must be above ${boundaryLabel}.`);
  }
  if (action === 'SHORT' && compareDecimals(target, baseline) >= 0) {
    throw new SignalValidationError(`SHORT target ${index + 1} must be below ${boundaryLabel}.`);
  }
  if (index === 0) return;
  const order = compareDecimals(targets[index - 1]!, target);
  if ((action === 'LONG' && order >= 0) || (action === 'SHORT' && order <= 0)) {
    throw new SignalValidationError(`${action} targets must be strictly ordered away from entry.`);
  }
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
    groundingNumbers: [...(entry ? [entry.min, entry.max] : []), ...targets, stoploss, ...(leverage ? [leverage] : [])],
    groundingFields: [
      ...(entry ? [{ kind: 'entry' as const, values: [entry.min, entry.max] }] : []),
      { kind: 'target', values: targets },
      { kind: 'stop', values: [stoploss] },
      ...(leverage ? [{ kind: 'leverage' as const, values: [leverage] }] : [])
    ]
  };
}

function cryptodanielEntry(root: XmlNode, entryType: string): { min: string; max: string } | undefined {
  const entryNode = optional(root, 'entry_range');
  if (entryType === 'LIMIT' && !entryNode) throw new SignalValidationError('LIMIT signals require entry_range.');
  if (entryType === 'MARKET' && entryNode) throw new SignalValidationError('MARKET signals must omit entry_range.');
  return entryNode ? range(entryNode) : undefined;
}

function optionalDecimalChild(root: XmlNode, name: string): string | undefined {
  const node = optional(root, name);
  return node ? decimal(node, name) : undefined;
}

function cryptodanielRisk(root: XmlNode): string | undefined {
  const risk = optionalDecimalChild(root, 'risk_percent');
  if (risk && compareDecimals(risk, '100') > 0) {
    throw new SignalValidationError('risk_percent must not exceed 100.');
  }
  return risk;
}

function validateCryptoDaniel(root: XmlNode): Omit<ValidatedSignal, 'xml' | 'schema'> {
  assertAllowedChildren(root, ['action', 'pair', 'entry_type', 'entry_range', 'averaging', 'targets', 'stoploss', 'risk_percent']);
  const action = actionValue(root);
  const pair = pairValue(root, true);
  const entryType = leaf(required(root, 'entry_type'));
  if (entryType !== 'MARKET' && entryType !== 'LIMIT') throw new SignalValidationError("entry_type must be 'MARKET' or 'LIMIT'.");
  const entry = cryptodanielEntry(root, entryType);
  const averaging = optionalDecimalChild(root, 'averaging');
  const targets = scalarTargets(required(root, 'targets'));
  const stoploss = decimal(required(root, 'stoploss'));
  const risk = cryptodanielRisk(root);
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
    ],
    groundingFields: [
      ...(entry ? [{ kind: 'entry' as const, values: [entry.min, entry.max] }] : []),
      ...(averaging ? [{ kind: 'averaging' as const, values: [averaging] }] : []),
      { kind: 'target', values: targets },
      { kind: 'stop', values: [stoploss] },
      ...(risk ? [{ kind: 'risk' as const, values: [risk] }] : [])
    ]
  };
}

function validateLoma(root: XmlNode): Omit<ValidatedSignal, 'xml' | 'schema'> {
  assertAllowedChildren(root, ['pair', 'timeframe', 'action', 'entry_range', 'stoploss', 'targets']);
  const action = actionValue(root);
  const pair = pairValue(root, true);
  const timeframe = leaf(required(root, 'timeframe'));
  if (!/^[MHDW]\d{1,3}(?:\/[MHDW]\d{1,3})*$/.test(timeframe)) {
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
    ],
    groundingFields: [
      { kind: 'entry', values: [entry.min, entry.max] },
      { kind: 'target', values: targets.flatMap(target => [target.min, target.max]) },
      { kind: 'stop', values: [stoploss] }
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
  return { action, pair, groundingNumbers: [], groundingFields: [], groundingComment: comment };
}

function pathNodes(root: XmlNode, path: string): XmlNode[] {
  let current = [root];
  for (const segment of path.split('.')) {
    current = current.flatMap(node => children(node, segment));
  }
  return current;
}

function pathNode(root: XmlNode, path: string, requiredValue: boolean): XmlNode | undefined {
  const matches = pathNodes(root, path);
  if (matches.length > 1) throw new SignalValidationError(`Contract path '${path}' must resolve at most once.`);
  if (requiredValue && matches.length !== 1) {
    throw new SignalValidationError(`Required contract path '${path}' must appear exactly once.`);
  }
  return matches[0];
}

function pathLeaf(root: XmlNode, path: string, requiredValue: boolean): string | undefined {
  const node = pathNode(root, path, requiredValue);
  return node ? leaf(node) : undefined;
}

function addDeclaredPath(map: Map<string, Set<string>>, path: string): void {
  const segments = path.split('.');
  let parent = '';
  for (const segment of segments) {
    const allowed = map.get(parent) ?? new Set<string>();
    allowed.add(segment);
    map.set(parent, allowed);
    parent = parent ? `${parent}.${segment}` : segment;
  }
}

function declaredStructure(definition: SignalContractDefinition): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const paths = [
    definition.actionPath,
    definition.pairPath,
    definition.entry.typePath,
    definition.entry.minimumPath,
    definition.entry.maximumPath,
    definition.targets.containerPath,
    definition.stopLossPath,
    definition.leveragePath,
    definition.riskPercentPath,
    definition.averagingPricePath,
    ...definition.additionalFields.map(field => field.path),
  ].filter((value): value is string => Boolean(value));
  for (const path of paths) addDeclaredPath(map, path);
  const targetContainer = definition.targets.containerPath;
  const targetAllowed = map.get(targetContainer) ?? new Set<string>();
  targetAllowed.add(definition.targets.itemTag);
  map.set(targetContainer, targetAllowed);
  if (definition.targets.shape === 'range') {
    addDeclaredPath(map, `${targetContainer}.${definition.targets.itemTag}.${definition.targets.minimumPath}`);
    addDeclaredPath(map, `${targetContainer}.${definition.targets.itemTag}.${definition.targets.maximumPath}`);
  }
  return map;
}

function assertDeclaredNode(node: XmlNode, path: string, structure: Map<string, Set<string>>): void {
  const allowed = structure.get(path) ?? new Set<string>();
  if (node.children.length > 0 && node.text.trim()) {
    throw new SignalValidationError(`Mixed text is not allowed inside '${node.name}'.`);
  }
  for (const child of node.children) {
    if (!allowed.has(child.name)) throw new SignalValidationError(`Unknown tag '${child.name}' in '${node.name}'.`);
    const childPath = path ? `${path}.${child.name}` : child.name;
    assertDeclaredNode(child, childPath, structure);
  }
}

function contractDecimal(root: XmlNode, path: string, requiredValue: boolean): string | undefined {
  const node = pathNode(root, path, requiredValue);
  return node ? decimal(node, path) : undefined;
}

function validateAdditionalFieldText(field: SignalContractAdditionalField, value: string): void {
  if (field.allowedValues.length > 0 && !field.allowedValues.includes(value)) {
    throw new SignalValidationError(`Contract path '${field.path}' contains an unsupported value.`);
  }
  if (field.maximumLength !== undefined && value.length > field.maximumLength) {
    throw new SignalValidationError(`Contract path '${field.path}' exceeds its maximum length.`);
  }
  if (field.pattern && !new RegExp(field.pattern, 'u').test(value)) {
    throw new SignalValidationError(`Contract path '${field.path}' does not match its required pattern.`);
  }
}

function validateAdditionalFieldType(field: SignalContractAdditionalField, value: string): void {
  if (field.type === 'boolean' && value !== 'true' && value !== 'false') {
    throw new SignalValidationError(`Contract path '${field.path}' must be true or false.`);
  }
  if (field.type === 'integer' && !/^(?:0|[1-9]\d{0,17})$/.test(value)) {
    throw new SignalValidationError(`Contract path '${field.path}' must be an unsigned integer.`);
  }
}

function validateAdditionalDecimal(root: XmlNode, field: SignalContractAdditionalField): void {
  const normalized = decimal(pathNode(root, field.path, true)!, field.path);
  if (field.minimum && compareDecimals(normalized, field.minimum) < 0) {
    throw new SignalValidationError(`Contract path '${field.path}' is below its minimum.`);
  }
  if (field.maximum && compareDecimals(normalized, field.maximum) > 0) {
    throw new SignalValidationError(`Contract path '${field.path}' exceeds its maximum.`);
  }
}

function validateAdditionalField(root: XmlNode, field: SignalContractAdditionalField): void {
  const value = pathLeaf(root, field.path, field.required);
  if (value === undefined) return;
  validateAdditionalFieldText(field, value);
  validateAdditionalFieldType(field, value);
  if (field.type === 'decimal') validateAdditionalDecimal(root, field);
}

function contractEntry(
  root: XmlNode,
  definition: SignalContractDefinition,
): { min: string; max: string } | undefined {
  let rangeRequired = definition.entry.mode === 'required_range';
  if (definition.entry.mode === 'typed') {
    const type = pathLeaf(root, definition.entry.typePath!, true)!;
    if (definition.entry.marketValues.includes(type)) rangeRequired = false;
    else if (definition.entry.rangeValues.includes(type)) rangeRequired = true;
    else throw new SignalValidationError(`Entry type '${type}' is not allowed by the contract.`);
  }
  const minimum = contractDecimal(root, definition.entry.minimumPath, rangeRequired);
  const maximum = contractDecimal(root, definition.entry.maximumPath, rangeRequired);
  if ((minimum === undefined) !== (maximum === undefined)) {
    throw new SignalValidationError('Entry range minimum and maximum must either both be present or both be absent.');
  }
  if (definition.entry.mode === 'typed' && !rangeRequired && minimum !== undefined) {
    throw new SignalValidationError('Market entry must omit its entry range.');
  }
  if (minimum === undefined || maximum === undefined) return undefined;
  if (compareDecimals(minimum, maximum) > 0) {
    throw new SignalValidationError('Entry range minimum must not exceed maximum.');
  }
  return { min: minimum, max: maximum };
}

function targetItemRange(item: XmlNode, definition: SignalContractDefinition): { min: string; max: string } {
  if (definition.targets.shape === 'scalar') {
    const value = decimal(item, 'target');
    return { min: value, max: value };
  }
  const minimum = contractDecimal(item, definition.targets.minimumPath, true)!;
  const maximum = contractDecimal(item, definition.targets.maximumPath, true)!;
  if (compareDecimals(minimum, maximum) > 0) {
    throw new SignalValidationError('Target range minimum must not exceed maximum.');
  }
  return { min: minimum, max: maximum };
}

function contractTargets(root: XmlNode, definition: SignalContractDefinition): Array<{ min: string; max: string }> {
  const container = pathNode(root, definition.targets.containerPath, true)!;
  const items = children(container, definition.targets.itemTag);
  if (items.length < definition.targets.minimumItems || items.length > definition.targets.maximumItems) {
    throw new SignalValidationError(
      `Targets must contain between ${definition.targets.minimumItems} and ${definition.targets.maximumItems} items.`,
    );
  }
  return items.map((item, index) => {
    if (definition.targets.sequentialIds && item.id !== index + 1) {
      throw new SignalValidationError('Target ids must be sequential and start at 1.');
    }
    return targetItemRange(item, definition);
  });
}

function assertContractGeometry(
  definition: SignalContractDefinition,
  action: 'LONG' | 'SHORT',
  entry: { min: string; max: string } | undefined,
  stopLoss: string,
  targets: Array<{ min: string; max: string }>,
): void {
  const baselineMinimum = entry?.min ?? targets[0]!.min;
  const baselineMaximum = entry?.max ?? targets[0]!.max;
  if (definition.geometry.stopOnLossSide) {
    if (action === 'LONG' && compareDecimals(stopLoss, baselineMinimum) >= 0) {
      throw new SignalValidationError('LONG stoploss must be below the entry range.');
    }
    if (action === 'SHORT' && compareDecimals(stopLoss, baselineMaximum) <= 0) {
      throw new SignalValidationError('SHORT stoploss must be above the entry range.');
    }
  }
  targets.forEach((target, index) => {
    if (definition.geometry.orderedRanges && compareDecimals(target.min, target.max) > 0) {
      throw new SignalValidationError(`Target ${index + 1} range is inverted.`);
    }
    if (definition.geometry.targetsOnProfitSide && entry) {
      if (action === 'LONG' && compareDecimals(target.min, baselineMaximum) <= 0) {
        throw new SignalValidationError(`LONG target ${index + 1} must be above entry.`);
      }
      if (action === 'SHORT' && compareDecimals(target.max, baselineMinimum) >= 0) {
        throw new SignalValidationError(`SHORT target ${index + 1} must be below entry.`);
      }
    }
    if (!definition.geometry.orderedTargets || index === 0) return;
    const previous = targets[index - 1]!;
    if (action === 'LONG' && compareDecimals(target.min, previous.max) <= 0) {
      throw new SignalValidationError('LONG targets must be strictly ordered away from entry.');
    }
    if (action === 'SHORT' && compareDecimals(target.max, previous.min) >= 0) {
      throw new SignalValidationError('SHORT targets must be strictly ordered away from entry.');
    }
  });
}

type DynamicOptionalValues = {
  leverage: string | undefined;
  risk: string | undefined;
  averaging: string | undefined;
};

function dynamicAction(root: XmlNode, definition: SignalContractDefinition): 'LONG' | 'SHORT' {
  const action = pathLeaf(root, definition.actionPath, true);
  if (action !== 'LONG' && action !== 'SHORT') {
    throw new SignalValidationError("Action must be 'LONG' or 'SHORT'.");
  }
  return action;
}

function dynamicOptionalValues(root: XmlNode, definition: SignalContractDefinition): DynamicOptionalValues {
  const leverage = definition.leveragePath
    ? contractDecimal(root, definition.leveragePath, false)
    : undefined;
  if (leverage && (compareDecimals(leverage, '1') < 0 || compareDecimals(leverage, '125') > 0)) {
    throw new SignalValidationError('Leverage must be between 1 and 125.');
  }
  const risk = definition.riskPercentPath
    ? contractDecimal(root, definition.riskPercentPath, false)
    : undefined;
  if (risk && compareDecimals(risk, '100') > 0) {
    throw new SignalValidationError('risk_percent must not exceed 100.');
  }
  const averaging = definition.averagingPricePath
    ? contractDecimal(root, definition.averagingPricePath, false)
    : undefined;
  return { leverage, risk, averaging };
}

function dynamicGroundingNumbers(
  definition: SignalContractDefinition,
  entry: { min: string; max: string } | undefined,
  targets: Array<{ min: string; max: string }>,
  stopLoss: string,
  optional: DynamicOptionalValues,
): string[] {
  const values: string[] = [];
  if (definition.grounding.entry && entry) values.push(entry.min, entry.max);
  if (definition.grounding.targets) values.push(...targets.flatMap(target => [target.min, target.max]));
  if (definition.grounding.stopLoss) values.push(stopLoss);
  if (definition.grounding.leverage && optional.leverage) values.push(optional.leverage);
  if (definition.grounding.riskPercent && optional.risk) values.push(optional.risk);
  if (definition.grounding.averagingPrice && optional.averaging) values.push(optional.averaging);
  return values;
}

function dynamicGroundingFields(
  definition: SignalContractDefinition,
  entry: { min: string; max: string } | undefined,
  targets: Array<{ min: string; max: string }>,
  stopLoss: string,
  optional: DynamicOptionalValues,
): GroundingField[] {
  const fields: GroundingField[] = [];
  if (definition.grounding.entry && entry) fields.push({ kind: 'entry', values: [entry.min, entry.max] });
  if (definition.grounding.targets) {
    fields.push({ kind: 'target', values: targets.flatMap(target => [target.min, target.max]) });
  }
  if (definition.grounding.stopLoss) fields.push({ kind: 'stop', values: [stopLoss] });
  if (definition.grounding.leverage && optional.leverage) {
    fields.push({ kind: 'leverage', values: [optional.leverage] });
  }
  if (definition.grounding.riskPercent && optional.risk) fields.push({ kind: 'risk', values: [optional.risk] });
  if (definition.grounding.averagingPrice && optional.averaging) {
    fields.push({ kind: 'averaging', values: [optional.averaging] });
  }
  return fields;
}

function validateDynamicContract(
  root: XmlNode,
  input: SignalContractDefinition,
): Omit<ValidatedSignal, 'xml' | 'schema'> {
  const definition = validateSignalContractDefinition(input);
  assertDeclaredNode(root, '', declaredStructure(definition));
  const action = dynamicAction(root, definition);
  const pairNode = pathNode(root, definition.pairPath, true)!;
  const pair = pairValue({ ...root, children: [{ ...pairNode, name: 'pair' }] }, true);
  const entry = contractEntry(root, definition);
  const targets = contractTargets(root, definition);
  const stopLoss = contractDecimal(root, definition.stopLossPath, true)!;
  const optional = dynamicOptionalValues(root, definition);
  for (const field of definition.additionalFields) validateAdditionalField(root, field);
  assertContractGeometry(definition, action, entry, stopLoss, targets);
  return {
    action,
    pair,
    groundingNumbers: dynamicGroundingNumbers(definition, entry, targets, stopLoss, optional),
    groundingFields: dynamicGroundingFields(definition, entry, targets, stopLoss, optional),
    groundingPolicy: { action: definition.grounding.action, pair: definition.grounding.pair },
    execution: {
      schema: 'dynamic',
      action,
      symbol: pair,
      entry: entry ? { type: 'range', ...entry } : { type: 'market' },
      targets,
      stopLoss,
      suggestedLeverage: optional.leverage ? Math.floor(Number(optional.leverage)) : undefined,
      suggestedRiskPercent: optional.risk,
      averagingPrice: optional.averaging,
    },
  };
}

export function schemaForTemplate(templateName?: string): string {
  const normalized = (templateName || 'default').trim().toLowerCase();
  if (normalized === 'cryptodanielvip') return 'cryptodanielvip';
  if (normalized === 'loma') return 'loma';
  if (normalized === 'speculantca') return 'speculantca';
  return 'standard';
}

export function validateSignalXml(
  xml: string,
  templateName?: string,
  executableSchema?: ExecutableSignalSchemaSelection | null,
): ValidatedSignal {
  if (typeof xml !== 'string') {
    throw new SignalValidationError('Signal XML must be a non-empty string no larger than 64 KiB.');
  }
  const normalizedXml = xml.trim();
  const root = parseXml(normalizedXml);
  const parserSchema = executableSchema?.parserSchema ?? schemaForTemplate(templateName);
  const schema = executableSchema?.id ?? parserSchema;
  let common: Omit<ValidatedSignal, 'xml' | 'schema'>;
  if (executableSchema?.contractDefinition) common = validateDynamicContract(root, executableSchema.contractDefinition);
  else if (parserSchema === 'cryptodanielvip') common = validateCryptoDaniel(root);
  else if (parserSchema === 'loma') common = validateLoma(root);
  else if (parserSchema === 'speculantca') common = validateSpeculant(root);
  else common = validateStandard(root);
  if (executableSchema === null) delete common.execution;
  else if (common.execution) common.execution = { ...common.execution, schema };
  return { xml: normalizedXml, schema, ...common };
}

function normalizedGroundingText(value: string): string {
  return value.normalize('NFKC').toLocaleUpperCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const GROUNDING_LABEL_PATTERNS = [
  /\bENTRY(?:\s+(?:RANGE|LIMIT|MARKET))?\b/giu,
  /(?<![\p{L}\p{N}_])ВХОД(?![\p{L}\p{N}_])/giu,
  /\bAVERAGING\b/giu,
  /(?<![\p{L}\p{N}_])УСРЕДНЕНИЕ(?![\p{L}\p{N}_])/giu,
  /\b(?:STOP\s*LOSS|STOPLOSS|STOP|SL)\b/giu,
  /(?<![\p{L}\p{N}_])СТОП(?![\p{L}\p{N}_])/giu,
  /\bTARGETS\b/giu,
  /\bTARGET(?:\s*#?\d+(?=\s*:))?\b/giu,
  /\bTP(?:\s*#?\d+(?=\s*:))?\b/giu,
  /\bTAKE\s*PROFIT(?:\s*#?\d+(?=\s*:))?\b/giu,
  /(?<![\p{L}\p{N}_])ЦЕЛИ(?![\p{L}\p{N}_])/giu,
  /\bLEVERAGE\b/giu,
  /(?<![\p{L}\p{N}_])\u041a\u0420\u041e\u0421\u0421[-\u2010-\u2015]?\u041f\u041b\u0415\u0427\u041e(?![\p{L}\p{N}_])/giu,
  /(?<![\p{L}\p{N}_])\u041d\u0410(?=\s+(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?%\s+\u0414\u0415\u041f\u041e\u0417\u0418\u0422\u0410(?![\p{L}\p{N}_]))/giu,
  /\bRISK(?:\s*PERCENT)?\b/giu,
  /(?<![\p{L}\p{N}_])РИСК(?:\s+МЕНЕДЖМЕНТ)?(?![\p{L}\p{N}_])/giu,
] as const;

interface GroundingLabelMatch {
  label: string;
  index: number;
}

function groundingLabels(value: string): GroundingLabelMatch[] {
  const labels = GROUNDING_LABEL_PATTERNS.flatMap(pattern =>
    Array.from(value.matchAll(pattern), match => ({ label: match[0], index: match.index }))
  ).sort((left, right) => left.index - right.index || right.label.length - left.label.length);
  return labels.filter((label, index) => {
    if (index === 0) return true;
    const previous = labels[index - 1]!;
    return label.index >= previous.index + previous.label.length;
  });
}

function groundingKind(label: string): GroundingFieldKind {
  const normalized = label.replace(/\s+/g, ' ').trim().toUpperCase();
  if (normalized.startsWith('ENTRY') || normalized === 'ВХОД') return 'entry';
  if (normalized.startsWith('AVERAGING') || normalized === 'УСРЕДНЕНИЕ') return 'averaging';
  if (normalized.startsWith('STOP') || normalized === 'SL' || normalized === 'СТОП') return 'stop';
  if (normalized.startsWith('TARGET') || normalized.startsWith('TP') || normalized.startsWith('TAKE PROFIT') || normalized === 'ЦЕЛИ') return 'target';
  if (normalized.startsWith('LEVERAGE') || normalized.startsWith('\u041a\u0420\u041e\u0421\u0421')) return 'leverage';
  return 'risk';
}

function canonicalDecimal(value: string): string {
  const [integer = '0', fraction = ''] = value.split('.');
  let normalizedInteger = integer;
  while (normalizedInteger.length > 1 && normalizedInteger.startsWith('0')) normalizedInteger = normalizedInteger.slice(1);
  let normalizedFraction = fraction;
  while (normalizedFraction.endsWith('0')) normalizedFraction = normalizedFraction.slice(0, -1);
  return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9';
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function isGroundingNumberStart(value: string, index: number): boolean {
  if (!isDigit(value[index]) || isWordCharacter(value[index - 1])) return false;
  return value[index - 1] !== '.' || !isDigit(value[index - 2]);
}

function scanGroundingNumber(value: string, start: number): { end: number; decimal?: string } {
  let end = start;
  if (value[end] === '0') end += 1;
  else while (isDigit(value[end]) && end - start < 18) end += 1;
  if (value[end] === '.' && isDigit(value[end + 1])) {
    end += 1;
    const fractionStart = end;
    while (isDigit(value[end]) && end - fractionStart < 18) end += 1;
  }
  const suffixLength = ['x', 'X', '%'].includes(value[end] || '') ? 1 : 0;
  const boundary = value[end + suffixLength];
  const invalidBoundary = isWordCharacter(boundary) || (boundary === '.' && isDigit(value[end + suffixLength + 1]));
  return invalidBoundary ? { end } : { end, decimal: canonicalDecimal(value.slice(start, end)) };
}

function numbersInGroundingClause(value: string): string[] {
  const values: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    if ((value[cursor] === 'x' || value[cursor] === 'X') && isDigit(value[cursor + 1]) && !isWordCharacter(value[cursor - 1])) {
      const scanned = scanGroundingNumber(value, cursor + 1);
      if (scanned.decimal) values.push(scanned.decimal);
      cursor = Math.max(scanned.end, cursor + 2);
      continue;
    }
    if (!isGroundingNumberStart(value, cursor)) {
      cursor += 1;
      continue;
    }
    const scanned = scanGroundingNumber(value, cursor);
    if (scanned.decimal) values.push(scanned.decimal);
    cursor = Math.max(scanned.end, cursor + 1);
  }
  return values;
}

function sourceFieldNumbers(sourceText: string): Map<GroundingFieldKind, string[]> {
  const normalized = sourceText.normalize('NFKC');
  const labels = groundingLabels(normalized);
  const result = new Map<GroundingFieldKind, string[]>();
  labels.forEach((match, index) => {
    const start = match.index + match.label.length;
    const end = labels[index + 1]?.index ?? normalized.length;
    const kind = groundingKind(match.label);
    const values = numbersInGroundingClause(normalized.slice(start, end));
    result.set(kind, [...(result.get(kind) ?? []), ...values]);
  });
  return result;
}

function assertFieldGrounded(
  field: GroundingField,
  sourceFields: Map<GroundingFieldKind, string[]>,
  allowMarketAveragingEntry = false,
): void {
  const expected = [...new Set(field.values.map(canonicalDecimal))].sort((left, right) => left.localeCompare(right));
  const directValues = sourceFields.get(field.kind) ?? [];
  const sourceValues = field.kind === 'entry' && directValues.length === 0 && allowMarketAveragingEntry
    ? sourceFields.get('averaging') ?? []
    : directValues;
  const actual = [...new Set(sourceValues)].sort((left, right) => left.localeCompare(right));
  if (actual.length === 0) {
    throw new SignalValidationError(`Output field '${field.kind}' has no explicit source label and cannot be grounded.`);
  }
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw new SignalValidationError(
      `Output field '${field.kind}' is ambiguous or does not exactly match its labeled source values.`
    );
  }
}

const GROUNDING_QUOTE_ASSETS = ['USDT', 'USDC', 'USD'];
const GROUNDING_PAIR_CONNECTORS = new Set(['AND', 'OR', 'UND', 'ODER', 'VERSUS', 'VS']);

function isQuotedPairCandidate(candidate: string): boolean {
  return GROUNDING_QUOTE_ASSETS.some(quote => {
    if (!candidate.endsWith(quote)) return false;
    const base = candidate.slice(0, -quote.length);
    return base.length >= 2 && base.length <= 12 && /^[A-Z0-9]+$/.test(base) && /[A-Z]/.test(base);
  });
}

function pairCandidates(tokens: string[], expectedPair: string): string[] {
  const candidates: string[] = [];
  tokens.forEach((token, index) => {
    if (token === '/') return;
    if (isQuotedPairCandidate(token)) candidates.push(token);
    const slashSeparated = tokens[index + 1] === '/';
    const quote = slashSeparated ? tokens[index + 2] : tokens[index + 1];
    if (!quote || !GROUNDING_QUOTE_ASSETS.includes(quote)) return;
    const candidate = `${token}${quote}`;
    if (!isQuotedPairCandidate(candidate)) return;
    const connector = tokens[index - 1];
    if (slashSeparated || candidate === expectedPair || GROUNDING_PAIR_CONNECTORS.has(connector)) {
      candidates.push(candidate);
    }
  });
  return candidates;
}

function hashtagPairCandidates(sourceText: string): string[] {
  return Array.from(
    sourceText.normalize('NFKC').toUpperCase().matchAll(/#([A-Z0-9]{2,12})(?=\s+(?:LONG|SHORT)(?:\b|[^A-Z]))/g),
    match => `${match[1]}USDT`,
  ).filter(isQuotedPairCandidate);
}

function assertPairGrounded(signal: ValidatedSignal, sourceText: string): void {
  const compactSource = sourceText.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const hashtagPairs = hashtagPairCandidates(sourceText);
  if (!compactSource.includes(signal.pair) && !hashtagPairs.includes(signal.pair)) {
    throw new SignalValidationError(`Pair '${signal.pair}' is not grounded in the source text.`);
  }
  if (!signal.execution) return;
  const normalizedTokens = sourceText.normalize('NFKC').toUpperCase().match(/[A-Z0-9]+|\//g) || [];
  const quotedPairs = new Set([...pairCandidates(normalizedTokens, signal.pair), ...hashtagPairs]);
  if (quotedPairs.size > 1 || (quotedPairs.size === 1 && !quotedPairs.has(signal.pair))) {
    throw new SignalValidationError('Source text contains competing trading pairs and is ambiguous.');
  }
}

function assertActionGrounded(signal: ValidatedSignal, sourceText: string): void {
  const normalized = sourceText.normalize('NFKC');
  const longPattern = /(?:^|[^A-Z])(LONG|BUY|CALL)(?:$|[^A-Z])/i;
  const shortPattern = /(?:^|[^A-Z])(SHORT|SELL|PUT)(?:$|[^A-Z])/i;
  if (longPattern.test(normalized) && shortPattern.test(normalized)) {
    throw new SignalValidationError('Source text contains competing LONG and SHORT actions and is ambiguous.');
  }
  const expected = signal.action === 'LONG' ? longPattern : shortPattern;
  if (!expected.test(normalized)) {
    throw new SignalValidationError(`Action '${signal.action}' is not grounded in the source text.`);
  }
}

function assertNumbersGrounded(signal: ValidatedSignal, sourceText: string): void {
  const sourceNumbers = Array.from(
    sourceText.matchAll(/(?<![\p{L}\p{N}_])(?<!\d\.)(?:[xX])?((?:0|[1-9]\d{0,17})(?:\.\d{1,18})?)(?=(?:[xX%])?(?![\p{L}\p{N}_]|\.\d))/gu),
    match => match[1]!
  );
  for (const value of signal.groundingNumbers) {
    if (!sourceNumbers.some(sourceValue => compareDecimals(sourceValue, value) === 0)) {
      throw new SignalValidationError(`Output number '${value}' is not grounded in the source text.`);
    }
  }
}

function assertCommentGrounded(comment: string | undefined, sourceText: string): void {
  if (!comment) return;
  const normalizedSource = normalizedGroundingText(sourceText);
  const normalizedComment = normalizedGroundingText(comment);
  if (!normalizedComment || !normalizedSource.includes(normalizedComment)) {
    throw new SignalValidationError('Signal comment must be a contiguous excerpt grounded in the source text.');
  }
}

export function assertSignalGrounded(signal: ValidatedSignal, sourceText: string): void {
  if (typeof sourceText !== 'string' || !sourceText.trim()) {
    throw new SignalValidationError('Signal source text is empty and cannot ground an AI result.');
  }
  if (signal.groundingPolicy?.pair !== false) assertPairGrounded(signal, sourceText);
  if (signal.groundingPolicy?.action !== false) assertActionGrounded(signal, sourceText);
  assertNumbersGrounded(signal, sourceText);
  const sourceFields = sourceFieldNumbers(sourceText);
  const allowMarketAveragingEntry = /(?<![\p{L}\p{N}_])ВХОД\s*:\s*ПО\s+РЫНКУ(?![\p{L}\p{N}_])/iu.test(
    sourceText.normalize('NFKC'),
  );
  for (const field of signal.groundingFields) {
    assertFieldGrounded(field, sourceFields, allowMarketAveragingEntry);
  }
  assertCommentGrounded(signal.groundingComment, sourceText);
}
