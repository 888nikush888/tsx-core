import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationProvider } from '@/lib/navigation';
import { OperatorReadOnlyContext } from '@/shared/api/operator-session';
import { TelegramSettings } from '@/features/signals/telegram-settings';
import { AI_LIMIT_RANGES } from '../../src/ui_contracts';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), ...api }));
const fixture = () => ({
  configRevision: 7, apiId: 42, targetChannel: '@target', sourceChannels: ['@source'],
  forwardOptions: { maxConcurrency: 2, queueTimeoutSeconds: 30, sendCopy: false },
  filters: { allowedKeywords: ['keep'], blockedKeywords: ['spam'], allowedTypes: ['text'], regexPatterns: ['original'] },
  sourceFilters: { '@filter': { regexPatterns: ['special'] } }, sourceAliases: { '@alias': 'Existing' },
  xmlParsing: { primaryModel: 'primary', fallbackModel: 'fallback', timeout: 1000, sourceTemplates: { '@template': 'template' },
    aiLimits: Object.fromEntries(Object.entries(AI_LIMIT_RANGES).map(([key, [minimum]]) => [key, minimum])) },
  dupeBlocker: { enabled: false, cooldownHours: 24 },
});
function mount(readOnly = false) {
  return render(<NavigationProvider><OperatorReadOnlyContext value={readOnly}><TelegramSettings /></OperatorReadOnlyContext></NavigationProvider>);
}
function writes() { return api.jsonRequest.mock.calls.filter(([, init]) => init?.method === 'POST'); }
function change(label: string | RegExp, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function legacy() { fireEvent.click(screen.getByText('Globaler Legacy-Signalweg · Quellen, Filter und Ausgabe')); }
function setup(config: Record<string, unknown> = fixture(), status: Record<string, unknown> = { connectionState: 'disconnected', isRunning: false }) {
  let current = config;
  api.jsonRequest.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (url === '/api/config') {
        const configuration = JSON.parse(String(init.body));
        current = { ...configuration, configRevision: 8 };
        return { configuration, configRevision: 8, requestId: 'saved-8' };
      }
      return { requestId: 'accepted-1' };
    }
    if (url === '/api/config') return current;
    if (url === '/api/status') return status;
    return { secrets: { telegramApiHash: { configured: true }, openRouterApiKey: { configured: false } } };
  });
}
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, '', '/'); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
afterEach(cleanup);

describe('Telegram configuration persistence', () => {
  it('persists dependent legacy, source and parser controls against the observed revision', async () => {
    setup(); mount();
    await screen.findByLabelText('Telegram API ID'); legacy();
    change('Telegram API ID', '101'); change('Telegram-Ziel (globale Vorgabe)', '@new-target');
    change('Queue · Parallelität', '4'); change('Queue · Zeitlimit (Sekunden)', '45');
    change('Primärmodell', 'new-primary'); change('Fallback-Modell', 'new-fallback');
    for (const label of ['Externe KI-Datenverarbeitung freigegeben', 'Als Kopie senden', 'Mediencaption entfernen', 'Globalen Legacy-Parser verwenden', 'Legacy-XML an globales Ziel senden', 'Legacy-Signaldateien speichern', 'Globale Duplikatsperre', 'Originalnachrichten an das globale Ziel weiterleiten']) fireEvent.click(screen.getByLabelText(label));
    change(/Legacy-Signalverzeichnis/, 'signals/test'); change(/Legacy-Parser-Gesamtzeitlimit/, '2000'); change(/Duplikat-Cooldown/, '0');
    for (const [label, value] of [[/Globale Quellkanäle/, '@source\n@second\n'], [/Erforderliche Keywords/, 'buy\nsell'], [/Gesperrte Keywords/, 'ignore'], [/Erlaubte Inhaltstypen/, 'text\nphoto'], [/Globale Regex-Muster/, '^buy']] as const) {
      const input = screen.getByLabelText(label); fireEvent.change(input, { target: { value } }); fireEvent.blur(input);
    }
    const sourceSelect = screen.getByLabelText('Konfigurierter Quellkanal');
    expect(Array.from((sourceSelect as HTMLSelectElement).options).map(option => option.value)).toEqual(['', '@source', '@second', '@filter', '@alias', '@template']);
    change('Konfigurierter Quellkanal', '@source');
    expect(screen.getByText(/Erbt die globalen Regex-Muster/)).toBeVisible();
    change(/Quellalias/, 'Signals'); change(/Legacy-Parservorlage/, 'source-template');
    fireEvent.click(screen.getByLabelText('Globale Regex-Muster für diesen Kanal überschreiben'));
    change(/Kanal-Regex-Muster/, '^signal\n^trade');
    change(/Maximale Eingabe/, '500');
    fireEvent.click(screen.getByRole('button', { name: 'Grundkonfiguration speichern' }));
    await screen.findByText(/Telegram- und KI-Grundkonfiguration gespeichert.*Anfrage saved-8/);
    expect(writes()).toHaveLength(1);
    expect(writes()[0][1].headers['If-Match']).toBe('7');
    const saved = JSON.parse(writes()[0][1].body);
    expect(saved).toMatchObject({ apiId: 101, targetChannel: '@new-target', sourceChannels: ['@source', '@second'],
      forwardOptions: { maxConcurrency: 4, queueTimeoutSeconds: 45, forwardToTarget: false, sendCopy: true, removeCaption: true },
      filters: { allowedKeywords: ['buy', 'sell'], blockedKeywords: ['ignore'], allowedTypes: ['text', 'photo'], regexPatterns: ['^buy'] },
      sourceAliases: { '@alias': 'Existing', '@source': 'Signals' }, sourceFilters: { '@filter': { regexPatterns: ['special'] }, '@source': { regexPatterns: ['^signal', '^trade'] } },
      xmlParsing: { primaryModel: 'new-primary', fallbackModel: 'new-fallback', enabled: true, externalDataPolicyAccepted: true, forwardXmlToTarget: true, saveToFile: true, signalsDir: 'signals/test', timeout: 2000, sourceTemplates: { '@template': 'template', '@source': 'source-template' }, aiLimits: { maxInputChars: 500 } },
      dupeBlocker: { enabled: true, cooldownHours: 0 } });
    expect(saved).not.toHaveProperty('configRevision');
    expect(screen.queryByRole('region', { name: 'Grundkonfiguration Entwurf' })).not.toBeInTheDocument();
  });

  it('removes a source override explicitly and treats an empty legacy timeout as zero', async () => {
    setup(); mount(); await screen.findByLabelText('Telegram API ID'); legacy();
    change('Konfigurierter Quellkanal', '@filter');
    expect(screen.getByLabelText(/Kanal-Regex-Muster/)).toHaveValue('special');
    fireEvent.click(screen.getByLabelText('Globale Regex-Muster für diesen Kanal überschreiben'));
    expect(screen.queryByLabelText(/Kanal-Regex-Muster/)).not.toBeInTheDocument();
    change(/Legacy-Parser-Gesamtzeitlimit/, '');
    fireEvent.click(screen.getByRole('button', { name: 'Grundkonfiguration speichern' }));
    await screen.findByText(/Grundkonfiguration gespeichert/);
    expect(JSON.parse(writes()[0][1].body)).toMatchObject({ sourceFilters: { '@filter': null }, xmlParsing: { timeout: 0 } });
  });

  it.each([
    [/Telegram API ID/, '-1'], [/Queue · Parallelität/, '101'], [/Queue · Zeitlimit \(Sekunden\)/, '-1'],
    [/Duplikat-Cooldown/, '-1'], [/Legacy-Parser-Gesamtzeitlimit/, '-1'],
  ])('rejects invalid %s without submitting the draft', async (label, value) => {
    setup(); mount(); await screen.findByLabelText('Telegram API ID'); legacy();
    change(label, value);
    fireEvent.click(screen.getByRole('button', { name: 'Grundkonfiguration speichern' }));
    expect(await screen.findByText('API ID, Queue und Legacy-Zeitlimits müssen innerhalb der angezeigten Grenzen liegen.')).toBeVisible();
    expect(writes()).toHaveLength(0);
  });

  it('rejects an out-of-range AI limit and retains the editable value', async () => {
    setup(); mount(); await screen.findByLabelText('Telegram API ID'); change(/Maximale Eingabe/, '99');
    fireEvent.click(screen.getByRole('button', { name: 'Grundkonfiguration speichern' }));
    expect(await screen.findByText('maxInputChars: Ganzzahl zwischen 100 und 100000 erforderlich.')).toBeVisible();
    expect(screen.getByLabelText(/Maximale Eingabe/)).toHaveValue(99); expect(writes()).toHaveLength(0);
  });

  it('keeps configuration controls locked when the server supplies no revision', async () => {
    setup({}); mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Versionsvertrag fehlt');
    expect(screen.getByRole('button', { name: 'Grundkonfiguration speichern' })).toBeDisabled();
    expect(screen.getByLabelText('Telegram API ID')).toBeDisabled(); expect(writes()).toHaveLength(0);
  });

  it('adopts server normalization and uses its new revision for a subsequent save', async () => {
    const original = fixture(); let current = original;
    api.jsonRequest.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const configuration = JSON.parse(String(init.body));
        configuration.forwardOptions.queueTimeoutSeconds = 65;
        current = { ...configuration, configRevision: 9 };
        return { configuration, configRevision: 9 };
      }
      return url === '/api/config' ? current : {};
    });
    mount(); await screen.findByLabelText('Telegram API ID');
    change('Queue · Zeitlimit (Sekunden)', '1');
    fireEvent.click(screen.getByRole('button', { name: 'Grundkonfiguration speichern' }));
    await waitFor(() => expect(screen.getByLabelText('Queue · Zeitlimit (Sekunden)')).toHaveValue(65));
    expect(screen.getByRole('heading', { name: 'Servernormalisierung nach dem Speichern' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Grundkonfiguration Entwurf' })).not.toBeInTheDocument();
    change('Telegram-Ziel (globale Vorgabe)', '@next');
    fireEvent.click(screen.getByRole('button', { name: 'Grundkonfiguration speichern' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1][1].headers['If-Match']).toBe('9');
    expect(JSON.parse(writes()[1][1].body).forwardOptions.queueTimeoutSeconds).toBe(65);
  });

  it('keeps the draft when a write is acknowledged without the normalized response contract', async () => {
    setup(); const respond = api.jsonRequest.getMockImplementation();
    if (!respond) throw new Error('Expected the configured request fixture.');
    api.jsonRequest.mockImplementation((url: string, init?: RequestInit) => init?.method === 'POST' ? { requestId: 'incomplete' } : respond(url, init));
    mount(); await screen.findByLabelText('Telegram API ID'); change('Telegram-Ziel (globale Vorgabe)', '@unsaved');
    fireEvent.click(screen.getByRole('button', { name: 'Grundkonfiguration speichern' }));
    expect(await screen.findByText('Speichern bestätigt, aber normalisierter Antwortvertrag fehlt. Konfiguration neu laden und vergleichen.')).toBeVisible();
    expect(screen.getByLabelText('Telegram-Ziel (globale Vorgabe)')).toHaveValue('@unsaved');
    expect(screen.getByRole('region', { name: 'Grundkonfiguration Entwurf' })).toBeVisible();
    expect(writes()).toHaveLength(1);
  });
});

describe('Telegram access, secrets and routing', () => {
  it('hides credentials and disables mutations for a read-only operator', async () => {
    setup(undefined, { connectionState: 'authentication-required', telegramLogin: { state: 'waiting', prompt: { kind: 'code', label: 'Login code' } } }); mount(true);
    await screen.findByLabelText('Telegram API ID');
    expect(screen.getByText(/Nur Lesezugriff/)).toBeVisible();
    for (const label of ['Starten', 'Stoppen', 'Weiter', 'Grundkonfiguration speichern']) expect(screen.getByRole('button', { name: label })).toBeDisabled();
    expect(screen.getByLabelText('Login code')).toBeDisabled();
    expect(screen.queryByRole('heading', { name: 'Telegram-/KI-Zugangsdaten' })).not.toBeInTheDocument();
    expect(api.jsonRequest.mock.calls.some(([url]) => url === '/api/secrets')).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  it('writes only nonblank secrets and clears accepted inputs while retaining configuration edits', async () => {
    setup(); mount(); await screen.findByLabelText('Telegram API ID');
    change('Telegram-Ziel (globale Vorgabe)', '@draft');
    const save = screen.getByRole('button', { name: 'Telegram-/KI-Zugangsdaten speichern' });
    expect(save).toBeDisabled();
    change('Telegram API Hash · gespeichert', '   '); expect(save).toBeDisabled();
    change('OpenRouter API Key · fehlt', 'fixture-key'); fireEvent.click(save);
    expect(await screen.findByText(/Zugangsdaten gespeichert.*Anfrage accepted-1/)).toBeVisible();
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe('/api/secrets');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ openRouterApiKey: 'fixture-key' });
    expect(screen.getByLabelText('Telegram API Hash · gespeichert')).toHaveValue('');
    expect(screen.getByLabelText('OpenRouter API Key · fehlt')).toHaveValue('');
    expect(screen.getByLabelText('Telegram-Ziel (globale Vorgabe)')).toHaveValue('@draft');
  });

  it.each([['disconnected', false, 'Starten', 'start'], ['connecting', false, 'Stoppen', 'stop'], ['connected', true, 'Stoppen', 'stop']] as const)('sends the available routing command for %s', async (connectionState, isRunning, label, action) => {
    setup(undefined, { connectionState, isRunning }); mount();
    await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled());
    expect(screen.getByRole('button', { name: label === 'Starten' ? 'Stoppen' : 'Starten' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await screen.findByText(/Anfrage accepted-1/);
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe('/api/control'); expect(JSON.parse(writes()[0][1].body)).toEqual({ action });
  });

  it('reports independent polling failures and leaves unavailable controls disabled', async () => {
    api.jsonRequest.mockRejectedValue(new Error('offline')); mount();
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(3));
    expect(screen.getByText('Grundkonfiguration wird geladen.')).toBeVisible();
    for (const label of ['Starten', 'Stoppen', 'Telegram-/KI-Zugangsdaten speichern']) expect(screen.getByRole('button', { name: label })).toBeDisabled();
    expect(screen.getByLabelText('Telegram API Hash · unbekannt')).toBeDisabled();
    expect(writes()).toHaveLength(0);
  });

  it('preserves a failed credential submission and releases the busy lock without retrying', async () => {
    setup(); const respond = api.jsonRequest.getMockImplementation();
    if (!respond) throw new Error('Expected the configured request fixture.');
    api.jsonRequest.mockImplementation((url: string, init?: RequestInit) => init?.method === 'POST' ? Promise.reject(new Error('credential write unavailable')) : respond(url, init));
    mount(); await screen.findByLabelText('Telegram API Hash · gespeichert');
    change('Telegram API Hash · gespeichert', 'retain-for-retry');
    fireEvent.click(screen.getByRole('button', { name: 'Telegram-/KI-Zugangsdaten speichern' }));
    expect(await screen.findByText('Nicht bestätigt. Keine automatische Wiederholung: credential write unavailable')).toBeVisible();
    expect(screen.getByLabelText('Telegram API Hash · gespeichert')).toHaveValue('retain-for-retry');
    expect(screen.getByRole('button', { name: 'Telegram-/KI-Zugangsdaten speichern' })).toBeEnabled();
    expect(writes()).toHaveLength(1);
  });
});
