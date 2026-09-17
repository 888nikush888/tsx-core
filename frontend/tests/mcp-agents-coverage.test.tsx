import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mcp } from '@/features/mcp/mcp-agents';
import { NavigationProvider } from '@/lib/navigation';
import { IssuedCredentialNotice } from '@/shared/components/issued-credential';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', () => api);

const agent = { id: 'auditor', name: 'Auditor', enabled: true, permissions: ['trading.read'], eventSubscriptions: ['signal_received'], updatedAt: 10 };
const other = { ...agent, id: 'backup', name: 'Backup', enabled: false };
function snapshot() {
  return { agents: [agent, other], permissions: ['trading.read', 'trading.write'], eventTypes: ['signal_received', 'position_closed'],
    runtime: { mode: 'standby' }, endpoint: '/mcp', interpretation: 'Operator evidence', proposals: [], sessions: [], actions: [] };
}
function mount(search = '') {
  window.history.replaceState(null, '', `/integrations/mcp${search}`);
  render(<NavigationProvider><Mcp /><IssuedCredentialNotice /></NavigationProvider>);
}
function writes() { return api.jsonRequest.mock.calls.filter(([, options]) => options?.method); }
async function dialogClick(label: string) {
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: label, exact: true }));
}
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  api.jsonRequest.mockResolvedValue(snapshot());
});
afterEach(() => {
  const close = screen.queryByRole('button', { name: 'Sicher gespeichert · Anzeige schließen' });
  if (close) fireEvent.click(close);
  cleanup();
});

describe('MCP agent editor and command behavior', () => {
  it('creates an agent with reviewed permissions, subscriptions and enabled state, then exposes its issued token', async () => {
    let created: typeof agent | undefined;
    api.jsonRequest.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method) {
        created = { ...JSON.parse(String(options.body)), id: 'created', updatedAt: 20 };
        return { agent: created, token: 'fixture-created-token' };
      }
      return { ...snapshot(), agents: created ? [created] : [] };
    });
    mount();
    await screen.findByText('Operator evidence');
    expect(screen.getByText('Noch keine MCP-Agenten.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Agent', exact: true }));
    await screen.findByRole('heading', { name: 'Agent erstellen' });
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    expect(screen.getByLabelText('trading.read')).toBeChecked();
    expect(screen.getByLabelText('trading.write')).not.toBeChecked();
    expect(screen.getByLabelText('signal_received')).toBeChecked();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Created agent' } });
    fireEvent.click(screen.getByLabelText('trading.read'));
    fireEvent.click(screen.getByLabelText('trading.write'));
    fireEvent.click(screen.getByLabelText('signal_received'));
    fireEvent.click(screen.getByLabelText('Agent aktiviert'));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('fixture-created-token')).toBeVisible();
    await screen.findByRole('heading', { name: 'Agent bearbeiten' });
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe('/api/mcp/agents');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ name: 'Created agent', enabled: false, permissions: ['trading.write'],
      eventSubscriptions: ['exchange_ack', 'first_fill', 'position_closed', 'kill_switch_activated'] });
    expect(window.location.search).toBe('?agentId=created');
    expect(screen.queryByText(/Ungespeicherte Änderungen ·/)).not.toBeInTheDocument();
  });

  it('preserves a draft on cancelled navigation and discards it before selecting another agent', async () => {
    mount('?agentId=auditor');
    await screen.findByDisplayValue('Auditor');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unsaved auditor' } });
    expect(screen.getByLabelText('Vorschlagsstatus')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Backup/ }));
    await dialogClick('Abbrechen');
    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved auditor');
    expect(window.location.search).toBe('?agentId=auditor');
    fireEvent.click(screen.getByRole('button', { name: 'Agent', exact: true }));
    await dialogClick('Abbrechen');
    expect(screen.getByRole('heading', { name: 'Agent bearbeiten' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Backup/ }));
    await dialogClick('Verwerfen');
    await screen.findByDisplayValue('Backup');
    expect(screen.getByLabelText('Agent aktiviert')).not.toBeChecked();
    expect(window.location.search).toBe('?agentId=backup');
    expect(writes()).toHaveLength(0);
  });

  it('compares both server and draft policy before rebasing an edit onto the latest revision', async () => {
    let current = agent;
    api.jsonRequest.mockImplementation((_url: string, options?: RequestInit) => options?.method
      ? { agent: { ...current, updatedAt: 30 } } : { ...snapshot(), selectedAgent: current });
    mount('?agentId=auditor');
    await screen.findByDisplayValue('Auditor');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Draft name' } });
    fireEvent.click(screen.getByLabelText('Agent aktiviert'));
    current = { ...agent, name: 'Server name', updatedAt: 20 };
    fireEvent(document, new Event('visibilitychange'));
    const conflict = await screen.findByRole('alert');
    expect(conflict).toHaveTextContent('Server name · aktiv');
    expect(conflict).toHaveTextContent('Draft name · inaktiv');
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Verglichen: Entwurf auf neuen Stand anwenden' }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await screen.findByText(/Änderung bestätigt/);
    expect(writes()[0][0]).toBe('/api/mcp/agents/update');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ id: agent.id, name: 'Draft name', enabled: false, baseUpdatedAt: 20,
      permissions: ['trading.read'], eventSubscriptions: ['signal_received'] });
  });

  it('can resolve a conflict by accepting the inactive server policy', async () => {
    let current = agent;
    api.jsonRequest.mockImplementation(() => ({ ...snapshot(), selectedAgent: current }));
    mount('?agentId=auditor');
    await screen.findByDisplayValue('Auditor');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local name' } });
    current = { ...agent, name: 'Inactive server', enabled: false, updatedAt: 20 };
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Inactive server · inaktiv');
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf verwerfen und Server übernehmen' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Inactive server');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Ungespeicherte Änderungen ·/)).not.toBeInTheDocument();
  });

  it('requires confirmation for rotation and typed confirmation for revocation', async () => {
    let removed = false;
    api.jsonRequest.mockImplementation((url: string, options?: RequestInit) => {
      if (url.endsWith('/rotate')) return { token: 'fixture-rotated-token' };
      if (options?.method === 'DELETE') { removed = true; return { ok: true }; }
      return { ...snapshot(), agents: removed ? [] : [agent] };
    });
    mount('?agentId=auditor');
    await screen.findByDisplayValue('Auditor');
    fireEvent.click(screen.getByRole('button', { name: 'Token rotieren' }));
    await dialogClick('Abbrechen');
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Token rotieren' }));
    await dialogClick('Token rotieren');
    expect(await screen.findByText('fixture-rotated-token')).toBeVisible();
    expect(writes()[0][1].headers['X-Destructive-Confirmation']).toBe('rotate-mcp-agent-token');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ id: 'auditor' });
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    await dialogClick('Abbrechen');
    expect(writes()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Agent löschen' })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'DELETE' } });
    await dialogClick('Agent löschen');
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(writes()[1][1].method).toBe('DELETE');
    expect(writes()[1][1].headers['X-Destructive-Confirmation']).toBe('delete-mcp-agent');
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it.each([new Error('Policy denied'), 'Policy denied'])('retains the editable policy when saving fails: %s', async failure => {
    api.jsonRequest.mockImplementation((_url: string, options?: RequestInit) => options?.method ? Promise.reject(failure) : snapshot());
    mount('?agentId=auditor');
    await screen.findByDisplayValue('Auditor');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Retry draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Policy denied')).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveValue('Retry draft');
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeEnabled();
    expect(screen.queryByText(/Änderung bestätigt/)).not.toBeInTheDocument();
  });

  it('locks mutation controls while rotation is pending and retains the issued credential when refresh fails', async () => {
    let resolveRotation!: (result: { token: string }) => void;
    let refreshFails = false;
    api.jsonRequest.mockImplementation((_url: string, options?: RequestInit) => {
      if (options?.method) return new Promise(resolve => { resolveRotation = resolve; });
      return refreshFails ? Promise.reject('Refresh unavailable') : snapshot();
    });
    mount('?agentId=auditor');
    await screen.findByDisplayValue('Auditor');
    fireEvent.click(screen.getByRole('button', { name: 'Token rotieren' }));
    await dialogClick('Token rotieren');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Token rotieren' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Löschen' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'active', exact: true })).toBeDisabled();
    refreshFails = true;
    resolveRotation({ token: 'fixture-retained-token' });
    expect(await screen.findByText('Refresh unavailable')).toBeVisible();
    expect(screen.getByText('fixture-retained-token')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Token rotieren' })).toBeEnabled();
    expect(writes()).toHaveLength(1);
  });

  it('resets proposal pagination on status changes and requires a reason to reject a pending proposal', async () => {
    api.jsonRequest.mockResolvedValue({ ...snapshot(), pages: { proposals: { hasMore: true, nextCursor: 'next-proposal' } },
      proposals: [{ id: 'proposal/one', action: 'Change policy', status: 'pending', expiresAt: 10, preflight: { blockers: ['Needs review'] } },
        { id: 'done', action: 'Past change', status: 'completed', expiresAt: 10, preflight: null }],
      sessions: [{ id: 'one', agentId: 'fallback-agent', clientName: 'CLI', lastSeenAt: 10 },
        { id: 'two', agentName: 'Auditor', clientName: 'Console', disconnectedAt: 20, lastSeenAt: 10 }] });
    mount('?proposalsCursor=old');
    await screen.findByText('Needs review');
    expect(screen.getAllByRole('link', { name: 'Prüfen & entscheiden' })[0]).toHaveAttribute('href', '/integrations/mcp/proposals/proposal%2Fone');
    expect(screen.getByText(/fallback-agent · CLI · verbunden/)).toBeVisible();
    expect(screen.getByText(/Auditor · Console · getrennt/)).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Ablehnen' })[1]).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Vorschläge' }));
    await waitFor(() => expect(window.location.search).toBe('?proposalsCursor=next-proposal'));
    await screen.findByText('Needs review');
    fireEvent.click(screen.getByRole('button', { name: 'Erste Vorschläge' }));
    await waitFor(() => expect(window.location.search).toBe(''));
    await screen.findByText('Needs review');
    fireEvent.change(screen.getByLabelText('Vorschlagsstatus'), { target: { value: 'all' } });
    await waitFor(() => expect(window.location.search).toBe('?proposalsStatus=all'));
    await screen.findByText('Needs review');
    fireEvent.click(screen.getAllByRole('button', { name: 'Ablehnen' })[0]);
    await dialogClick('Abbrechen');
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Ablehnen' })[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Ablehnen' })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Outside approved policy' } });
    await dialogClick('Ablehnen');
    await screen.findByText(/Änderung bestätigt/);
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe('/api/mcp/proposals/reject');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ id: 'proposal/one', reason: 'Outside approved policy' });
  });
});
