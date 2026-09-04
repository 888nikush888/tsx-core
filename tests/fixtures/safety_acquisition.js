/** Explicit complete-source evidence for isolated synthetic account fixtures, not a provider acceptance claim. */
export function completeSafetyState(state = {}) {
  const now = Date.now();
  return { orders: [], positions: [], fills: [], ...state, observedAt: now,
    acquisition: { version: 1, startedAt: now, completedAt: now, checkedOrders: [],
      sources: ['orders', 'positions', 'fills', 'targeted_orders'].map(source => ({ source, startedAt: now, completedAt: now,
        completeness: 'complete', reason: null, since: source === 'fills' ? 0 : null })) } };
}
