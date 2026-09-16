import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PaperLab } from '@/features/trades/paper-lab';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), ...api }));
const account = { id: 'paper-a', name: 'Simulation A', exchange: 'paper', mode: 'paper' };
const market = { accountId: account.id, symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.01', quantityStep: '0.001', minimumQuantity: '0.001', minimumNotional: '1', maxLeverage: 5, revision: 'a'.repeat(64) };
const snapshot = () => ({ accounts: [account, { ...account, id: 'live', name: 'Live forbidden', mode: 'live' }, { ...account, id: 'testnet', name: 'Testnet forbidden', mode: 'testnet' }], activity: { paperMarkets: [market], paperAccounts: [] } });
beforeEach(() => { vi.clearAllMocks(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
afterEach(cleanup);

it('restricts account selection to paper and keeps missing balance evidence uneditable', async () => {
  api.jsonRequest.mockResolvedValue(snapshot());
  render(<PaperLab readOnly={false} />);
  await screen.findByRole('option', { name: account.name });
  expect(screen.queryByRole('option', { name: 'Live forbidden' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'Testnet forbidden' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Paper-Konto'), { target: { value: account.id } });
  expect(screen.getByRole('button', { name: 'Paper-Bestand setzen' })).toBeDisabled();
  expect(screen.getByLabelText('Basis-Eigenkapital (Währung unbekannt)')).toHaveValue('');
  expect(api.jsonRequest.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});

it('saves a confirmed market once with its original revision and exact decimal normalization', async () => {
  const updated = { ...market, markPrice: '101.50', revision: 'b'.repeat(64) };
  api.jsonRequest.mockImplementation((_url: string, init?: RequestInit) => init?.method === 'POST'
    ? { result: { accountId: account.id, market: updated } } : snapshot());
  render(<PaperLab readOnly={false} />);
  await screen.findByRole('option', { name: account.name });
  fireEvent.change(screen.getByLabelText('Paper-Konto'), { target: { value: account.id } });
  fireEvent.change(screen.getByLabelText('Vorhandener Markt'), { target: { value: market.symbol } });
  fireEvent.change(screen.getByLabelText('Markpreis'), { target: { value: '101,50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Paper-Markt speichern' }));
  const dialog = await screen.findByRole('dialog');
  expect(api.jsonRequest.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Paper-Änderung speichern' }));
  await waitFor(() => expect(screen.getByText(/Paper-Änderung bestätigt/)).toBeVisible());
  const writes = api.jsonRequest.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0][1].body)).toMatchObject({ accountId: account.id, baseMarketRevision: market.revision, market: { symbol: market.symbol, markPrice: '101.50', maxLeverage: 5 } });
});
