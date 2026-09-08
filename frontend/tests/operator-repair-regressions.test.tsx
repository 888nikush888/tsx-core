import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { NavigationProvider } from '@/lib/navigation';
import { RecoveryPage } from '@/features/operations/recovery-page';
import { TelegramSettings } from '@/features/signals/telegram-settings';
import { ModelLibrary } from '@/features/workflows/model-library';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), ...api }));
function mount(element: ReactNode) { return render(<NavigationProvider>{element}</NavigationProvider>); }
function writes() { return api.jsonRequest.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET'); }
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, '', '/'); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
afterEach(cleanup);

describe('recovery repair revision contracts', () => {
  function repairResponse(url: string) {
    if (url === '/api/recovery') return { active: true, session: { role: 'admin' }, availableRepairs: ['config', 'runtime-settings', 'secrets'] };
    if (url === '/api/config') return { apiId: 42, configRevision: 6, xmlParsing: { primaryModel: 'fixture-model' } };
    if (url === '/api/runtime-settings') return { revision: 8, parameters: [], settings: { preserved: false } };
    return { secrets: { telegramApiHash: { configured: true, source: 'local', editable: true } } };
  }

  it.each([
    ['config', 'Grundkonfiguration speichern', '6'],
    ['runtime-settings', 'Runtime speichern', '8'],
    ['secrets', 'Secrets speichern', undefined],
  ] as const)('pins %s repairs to the applicable observed revision', async (kind, button, expectedRevision) => {
    api.jsonRequest.mockImplementation(async (url: string) => repairResponse(url));
    mount(<RecoveryPage />);
    const control = await screen.findByRole('button', { name: button });
    if (kind === 'secrets') {
      fireEvent.change(screen.getByLabelText(/telegramApiHash/), { target: { value: 'fixture-repair' } });
    }
    await waitFor(() => expect(control).toBeEnabled());
    fireEvent.click(control);
    expect(await screen.findByText(`${kind} gespeichert. Wirksamkeit nach geprüftem Neustart beobachten.`)).toBeVisible();
    expect(writes()).toHaveLength(1);
    const [url, init] = writes()[0];
    expect(url).toBe(`/api/${kind}`);
    expect(init.headers['If-Match']).toBe(expectedRevision);
    const expectedBodies = { config: { apiId: 42, xmlParsing: { primaryModel: 'fixture-model' } }, 'runtime-settings': { preserved: false }, secrets: { telegramApiHash: 'fixture-repair' } };
    expect(JSON.parse(init.body)).toEqual(expectedBodies[kind]);
    expect(api.jsonRequest.mock.calls.every(([address]) => ['/api/recovery', '/api/config', '/api/runtime-settings', '/api/secrets'].includes(address))).toBe(true);
  });

  it('shows completed recovery without inferring trading approval and keeps unavailable repairs disabled', async () => {
    api.jsonRequest.mockImplementation(async (url: string) => url === '/api/recovery'
      ? { active: false, session: { role: 'viewer' }, availableRepairs: [] } : repairResponse(url));
    mount(<RecoveryPage />);
    expect(await screen.findByText(/Recovery beendet; Betriebsfreigaben separat prüfen/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Cockpit öffnen' })).toHaveAttribute('href', '/cockpit');
    for (const name of ['Grundkonfiguration speichern', 'Runtime speichern', 'Secrets speichern', 'Kontrolliert neu starten']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(writes()).toHaveLength(0);
  });
});

describe('Telegram login contracts', () => {
  function loginResponse(prompt: Record<string, unknown>) {
    return async (url: string) => {
      if (url === '/api/status') return { connectionState: 'authentication-required', telegramLogin: { state: 'waiting', prompt } };
      if (url === '/api/secrets') return { secrets: { telegramApiHash: { configured: true }, openRouterApiKey: { configured: false } } };
      return { configRevision: 1 };
    };
  }

  it.each([
    ['tg://login?fixture=1', true],
    ['https://telegram.org/fixture', true],
    ['https://example.org/telegram.org/fixture', false],
    [undefined, false],
  ] as const)('only exposes approved other-device login URLs: %s', async (link, allowed) => {
    api.jsonRequest.mockImplementation(loginResponse({ kind: 'otherDeviceConfirmation', label: 'Device approval', link }));
    mount(<TelegramSettings />);
    await screen.findByText(/Telegram-Anmeldung · Device approval/);
    if (allowed) {
      expect(screen.getByRole('link', { name: 'In Telegram bestätigen' })).toHaveAttribute('href', link);
      expect(screen.getByRole('link', { name: 'In Telegram bestätigen' })).toHaveAttribute('rel', 'noreferrer');
    } else {
      expect(screen.getByText('Telegram-Link nicht als zulässiger Anmeldelink erkennbar.')).toBeVisible();
      expect(screen.queryByRole('link', { name: 'In Telegram bestätigen' })).not.toBeInTheDocument();
    }
    expect(writes()).toHaveLength(0);
  });

  it('sends the requested first/last name fields and clears only the accepted login draft', async () => {
    api.jsonRequest.mockImplementation(loginResponse({ kind: 'name', label: 'Registration' }));
    mount(<TelegramSettings />);
    fireEvent.change(await screen.findByLabelText('Vorname'), { target: { value: 'Fixture' } });
    fireEvent.change(screen.getByLabelText('Nachname'), { target: { value: 'Operator' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await screen.findByText(/Anmeldedaten angenommen/);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ firstName: 'Fixture', lastName: 'Operator' });
    expect(writes()[0][0]).toBe('/api/telegram-login');
    expect(screen.getByLabelText('Vorname')).toHaveValue('');
    expect(screen.getByLabelText('Nachname')).toHaveValue('');
    expect(screen.getByLabelText('Telegram API Hash · gespeichert')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('OpenRouter API Key · fehlt')).toHaveValue('');
  });

  it.each(['password', 'code'])('preserves an unconfirmed %s submission for explicit follow-up', async kind => {
    const read = loginResponse({ kind, label: 'Login response' });
    api.jsonRequest.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method) throw new Error('Login response unavailable');
      return read(url);
    });
    mount(<TelegramSettings />);
    const input = await screen.findByLabelText('Login response');
    expect(input).toHaveAttribute('type', kind === 'password' ? 'password' : 'text');
    fireEvent.change(input, { target: { value: 'fixture-login' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText('Nicht bestätigt. Keine automatische Wiederholung: Login response unavailable')).toBeVisible();
    expect(input).toHaveValue('fixture-login');
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ value: 'fixture-login' });
  });
});

describe('model library draft references', () => {
  it('pages model records and preserves encoded original model addresses', async () => {
    api.jsonRequest.mockResolvedValue({ entries: [{ id: 'model/1', name: 'Contract model', status: 'draft' }], hasMore: true, nextCursor: 'next-model', observedAt: 1000 });
    mount(<ModelLibrary kind="contract" />);
    expect(await screen.findByRole('link', { name: 'Contract model' })).toHaveAttribute('href', '/workflows/models/contract/model%2F1');
    fireEvent.click(screen.getByRole('button', { name: 'Nächste Seite' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('cursor')).toBe('next-model'));
    fireEvent.click(screen.getByRole('button', { name: 'Erste Seite' }));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(writes()).toHaveLength(0);
  });

  it('attaches the reviewed model as a draft without activating a graph or bypassing reference locks', async () => {
    const data = { model: { name: 'Contract model', status: 'published' }, reviewHash: 'reviewed-model-hash', resources: [], resourceCount: 1, activeReferenceCount: 1 };
    api.jsonRequest.mockImplementation(async (_url: string, init?: RequestInit) => init?.method
      ? { action: 'attach', resource: { id: 'draft/2', resourceId: 'family/2' } } : data);
    mount(<ModelLibrary kind="contract" id="model/1" />);
    const attach = await screen.findByRole('button', { name: 'Als Ressourcenentwurf übernehmen' });
    expect(screen.getByRole('button', { name: 'Modell archivieren' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Modell löschen' })).toBeDisabled();
    fireEvent.click(attach);
    const dialog = await screen.findByRole('dialog');
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Geprüfte Aktion ausführen' }));
    expect(await screen.findByText('Modellaktion attach bestätigt. Keine Graphaktivierung oder Handelsausführung.')).toBeVisible();
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ id: 'model/1', kind: 'contract', action: 'attach', reviewHash: 'reviewed-model-hash' });
    expect(screen.getByRole('link', { name: 'Gespeicherten Ressourcenentwurf öffnen' })).toHaveAttribute('href', '/workflows/resources/family%2F2/versions/draft%2F2');
  });
});
