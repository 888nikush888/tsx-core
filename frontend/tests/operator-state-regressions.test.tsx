import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { NavigationProvider } from '@/lib/navigation';
import { Accounts } from '@/features/accounts/accounts';
import { Overview } from '@/features/cockpit/overview';
import { Mcp } from '@/features/mcp/mcp-agents';
import type { ExchangeCatalog, TradingSnapshot } from '@/app/workflow/types';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), ...api }));
vi.mock('@/features/risk-analytics/equity-chart', () => ({ EquityChart: () => null }));

const now = 1_780_000_000_000;
const account = { id: 'exchange-account', name: 'Test account', exchange: 'bybit', mode: 'testnet', status: 'ready', enabled: true,
  maxConcurrentPositions: 4, updatedAt: now, killSwitchActive: false, killSwitchReason: null, lastReconciledAt: now, lastError: null };
const catalog = { exchanges: [{ id: 'bybit', name: 'Bybit', status: 'certified', provider: 'ccxt', modes: ['testnet', 'live'],
  credentialFields: [{ id: 'apiKey', label: 'Replacement identifier', secret: false }, { id: 'apiSecret', label: 'Replacement secret', secret: true }] }] } as ExchangeCatalog;
function trading(overrides: Record<string, unknown> = {}): TradingSnapshot {
  return { accounts: [account], accountIncidents: [], overview: { runtime: { executionEnabled: true, liveTradingEnabled: true, killSwitchActive: false } },
    intents: [], activity: { positions: [], orders: [], riskEvents: [] }, equityHistory: [], fallbackRuns: [], ...overrides } as TradingSnapshot;
}
function mount(element: ReactNode) { return render(<NavigationProvider>{element}</NavigationProvider>); }
function writes() { return api.jsonRequest.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET'); }
async function confirmDialog(name: string) {
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name, exact: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  window.history.replaceState(null, '', '/');
  api.jsonRequest.mockImplementation(async (url: string) => {
    if (url === '/api/operations') return { operations: { backup: { healthy: false }, audit: { healthy: false } } };
    if (url === '/api/access') return { role: 'admin', remoteAccess: { connected: false } };
    return {};
  });
});
afterEach(cleanup);

describe('account command intent and status evidence', () => {
  it.each([
    ['Verifizieren', '/api/trading/accounts/verify', { id: account.id }],
    ['Abgleichen', '/api/trading/reconcile', { accountId: account.id }],
    ['Deaktivieren', '/api/trading/accounts/state', { id: account.id, enabled: false }],
    ['Sperren', '/api/trading/accounts/configuration', { id: account.id, killSwitchActive: true, killSwitchReason: 'Manuell im Builder gesperrt' }],
  ])('sends the exact account intent for %s only once', async (label, url, payload) => {
    const refresh = vi.fn(() => Promise.resolve());
    mount(<Accounts trading={trading()} catalog={catalog} onRefresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: String(label), exact: true }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe(url);
    expect(writes()[0][1].method).toBe('POST');
    expect(JSON.parse(writes()[0][1].body)).toEqual(payload);
  });

  it('retains accepted verification when refreshing fails, without repeating the command', async () => {
    mount(<Accounts trading={trading()} catalog={catalog} onRefresh={async () => { throw new Error('Observation unavailable'); }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verifizieren' }));
    expect(await screen.findByText(/Command bestätigt.*Nachladen fehlgeschlagen: Observation unavailable/)).toBeVisible();
    expect(writes()).toHaveLength(1);
  });

  it('distinguishes isolated accounts, kill-switch evidence and critical versus warning incidents', () => {
    mount(<Accounts trading={trading({ accounts: [
      { ...account, killSwitchActive: true, killSwitchReason: null, lastError: 'Protection evidence missing' },
      { ...account, id: 'waiting', name: 'Waiting account', enabled: false, status: 'unverified' },
    ], accountIncidents: [
      { id: 'critical', accountId: account.id, severity: 'critical', status: 'resolved', message: 'Critical observation', category: 'protection', occurrenceCount: 1, lastSeenAt: now },
      { id: 'warning', accountId: 'waiting', severity: 'warning', status: 'resolved', message: 'Warning observation', category: 'transport', occurrenceCount: 2, lastSeenAt: now },
    ] })} catalog={catalog} onRefresh={() => Promise.resolve()} />);
    expect(screen.getByText('gesperrt')).toHaveClass('danger');
    expect(screen.getByText('unverified')).not.toHaveClass('healthy', 'danger');
    expect(screen.getByText('Kontosperre aktiv')).toBeVisible();
    expect(screen.getByText('Protection evidence missing')).toBeVisible();
    expect(screen.getByText('kritisch')).toBeVisible();
    expect(screen.getByText('Warnung')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Aktivieren' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & freigeben' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('zwei vollständige Börsenabgleiche');
    expect(screen.getByRole('button', { name: 'Prüfen und freigeben' })).toBeDisabled();
  });

  it('keeps credential replacement explicit, clears a cancelled editor and sends only replacement fields', async () => {
    const refresh = vi.fn(() => Promise.resolve());
    mount(<Accounts trading={trading()} catalog={catalog} onRefresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keys ersetzen' }));
    expect(screen.getByLabelText('Replacement secret')).toHaveAttribute('type', 'password');
    fireEvent.change(screen.getByLabelText('Replacement identifier'), { target: { value: 'fixture-id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Keys ersetzen' }));
    expect(screen.getByLabelText('Replacement identifier')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Replacement secret'), { target: { value: 'fixture-only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & ersetzen' }));
    expect(writes()).toHaveLength(0);
    await confirmDialog('Zugangsdaten ersetzen');
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe('/api/trading/accounts/credentials');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ id: account.id, credentials: { apiSecret: 'fixture-only' } });
    expect(screen.queryByLabelText('Replacement secret')).not.toBeInTheDocument();
  });

  it('requires typed account deletion confirmation before issuing DELETE', async () => {
    const refresh = vi.fn(() => Promise.resolve());
    mount(<Accounts trading={trading()} catalog={catalog} onRefresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Konto entfernen' })).toBeDisabled();
    expect(writes()).toHaveLength(0);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'KONTO ENTFERNEN' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Konto entfernen' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe('/api/trading/accounts');
    expect(writes()[0][1].method).toBe('DELETE');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ id: account.id });
  });
});

describe('cockpit evidence state distinctions', () => {
  it('shows unhealthy backup/audit sources separately from enabled execution and live gates', async () => {
    mount(<Overview trading={trading()} systemStatus={{ connectionState: 'connected' }} onRefresh={() => Promise.resolve()} />);
    expect(await screen.findByText('nicht verbunden')).toBeVisible();
    expect(screen.getAllByText('gestört')).toHaveLength(2);
    expect(screen.getByText('Einträge aktiv')).toBeVisible();
    expect(screen.getByText('freigegeben')).toBeVisible();
    expect(writes()).toHaveLength(0);
  });

  it('keeps probing, selected, exhausted and stopped fallback evidence distinct', async () => {
    const runs = [
      { status: 'probing', stopReason: null, expected: 'wird geprüft', badge: '' },
      { status: 'selected', stopReason: null, expected: 'Konto gewählt', badge: 'healthy' },
      { status: 'exhausted', stopReason: null, expected: 'Kette ausgeschöpft: kein Kandidat', badge: 'danger' },
      { status: 'exhausted', stopReason: 'SYMBOL_UNAVAILABLE', expected: 'Kette ausgeschöpft: SYMBOL_UNAVAILABLE', badge: 'danger' },
      { status: 'stopped', stopReason: null, expected: 'gestoppt: Schutzregel', badge: 'danger' },
      { status: 'stopped', stopReason: 'RISK_BLOCKED', expected: 'gestoppt: RISK_BLOCKED', badge: 'danger' },
    ];
    mount(<Overview trading={trading({ fallbackRuns: runs.map((run, index) => ({
      id: String(index), channelId: `channel-${index}`, sourceSignalId: `signal/${index}`, status: run.status, stopReason: run.stopReason,
      candidates: [{ rank: 0, accountName: 'Primary', status: 'unavailable', fallbackOn: ['SYMBOL_UNAVAILABLE'], errorCode: 'SYMBOL_UNAVAILABLE' },
        { rank: 1, accountName: 'Backup', status: 'pending', fallbackOn: [], errorCode: null }],
    })) })} systemStatus={null} onRefresh={() => Promise.resolve()} />);
    await screen.findByText('nicht verbunden');
    for (const run of runs) {
      const badge = screen.getByText(run.expected);
      expect(badge).toBeVisible();
      expect(badge.className.trim()).toBe(`state-badge ${run.badge}`.trim());
    }
    expect(screen.getAllByText(/2\. Backup \(pending\) · Ende der Kette/)).toHaveLength(runs.length);
    expect(screen.getAllByRole('link', { name: 'Ursprüngliches Signal und Eingangsspur' })[0]).toHaveAttribute('href', '/signals/processed/signal%2F0');
  });
});

describe('MCP runtime confirmation and action outcomes', () => {
  function mcpSnapshot(mode: string) {
    return { runtime: { mode }, agents: [], actions: [
      { id: 'success', outcome: 'succeeded', toolName: 'Read summary', completedAt: now },
      { id: 'failure', outcome: 'failed', toolName: 'Rejected command', completedAt: now },
      { id: 'unknown', outcome: 'unknown', toolName: 'Unconfirmed command', completedAt: now },
    ] };
  }

  it.each([
    ['active', 'standby', 'set-mcp-runtime-active'],
    ['disabled', 'standby', 'set-mcp-runtime-disabled'],
    ['standby', 'active', undefined],
  ])('binds the runtime %s command to its reviewed confirmation header', async (mode, initialMode, confirmation) => {
    api.jsonRequest.mockResolvedValue(mcpSnapshot(initialMode));
    mount(<Mcp />);
    await screen.findByText('Read summary');
    expect(screen.getByText('succeeded')).toHaveClass('healthy');
    expect(screen.getByText('failed', { selector: '.state-badge' })).toHaveClass('danger');
    expect(screen.getByText('unknown')).not.toHaveClass('healthy', 'danger');
    fireEvent.click(screen.getByRole('button', { name: initialMode, exact: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: mode, exact: true }));
    await screen.findByRole('dialog');
    expect(writes()).toHaveLength(0);
    await confirmDialog('Modus ändern');
    await screen.findByText(/Änderung bestätigt/);
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe('/api/mcp/runtime');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ mode });
    expect(writes()[0][1].headers['X-Destructive-Confirmation']).toBe(confirmation);
  });

  it('does not change MCP runtime after cancelling the confirmation', async () => {
    api.jsonRequest.mockResolvedValue(mcpSnapshot('standby'));
    mount(<Mcp />);
    await screen.findByText('Read summary');
    fireEvent.click(screen.getByRole('button', { name: 'disabled', exact: true }));
    await confirmDialog('Abbrechen');
    expect(writes()).toHaveLength(0);
  });
});
