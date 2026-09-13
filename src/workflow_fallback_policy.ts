import {
  WORKFLOW_FALLBACK_REASONS,
  type WorkflowFallbackReason,
} from './trading_types.js';

export const LEGACY_WORKFLOW_FALLBACK_POLICY: readonly WorkflowFallbackReason[] = [
  'SYMBOL_UNAVAILABLE',
];

const WORKFLOW_FALLBACK_REASON_ORDER = new Map<WorkflowFallbackReason, number>(
  WORKFLOW_FALLBACK_REASONS.map((reason, index) => [reason, index]),
);

export function isWorkflowFallbackReason(value: unknown): value is WorkflowFallbackReason {
  return typeof value === 'string'
    && WORKFLOW_FALLBACK_REASON_ORDER.has(value as WorkflowFallbackReason);
}

function fallbackRank(reason: WorkflowFallbackReason): number {
  const rank = WORKFLOW_FALLBACK_REASON_ORDER.get(reason);
  if (rank === undefined) throw new Error('Unknown workflow fallback reason.');
  return rank;
}

export function canonicalWorkflowFallbackPolicy(
  values: readonly WorkflowFallbackReason[],
): WorkflowFallbackReason[] {
  return [...values].sort(
    (left, right) => fallbackRank(left) - fallbackRank(right),
  );
}
