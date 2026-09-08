import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { NavigationProvider } from '@/lib/navigation';
import { OperatorReadOnlyContext } from '@/shared/api/operator-session';
import { CapabilitiesPage } from '@/features/operations/capabilities';
import { SignalsPage } from '@/features/signals/signals-page';
import { TestLab } from '@/features/workflows/test-lab';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), ...api }));
const observedAt = 1_780_000_000_000;
function mount(element: ReactNode, readOnly = false) {
  return render(<NavigationProvider><OperatorReadOnlyContext.Provider value={readOnly}>{element}</OperatorReadOnlyContext.Provider></NavigationProvider>);
}
function writes() { return api.jsonRequest.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET'); }
async function refresh() { await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); }
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, '', '/'); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
afterEach(cleanup);

describe('capability and parameter directory contracts', () => {
  it('separates secret, editable and fixed parameters and preserves explicit default values', async () => {
    window.history.replaceState(null, '', '/operations/capabilities?view=parameters');
    const defaults = [null, '', { maximum: 0 }, false, 0, undefined];
    api.jsonRequest.mockResolvedValue({ contractVersion: 1, total: defaults.length, hasMore: false, entries: defaults.map((value, index) => ({
      path: `runtime.field${index}`, type: typeof value, unit: index === 0 ? 'ms' : null, defaultPresent: index !== 5, default: value,
      editable: index === 1, secret: index === 0, requiresRestart: false, href: `/operations/settings?setting=runtime.field${index}`,
    })) });
    mount(<CapabilitiesPage />);
    await screen.findByRole('heading', { name: 'runtime.field0' });
    const articles = screen.getAllByRole('article');
    expect(articles.map(article => within(article).getByText('Vorlage / Default').nextElementSibling?.textContent)).toEqual([
      'null', 'leer', '{"maximum":0}', 'false', '0', 'Kein Wert vorgegeben; Pflichtfeld oder bedingter Validatorstandard.',
    ]);
    expect(articles[0]).toHaveTextContent('Separater Secretcommand; gespeicherter Inhalt bleibt verborgen');
    expect(articles[1]).toHaveTextContent('Im verlinkten Formular');
    expect(articles[2]).toHaveTextContent('Original, Deployment oder feste Sicherheitsgrenze');
    expect(within(articles[0]).getByRole('link')).toHaveAttribute('href', '/operations/settings?setting=runtime.field0');
  });

  it('resets cursors when changing the directory filter and shows action blockers without enabling commands', async () => {
    api.jsonRequest.mockResolvedValue({ contractVersion: 1, total: 2, hasMore: true, nextCursor: 'more', entries: [
      { route: 'POST /fixture/blocked', label: 'Blocked capability', currentBlockers: ['Missing evidence'], href: '/operations/settings' },
      { route: 'POST /fixture/available', label: 'Available capability', currentBlockers: [], href: '/workflows/builder' },
    ] });
    mount(<CapabilitiesPage />);
    expect(await screen.findByText('Missing evidence')).toBeVisible();
    expect(screen.getByText(/Keine allgemeine Sperre beobachtet/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Einträge' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('cursor')).toBe('more'));
    fireEvent.change(screen.getByLabelText('Bereich'), { target: { value: 'operations' } });
    await screen.findByRole('heading', { name: 'Blocked capability' });
    expect(new URLSearchParams(window.location.search).has('cursor')).toBe(false);
    expect(api.jsonRequest.mock.calls.at(-1)?.[0]).toContain('area=operations');
    fireEvent.change(screen.getByLabelText('Bereich'), { target: { value: '' } });
    await screen.findByRole('heading', { name: 'Blocked capability' });
    expect(new URLSearchParams(window.location.search).has('area')).toBe(false);
    expect(writes()).toHaveLength(0);
  });
});

describe('signal read routes and explicit delivery recovery', () => {
  const entry = { id: 'signal/1', channelId: 'source', messageId: '42', status: 'unknown', createdAt: observedAt, targetChatId: 'target', attempts: 1, excerpt: 'Stored source text' };
  it.each([
    ['ingress', 'Dauerhafter Eingang & Alben', '/signals/messages/signal%2F1'],
    ['messages', 'Gespeicherte Nachrichten', '/signals/cache/signal%2F1'],
    ['processed', 'Parserergebnisse', '/signals/processed/signal%2F1'],
  ] as const)('opens %s evidence through its correct original-object route', async (kind, title, href) => {
    api.jsonRequest.mockResolvedValue({ entries: [entry], observedAt, hasMore: true, nextCursor: 'later' });
    mount(<SignalsPage kind={kind} />);
    expect(await screen.findByRole('link', { name: entry.id })).toHaveAttribute('href', href);
    expect(screen.getByRole('heading', { name: title })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Nächste Seite' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('cursor')).toBe('later'));
    fireEvent.change(screen.getByLabelText('Kanal'), { target: { value: 'other-channel' } });
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('channelId')).toBe('other-channel'));
    expect(new URLSearchParams(window.location.search).has('cursor')).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  it('keeps unknown deliveries read-only for viewers and explains unrecoverable evidence', async () => {
    api.jsonRequest.mockResolvedValue({ entries: [entry, { ...entry, id: 'review', status: 'needs_review' }], observedAt });
    mount(<SignalsPage kind="outbox" />);
    expect(await screen.findByRole('button', { name: 'Wiederholung prüfen' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Quittieren' })).toBeDisabled();
    expect(screen.getByText(/Originalnachweise ungeklärt/)).toBeVisible();
    expect(writes()).toHaveLength(0);
  });

  it('requires the duplicate-delivery warning and retains an unconfirmed retry without replay', async () => {
    api.jsonRequest.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method) throw new TypeError('Delivery response lost');
      return { entries: [entry], observedAt };
    });
    mount(<SignalsPage kind="outbox" readOnly={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Wiederholung prüfen' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Doppelversand');
    expect(within(dialog).getByRole('button', { name: 'Wiederholung beauftragen' })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'DOPPELVERSAND MÖGLICH' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Wiederholung beauftragen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Aktion nicht bestätigt; keine automatische Wiederholung: Delivery response lost');
    await refresh();
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe('/api/outbox/retry');
    expect(writes()[0][1].headers['X-Destructive-Confirmation']).toBe('retry-unknown-delivery');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ id: entry.id });
  });
});

describe('test laboratory boundaries', () => {
  const metadata = { observedAt, usageDay: '2026-09-07', paths: [{ id: 'path-1', channelId: 'source', accountId: 'account' }], limits: { maxInputChars: 1000 }, usage: {}, queue: {} };
  it('runs a local filter test with the explicit source/channel and exposes no trading approval', async () => {
    api.jsonRequest.mockImplementation(async (_url: string, init?: RequestInit) => init?.method ? { matched: true } : metadata);
    mount(<TestLab />);
    expect(screen.getByRole('button', { name: 'Lokalen Test ausführen' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Kanal-ID'), { target: { value: 'channel' } });
    fireEvent.change(screen.getByLabelText('Quelltext'), { target: { value: 'Sample signal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lokalen Test ausführen' }));
    expect(await screen.findByText(/Daraus folgt keine Handelsfreigabe/)).toBeVisible();
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe('/api/workflow/simulate');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ channelId: 'channel', text: 'Sample signal', contentType: 'text' });
  });

  it('validates XML against the selected published contract and preserves optional grounding text', async () => {
    window.history.replaceState(null, '', '/workflows/lab?mode=xml');
    api.jsonRequest.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method) return { valid: true };
      if (url === '/api/trading') return { signalContracts: [{ name: 'Signal contract', versions: [{ id: 'published', version: 3, status: 'published', definition: { shape: 'fixture' } }, { id: 'draft', status: 'draft' }] }] };
      return metadata;
    });
    mount(<TestLab />);
    await screen.findByRole('option', { name: 'Signal contract · v3 · published' });
    expect(screen.queryByRole('option', { name: /draft/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Veröffentlichte Vertragsversion'), { target: { value: 'published' } });
    fireEvent.change(screen.getByLabelText('XML'), { target: { value: '<signal />' } });
    fireEvent.change(screen.getByLabelText('Quelltext'), { target: { value: 'Grounding source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lokalen Test ausführen' }));
    await screen.findByRole('heading', { name: 'Lokales Prüfergebnis' });
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe('/api/trading/signal-contracts/validate');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ definition: { shape: 'fixture' }, xml: '<signal />', sourceText: 'Grounding source' });
  });

  it('pins a paid parser run to the reviewed preview and invalidates consent after source edits', async () => {
    window.history.replaceState(null, '', '/workflows/lab?mode=ai');
    api.jsonRequest.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/preview')) return { provider: 'Fixture provider', providerConfigured: true, externalDataPolicyAccepted: true, previewHash: 'reviewed-preview', observedAt, sourceChars: 6, sourceBytes: 6 };
      if (init?.method) return { job: { state: 'accepted' } };
      return metadata;
    });
    mount(<TestLab />);
    fireEvent.change(screen.getByLabelText('Quelltext'), { target: { value: 'Source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Provideraufruf vorbereiten' }));
    expect(await screen.findByRole('button', { name: 'KI-Test einmal beauftragen' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Quelltext'), { target: { value: 'Edited source' } });
    expect(screen.queryByRole('button', { name: 'KI-Test einmal beauftragen' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Provideraufruf vorbereiten' }));
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'KI-Test einmal beauftragen' }));
    expect(await screen.findByRole('heading', { name: 'Auftragsannahme' })).toBeVisible();
    const runs = writes().filter(([url]) => url === '/api/workflow/parser-test');
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0][1].body)).toMatchObject({ sourceText: 'Edited source', jobId: expect.any(String), previewHash: 'reviewed-preview', previewObservedAt: observedAt, externalDataConsent: true });
    expect(runs[0][1].headers['X-Destructive-Confirmation']).toBe('run-parser-test');
    expect(screen.getByText(/Nur der Auftrag ist angenommen/, { selector: 'p' })).toBeVisible();
  });
});
