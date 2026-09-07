import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationProvider } from '@/lib/navigation';
import { AdaptiveRiskPage } from '@/features/risk-analytics/adaptive-risk';
import { RouteOverview } from '@/app/workflow/route-overview';
import type { WorkflowRoute, WorkflowRouteTopology } from '@/app/workflow/workflow-routes';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), ...api }));
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, '', '/risk/adaptive'); });
afterEach(cleanup);

describe('route selection evidence', () => {
  it('shows ordered fallback choices separately from direct and parallel paths, then focuses the chosen route', () => {
    const accounts = ['primary', 'backup', 'parallel', 'direct'].map(id => ({ id, name: id, detail: 'testnet' }));
    const candidate = (id: string, rank: number): WorkflowRoute['fallbackAccounts'][number] => ({ accountId: id, accountName: id, accountDetail: 'testnet', rank, enabled: true, fallbackOn: rank === 0 ? ['SYMBOL_UNAVAILABLE'] : [] });
    const base: WorkflowRoute = { id: 'fallback', enabled: true, channelId: 'source', channelName: 'Source', accountId: 'primary', accountName: 'primary', accountDetail: 'testnet', strategyName: 'Strategy', nodeIds: ['source', 'parser', 'account'], nodeNames: ['Source', 'Parser', 'Account'], fallbackAccounts: [candidate('primary', 0), candidate('backup', 1)] };
    const parallel = { ...base, id: 'parallel-one', accountId: 'parallel', accountName: 'parallel', fallbackAccounts: [candidate('parallel', 0)] };
    const direct = { ...base, id: 'direct', accountId: 'direct', accountName: 'direct', fallbackAccounts: [candidate('direct', 0)] };
    const topology: WorkflowRouteTopology = { accounts, channels: [{ id: 'source', name: 'Source' }], routes: [base, parallel, direct], crossProducts: [], nodeUsage: new Map(), edgeUsage: new Map(), matrix: [
      { channelId: 'source', accountId: 'primary', routes: [base] }, { channelId: 'source', accountId: 'backup', routes: [base] },
      { channelId: 'source', accountId: 'parallel', routes: [parallel, { ...parallel, id: 'parallel-two' }] }, { channelId: 'source', accountId: 'direct', routes: [direct] },
    ] };
    const focus = vi.fn(); const open = vi.fn();
    render(<RouteOverview open topology={topology} selectedPathId={null} onFocusPath={focus} onOpenChange={open} />);
    const table = screen.getByRole('table', { name: 'Kanal-zu-Konto-Matrix' });
    for (const [id, label] of [['primary', '1. Wahl'], ['backup', '2. Wahl'], ['parallel', '2 Pfade'], ['direct', 'direkt']]) {
      expect(within(table).getByRole('button', { name: `Source auf ${id} hervorheben` })).toHaveTextContent(label);
    }
    expect(screen.getByText(/^Exklusive Reihenfolge:/)).toHaveTextContent('1. primary');
    expect(screen.getByText(/^Exklusive Reihenfolge:/)).toHaveTextContent('2. backup');
    fireEvent.click(within(table).getByRole('button', { name: 'Source auf backup hervorheben' }));
    expect(focus).toHaveBeenCalledExactlyOnceWith('fallback');
    expect(open).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe('adaptive risk original evidence', () => {
  it('distinguishes zero-based runtime tiers from missing fixed tiers and keeps evaluation links scoped', async () => {
    api.jsonRequest.mockResolvedValue({ observedAt: 1000, hasMore: false, entries: [{ stateKey: 'scope/1', accountName: 'Account', mode: 'testnet', channelId: 'source', currentTier: 0, lockedTier: null, blocked: false, latestEvaluationId: 'evaluation/1' }] });
    render(<NavigationProvider><AdaptiveRiskPage /></NavigationProvider>);
    expect(await screen.findByText('Stufe 1')).toBeVisible();
    expect(screen.getByText('nicht festgehalten')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Alle Auswertungen dieses Scopes' })).toHaveAttribute('href', '/risk/adaptive?kind=evaluations&stateKey=scope%2F1');
    expect(screen.getByRole('link', { name: 'Letzte Auswertung dieser Policy' })).toHaveAttribute('href', '/risk/adaptive?kind=evaluations&id=evaluation%2F1');
  });

  it.each(['evaluations', 'legacy-evaluations'])('keeps invalidated %s distinct from current approval and reads original evidence explicitly', async kind => {
    window.history.replaceState(null, '', `/risk/adaptive?kind=${kind}&channelId=source`);
    api.jsonRequest.mockImplementation(async (url: string) => url.includes('kind=sources')
      ? { sourceAvailable: false, reason: 'Original source no longer available' }
      : { observedAt: 1000, entries: [{ id: 'evaluation/1', previousTier: 0, recommendedTier: 1, appliedTier: 0, invalidatedAt: 1000, action: 'held', closedTrades: 0 }] });
    render(<NavigationProvider><AdaptiveRiskPage /></NavigationProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Eine frühere Empfehlung ist keine aktuelle Freigabe.');
    fireEvent.click(screen.getByRole('button', { name: 'Originale Datenbasis öffnen' }));
    expect(await screen.findByText('Original source no longer available')).toBeVisible();
    const read = api.jsonRequest.mock.calls.find(([url]) => url.includes('kind=sources'))![0];
    expect(read).toContain('id=evaluation%2F1');
    expect(read.includes('channelId=source')).toBe(kind === 'legacy-evaluations');
    fireEvent.click(screen.getByRole('button', { name: 'Originale Datenbasis schließen' }));
    expect(screen.queryByText('Original source no longer available')).not.toBeInTheDocument();
  });

  it('copies a blocked legacy policy only after review and identifies the saved draft without activation', async () => {
    window.history.replaceState(null, '', '/risk/adaptive?kind=legacy');
    api.jsonRequest.mockImplementation(async (_url: string, init?: RequestInit) => init?.method
      ? { resource: { id: 'draft/1', resourceId: 'policy/1' }, alreadyCopied: false }
      : { entries: [{ policy: { channelId: 'source', blocked: true, policyVersion: 3 }, configuration: { manuallyBlocked: true }, copyHash: 'reviewed-policy' }] });
    render(<NavigationProvider><AdaptiveRiskPage /></NavigationProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Als Workflowentwurf übernehmen' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Eine bestehende Sperre bleibt als manuelle Sperre erhalten.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Geprüften Entwurf anlegen' }));
    expect(await screen.findByText(/Entwurf gespeichert; nicht aktiviert/)).toBeVisible();
    const writes = api.jsonRequest.mock.calls.filter(([, init]) => init?.method);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('/api/trading/risk/adaptive/copy-legacy');
    expect(JSON.parse(writes[0][1].body)).toEqual({ channelId: 'source', copyHash: 'reviewed-policy' });
    expect(screen.getByRole('link', { name: 'Ressourcenentwurf öffnen' })).toHaveAttribute('href', '/workflows/resources/policy%2F1/versions/draft%2F1');
  });
});
