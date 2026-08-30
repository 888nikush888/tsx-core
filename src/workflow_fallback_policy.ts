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

export function canonicalWorkflowFallbackPolicy(
  values: readonly WorkflowFallbackReason[],
): WorkflowFallbackReason[] {
  return [...values].sort(
    (left, right) => WORKFLOW_FALLBACK_REASON_ORDER.get(left)!
      - WORKFLOW_FALLBACK_REASON_ORDER.get(right)!,
  );
}
