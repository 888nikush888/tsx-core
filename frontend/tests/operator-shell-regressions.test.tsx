import { fixtureValue } from "./fixture-value";
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperatorApp } from '@/app/operator-app';
import { NavigationProvider } from '@/lib/navigation';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), ...api }));
// Route views have separate suites. This seam exposes the shell's permission contract and refresh callback.
vi.mock('@/app/operator-page', () => ({ OperatorPage: ({ readOnly, onRefresh, catalog }: Readonly<{
  readOnly: boolean; onRefresh: () => Promise<void>; catalog: { exchanges: unknown[] } | null;
}>) => <><button disabled={readOnly} onClick={() => { onRefresh(); }}>Edit routed view</button>
  <output data-testid="catalog-state">{catalog ? `ready:${catalog.exchanges.length}` : 'unavailable'}</output></> }));

beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, '', '/operations/jobs'); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
afterEach(cleanup);
async function refresh() {
  await act(() => new Promise<void>((resolve) => {
    document.dispatchEvent(new Event('visibilitychange'));
    resolve();
  }));
}

describe('operator shell permission and connection evidence', () => {
  it('dispatches refresh immediately and preserves rejected dispatch errors', async () => {
    const observed = vi.fn();
    document.addEventListener('visibilitychange', observed, { once: true });
    const pending = refresh();
    expect(observed).toHaveBeenCalledOnce();
    await pending;

    const error = new Error('visibility dispatch failed');
    const dispatch = vi.spyOn(document, 'dispatchEvent').mockImplementation(() => { throw error; });
    await expect(refresh()).rejects.toBe(error);
    dispatch.mockRestore();
  });

  it('clears a previously loaded exchange catalog when its next read fails', async () => {
    window.history.replaceState(null, '', '/trading/accounts');
    let catalogReads = 0;
    api.jsonRequest.mockImplementation((url: string) => {
      if (url === '/api/exchanges/catalog') {
        catalogReads += 1;
        return catalogReads === 1
          ? { implementation: { library: 'ccxt', version: '4.5.75' }, exchanges: [{ id: 'paper', status: 'certified', modes: ['paper'] }] }
          : Promise.reject(new Error('catalog unavailable'));
      }
      if (url === '/api/recovery') return { session: { role: 'admin' } };
      return {};
    });
    render(<NavigationProvider><OperatorApp /></NavigationProvider>);
    await waitFor(() => expect(screen.getByTestId('catalog-state')).toHaveTextContent('ready:1'));
    await refresh();
    await waitFor(() => expect(screen.getByTestId('catalog-state')).toHaveTextContent('unavailable'));
    expect(screen.getByRole('alert')).toHaveTextContent('catalog: catalog unavailable');
  });

  it('starts with unknown global gates and read-only views until admin evidence arrives', async () => {
    let resolveSession!: (value: unknown) => void;
    api.jsonRequest.mockImplementation((url: string) => url === '/api/recovery' ? new Promise(resolve => { resolveSession = resolve; }) : Promise.resolve({}));
    render(<NavigationProvider><OperatorApp /></NavigationProvider>);
    expect(screen.getByText(/Neue Entries: unbekannt · Live-Erlaubnis: unbekannt/)).toBeVisible();
    expect(screen.getByText(/Verbindung wird geprüft/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit routed view' })).toBeDisabled();
    expect(screen.getByRole('main').tagName).toBe('MAIN');
    await act(() => resolveSession({ session: { role: 'admin', actorId: 'fixture-admin' }, backendVersion: 'fixture' }));
    expect(screen.getByRole('button', { name: 'Edit routed view' })).toBeEnabled();
    expect(screen.getByText(/Backend fixture.*verbunden/)).toBeVisible();
  });

  it.each([true, false])('keeps global execution/live %s separate from account and trade proof', async enabled => {
    api.jsonRequest.mockImplementation((url: string) => url === '/api/recovery'
      ? { session: { role: 'viewer' }, backendVersion: 'fixture', active: true }
      : { overview: { runtime: { executionEnabled: enabled, liveTradingEnabled: enabled } } });
    render(<NavigationProvider><OperatorApp /></NavigationProvider>);
    const detail = enabled ? 'Neue Entries: global erlaubt · Live-Erlaubnis: global erlaubt; Kontomodus separat prüfen' : 'Neue Entries: global pausiert · Live-Erlaubnis: global gesperrt';
    expect(await screen.findByText(text => text.startsWith(detail))).toHaveTextContent('Bestehende Exposition und Schutz sind gesonderte Nachweise.');
    expect(screen.getByRole('button', { name: 'Edit routed view' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Reparatureinstieg öffnen' })).toHaveAttribute('href', '/recovery');
    api.jsonRequest.mockRejectedValue(new Error('Session unavailable'));
    await refresh();
    expect(await screen.findByText(/Backend fixture.*Verbindung gestört/)).toBeVisible();
    expect(screen.getByText(text => text.startsWith(detail))).toBeVisible();
    expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('Vorhandene Daten können veraltet sein'))).toBe(true);
  });

  it('leaves the builder to provide its own main landmark', async () => {
    window.history.replaceState(null, '', '/workflows/builder');
    api.jsonRequest.mockResolvedValue({ session: { role: 'admin' } });
    render(<NavigationProvider><OperatorApp /></NavigationProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit routed view' })).toBeEnabled());
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
  });

  it('searches through a private header, follows result paging and clears the term after closing', async () => {
    api.jsonRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/ui/search')) return { groups: [
        { kind: 'resources', observedAt: 1000, hasMore: true, nextCursor: 'next-search', entries: [{ id: 'result-id', title: 'Matching resource', url: '/workflows/resources/family' }] },
        { kind: 'accounts', observedAt: 1000, hasMore: false, entries: [] },
      ] };
      return { session: { role: 'viewer' } };
    });
    render(<NavigationProvider><OperatorApp /></NavigationProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Global suchen' }));
    expect(await screen.findByText('Mindestens zwei Zeichen eingeben.')).toBeVisible();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Matching resource' } });
    expect(await screen.findByRole('link', { name: 'Matching resource' })).toBeVisible();
    expect(screen.getByText('Keine Treffer für diese Auswahl.')).toBeVisible();
    const request = fixtureValue(api.jsonRequest.mock.calls.find(([url]) => url.startsWith('/api/ui/search')), 'search read request');
    expect(request[0]).not.toContain('Matching');
    expect(request[1].headers['X-UI-Search']).toBe('Matching%20resource');
    expect(window.location.search).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Treffer: Ressourcen' }));
    await waitFor(() => expect(api.jsonRequest.mock.calls.some(([url]) => url.includes('cursor=next-search'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Erste Trefferseite' }));
    await screen.findByRole('link', { name: 'Matching resource' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Matching resource' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Global suchen' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });
});
