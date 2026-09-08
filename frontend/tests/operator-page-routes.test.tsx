import { fixtureValue } from "./fixture-value";
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavigationProvider } from '@/lib/navigation';
import { OperatorPage } from '@/app/operator-page';

const stubs = vi.hoisted(() => ({ page: (name: string) => (props: Record<string, unknown>) => JSON.stringify({ page: name, ...props }) }));
vi.mock('@/app/workflow/operations-panel', () => ({ OperationsWorkspace: stubs.page('workspace') }));
vi.mock('@/app/workflow/workflow-builder', () => ({ WorkflowBuilder: stubs.page('builder') }));
vi.mock('@/features/trades/trade-detail', () => ({ TradeDetail: stubs.page('trade') }));
vi.mock('@/features/trades/paper-lab', () => ({ PaperLab: stubs.page('paper') }));
vi.mock('@/features/accounts/account-detail', () => ({ AccountDetail: stubs.page('account') }));
vi.mock('@/features/accounts/accounts-page', () => ({ AccountsPage: stubs.page('accounts') }));
vi.mock('@/features/trades/trading-list', () => ({ TradingList: stubs.page('trading-list') }));
vi.mock('@/features/signals/signals-page', () => ({ IngressDetail: stubs.page('ingress'), SignalsPage: stubs.page('signals') }));
vi.mock('@/features/signals/signal-original', () => ({ SignalOriginal: stubs.page('original') }));
vi.mock('@/features/operations/jobs-page', () => ({ JobsPage: stubs.page('jobs') }));
vi.mock('@/features/operations/backups-page', () => ({ BackupsPage: stubs.page('backups') }));
vi.mock('@/features/workflows/test-lab', () => ({ TestLab: stubs.page('test-lab') }));
vi.mock('@/features/mcp/proposal-detail', () => ({ ProposalDetail: stubs.page('proposal') }));
vi.mock('@/features/workflows/workflow-library', () => ({ WorkflowLibrary: stubs.page('library'), WorkflowObject: stubs.page('workflow-object') }));
vi.mock('@/features/signals/telegram-settings', () => ({ TelegramSettings: stubs.page('telegram') }));
vi.mock('@/features/workflows/model-library', () => ({ ModelLibrary: stubs.page('models') }));
vi.mock('@/features/risk-analytics/account-evidence', () => ({ RiskAccounts: stubs.page('risk-accounts'), RiskAccountEvidence: stubs.page('risk-account') }));
vi.mock('@/features/risk-analytics/adaptive-risk', () => ({ AdaptiveRiskPage: stubs.page('adaptive') }));
vi.mock('@/features/operations/capabilities', () => ({ CapabilitiesPage: stubs.page('capabilities') }));
vi.mock('@/features/operations/deployment', () => ({ DeploymentEvidence: stubs.page('deployment') }));

function open(pathname: string, readOnly = true) {
  return render(<NavigationProvider><OperatorPage pathname={pathname} readOnly={readOnly} trading={null} catalog={null} status={null} onRefresh={async () => undefined} /></NavigationProvider>);
}

describe('operator route selection', () => {
  afterEach(cleanup);
  it.each([
    ['/trading/trades/trade%20id', 'trade', { intentId: 'trade id', readOnly: true }],
    ['/trading/trades/%E0%A4', 'trade', { intentId: '%E0%A4' }],
    ['/trading/accounts', 'accounts', {}],
    ['/trading/positions', 'trading-list', { kind: 'positions' }],
    ['/trading/orders', 'trading-list', { kind: 'orders' }],
    ['/trading/operations', 'trading-list', { kind: 'operations' }],
    ['/trading/incidents', 'trading-list', { kind: 'incidents' }],
    ['/trading/reconciliations', 'trading-list', { kind: 'reconciliations' }],
    ['/trading/risk-events', 'trading-list', { kind: 'risk-events' }],
    ['/trading/paper', 'paper', { readOnly: true }],
    ['/operations/jobs', 'jobs', {}],
    ['/operations/jobs/job%2F1', 'jobs', { id: 'job/1' }],
    ['/operations/backups', 'backups', {}],
    ['/operations/backups/archive%20one', 'backups', { name: 'archive one' }],
    ['/operations/capabilities', 'capabilities', {}],
    ['/operations/deployment', 'deployment', {}],
    ['/integrations/mcp/proposals/proposal%201', 'proposal', { id: 'proposal 1' }],
    ['/workflows/resources', 'library', { kind: 'resources' }],
    ['/workflows/resources/family%201', 'library', { resourceId: 'family 1' }],
    ['/workflows/resources/family%201/versions/v%201', 'workflow-object', { kind: 'resources', resourceId: 'family 1', id: 'v 1' }],
    ['/workflows/paths', 'library', { kind: 'paths' }],
    ['/workflows/paths/path%201', 'workflow-object', { kind: 'paths', id: 'path 1' }],
    ['/workflows/revisions', 'library', { kind: 'revisions' }],
    ['/workflows/revisions/rev%201', 'workflow-object', { kind: 'revisions', id: 'rev 1' }],
    ['/workflows/models/strategy', 'models', { kind: 'strategy' }],
    ['/workflows/models/schema/schema%201', 'models', { kind: 'schema', id: 'schema 1' }],
    ['/workflows/models/contract/contract%201', 'models', { kind: 'contract', id: 'contract 1' }],
    ['/workflows/tests', 'test-lab', {}],
    ['/signals/messages/ingress%201', 'ingress', { id: 'ingress 1' }],
    ['/signals/cache/source%201', 'original', { kind: 'messages', id: 'source 1' }],
    ['/signals/processed/source%201', 'original', { kind: 'processed', id: 'source 1' }],
    ['/signals/messages', 'signals', { kind: 'ingress', readOnly: true }],
    ['/signals/processed', 'signals', { kind: 'processed', readOnly: true }],
    ['/signals/cache', 'signals', { kind: 'messages', readOnly: true }],
    ['/signals/outbox', 'signals', { kind: 'outbox', readOnly: true }],
    ['/signals/telegram', 'telegram', {}],
    ['/signals/ai', 'test-lab', {}],
    ['/risk/accounts', 'risk-accounts', {}],
    ['/risk/accounts/account%201', 'risk-account', { accountId: 'account 1' }],
    ['/risk/adaptive', 'adaptive', {}],
  ] as const)('selects %s and preserves its object context', (path, page, props) => {
    const { container } = open(path);
    expect(JSON.parse(fixtureValue(container.textContent, 'rendered route text'))).toMatchObject({ page, ...props });
  });

  it.each([
    ['/cockpit', 'overview'], ['/trading/journal', 'journal'], ['/risk/analytics', 'analytics'],
    ['/integrations/mcp', 'mcp'], ['/integrations/telegram-viewer', 'telegram-viewer'],
    ['/operations/logs', 'logs'], ['/operations/settings', 'system'],
  ])('keeps %s in its scoped operations workspace', (path, tab) => {
    const { container } = open(path);
    expect(JSON.parse(fixtureValue(container.textContent, 'rendered route text'))).toMatchObject({ page: 'workspace', initialTab: tab, availableTabs: [tab], filtersOpen: true });
  });

  it('mounts account evidence alongside configuration with the same decoded identity', () => {
    const { container } = open('/trading/accounts/account%201');
    expect(container.textContent).toContain('"page":"account","id":"account 1","readOnly":true');
    expect(container.textContent).toContain('"page":"accounts","catalog":null,"accountId":"account 1"');
  });

  it('preserves admin access and lazy embedded builder mode', async () => {
    const { container, unmount } = open('/trading/trades/id', false);
    expect(JSON.parse(fixtureValue(container.textContent, 'rendered route text'))).toMatchObject({ page: 'trade', readOnly: false });
    unmount();
    open('/workflows/builder');
    expect(await screen.findByText('{"page":"builder","embedded":true}')).toBeVisible();
  });

  it.each(['/unknown', '/constructor', '/toString', '/workflows/models/new-kind', '/operations/jobs/id/extra'])('renders an explicit unknown page for %s', path => {
    open(path);
    expect(screen.getByRole('heading', { name: 'Seite nicht gefunden' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Cockpit öffnen' })).toHaveAttribute('href', '/cockpit');
  });
});
