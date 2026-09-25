import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TelegramViewer } from '@/features/telegram-viewer/telegram-viewer';
import { OperatorReadOnlyContext } from '@/shared/api/operator-session';
import { DEFAULT_TELEGRAM_VIEWER_SETTINGS } from '../../src/telegram_viewer_settings';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), ...api }));
afterEach(cleanup);

it('keeps display controls mounted while editing and saves their shared settings revision once', async () => {
  api.jsonRequest.mockReset();
  let payload = {
    settingsRevision: 7,
    settings: {
      ...DEFAULT_TELEGRAM_VIEWER_SETTINGS,
      enabled: true, allowedUserIds: ['1001'], timezone: 'UTC', locale: 'de-DE', eventPollingIntervalMs: 3000,
      display: { detailLevel: 'normal', pnlMode: 'absolute', timeFormat: '24h' },
    },
    service: { ready: true, reachable: true, healthy: true },
  };
  api.jsonRequest.mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      payload = { ...payload, settings: JSON.parse(String(init.body)), settingsRevision: 8 };
    }
    return Promise.resolve(payload);
  });
  render(<TelegramViewer />);
  const detail = await screen.findByLabelText('Detailstufe');
  detail.focus();
  fireEvent.change(detail, { target: { value: 'detailed' } });
  expect(screen.getByLabelText('Detailstufe')).toBe(detail);
  expect(detail).toHaveFocus();
  fireEvent.change(screen.getByLabelText('PnL-Anzeige'), { target: { value: 'absolute_and_percent' } });
  expect(detail).toHaveValue('detailed');
  expect(screen.getByText('Uhrzeitformat: 24h (fest vorgegeben).')).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: 'Einstellungen speichern' }));
  await waitFor(() => expect(screen.getByText(/Einstellungen gespeichert: Antwort bestätigt/)).toBeVisible());
  const writes = api.jsonRequest.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toBe('/api/telegram-viewer/settings');
  expect(writes[0][1].headers['If-Match']).toBe('7');
  expect(JSON.parse(writes[0][1].body)).toMatchObject({
    allowedUserIds: ['1001'], timezone: 'UTC', notifications: { positionOpened: true },
    display: { detailLevel: 'detailed', pnlMode: 'absolute_and_percent', timeFormat: '24h' },
  });
});

it('shows every viewer setting but disables edits and token commands for a read-only operator', async () => {
  api.jsonRequest.mockReset();
  api.jsonRequest.mockResolvedValue({
    settingsRevision: 7,
    settings: { ...DEFAULT_TELEGRAM_VIEWER_SETTINGS, allowedUserIds: ['1001'] },
    service: { ready: true },
    secrets: { botToken: { configured: true } },
  });
  render(<OperatorReadOnlyContext.Provider value={true}><TelegramViewer /></OperatorReadOnlyContext.Provider>);
  expect(await screen.findByLabelText('Viewer aktiv')).toBeDisabled();
  for (const name of ['Zeitzone', 'Sprache/Locale', 'Abfrageintervall (ms)', 'Erlaubte Telegram User IDs', 'Detailstufe', 'PnL-Anzeige', 'Neuer Bot-Token', 'Testnachricht']) {
    expect(screen.getByLabelText(name)).toBeDisabled();
  }
  expect(screen.getByText('Uhrzeitformat: 24h (fest vorgegeben).')).toBeVisible();
  for (const name of ['Einstellungen speichern', 'Bot-Token setzen', 'Bot-Token löschen', 'Dienst-Token rotieren', 'Test senden']) {
    const button = screen.getByRole('button', { name });
    expect(button).toBeDisabled();
    fireEvent.click(button);
  }
  expect(api.jsonRequest.mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'DELETE')).toHaveLength(0);
});
