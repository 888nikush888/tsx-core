import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NavigationProvider } from '@/lib/navigation';
import { TradeRelations } from '@/features/trades/trade-relations';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', () => api);
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, '', '/trades'); });
afterEach(cleanup);

it('keeps unresolved original money and missing legacy valuation fields distinct from zero', async () => {
  api.jsonRequest.mockResolvedValue({ observedAt: 1_700_000_000_000, hasMore: false, nextCursor: null,
    entries: [{ id: 'money-account-a', kind: 'fee', amount: '-0.125', asset: 'ETH',
      valuationStatus: 'unresolved', originalUnverified: true }] });
  render(<NavigationProvider><TradeRelations intentId="intent-account-a" kind="money" /></NavigationProvider>);
  const row = await screen.findByRole('row', { name: /money-account-a/ });
  expect(within(row).getByText('-0.125')).toBeInTheDocument();
  expect(within(row).getByText('ETH')).toBeInTheDocument();
  expect(within(row).getByText('Bewertung ungeklärt')).toBeInTheDocument();
  expect(within(row).queryByText(/^0(?:[,.]0+)?$/)).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Originalintegrität ungeklärt');
  expect(api.jsonRequest.mock.calls[0][0]).toContain('intentId=intent-account-a&kind=money');
});

it('discards the previous intent page while the newly selected intent is still loading', async () => {
  api.jsonRequest.mockResolvedValueOnce({ observedAt: 1_700_000_000_000, hasMore: false, nextCursor: null,
    entries: [{ id: 'money-account-a', amount: '-1', asset: 'USD', valuationStatus: 'unresolved' }] });
  const view = render(<NavigationProvider><TradeRelations intentId="intent-account-a" kind="money" /></NavigationProvider>);
  await screen.findByRole('row', { name: /money-account-a/ });
  api.jsonRequest.mockImplementation(() => new Promise(() => undefined));
  view.rerender(<NavigationProvider><TradeRelations intentId="intent-account-b" kind="money" /></NavigationProvider>);
  expect(screen.queryByRole('row', { name: /money-account-a/ })).not.toBeInTheDocument();
  expect(screen.getByText('Belege werden geladen …')).toBeInTheDocument();
  expect(api.jsonRequest.mock.calls.at(-1)?.[0]).toContain('intentId=intent-account-b&kind=money');
});
