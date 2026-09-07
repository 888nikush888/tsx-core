import { lazy, Suspense } from 'react';
import { Link } from '@/lib/navigation';
import { OperationsWorkspace } from '@/app/workflow/operations-panel';
import type { ExchangeCatalog, TradingSnapshot } from '@/app/workflow/types';
import { operatorTab } from './operator-routes';
import { TradeDetail } from '@/features/trades/trade-detail';
import { PaperLab } from '@/features/trades/paper-lab';
import { AccountDetail } from '@/features/accounts/account-detail';
import { AccountsPage } from '@/features/accounts/accounts-page';
import { TradingList, type TradingListKind } from '@/features/trades/trading-list';
import { IngressDetail, SignalsPage } from '@/features/signals/signals-page';
import { SignalOriginal } from '@/features/signals/signal-original';
import { JobsPage } from '@/features/operations/jobs-page';
import { BackupsPage } from '@/features/operations/backups-page';
import { TestLab } from '@/features/workflows/test-lab';
import { ProposalDetail } from '@/features/mcp/proposal-detail';
import { WorkflowLibrary, WorkflowObject } from '@/features/workflows/workflow-library';
import { TelegramSettings } from '@/features/signals/telegram-settings';
import { ModelLibrary } from '@/features/workflows/model-library';
import { RiskAccounts, RiskAccountEvidence } from '@/features/risk-analytics/account-evidence';
import { AdaptiveRiskPage } from '@/features/risk-analytics/adaptive-risk';
import { CapabilitiesPage } from '@/features/operations/capabilities';
import { DeploymentEvidence } from '@/features/operations/deployment';

const WorkflowBuilder = lazy(() => import('@/app/workflow/workflow-builder').then(module => ({ default: module.WorkflowBuilder })));
type PageProps = {
  pathname: string;
  readOnly: boolean;
  trading: TradingSnapshot | null;
  catalog: ExchangeCatalog | null;
  status: Record<string, any> | null;
  onRefresh: () => Promise<void>;
  areaLabel?: string;
};
function decodeId(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function tradingRoute({ pathname, readOnly, catalog, onRefresh }: PageProps) {
  const trade = /^\/trading\/trades\/([^/]+)$/.exec(pathname);
  if (trade) return <TradeDetail key={trade[1]} intentId={decodeId(trade[1])} readOnly={readOnly} />;
  const account = /^\/trading\/accounts\/([^/]+)$/.exec(pathname);
  if (account) return <><AccountDetail key={account[1]} id={decodeId(account[1])} readOnly={readOnly} /><AccountsPage catalog={catalog} accountId={decodeId(account[1])} onRefresh={onRefresh} /></>;
  if (pathname === '/trading/accounts') return <AccountsPage catalog={catalog} onRefresh={onRefresh} />;
  const list = /^\/trading\/(positions|orders|operations|incidents|reconciliations|risk-events)$/.exec(pathname);
  if (list) return <TradingList kind={list[1] as TradingListKind} />;
  if (pathname === '/trading/paper') return <PaperLab readOnly={readOnly} />;
  return null;
}

function workflowRoute({ pathname }: PageProps) {
  const resource = /^\/workflows\/resources(?:\/([^/]+)(?:\/versions\/([^/]+))?)?$/.exec(pathname);
  if (resource) {
    if (resource[2]) return <WorkflowObject key={pathname} kind="resources" resourceId={decodeId(resource[1])} id={decodeId(resource[2])} />;
    return <WorkflowLibrary key={pathname} kind="resources" resourceId={resource[1] ? decodeId(resource[1]) : undefined} />;
  }
  const workflow = /^\/workflows\/(paths|revisions)(?:\/([^/]+))?$/.exec(pathname);
  if (workflow) {
    const kind = workflow[1] as 'paths' | 'revisions';
    if (workflow[2]) return <WorkflowObject key={pathname} kind={kind} id={decodeId(workflow[2])} />;
    return <WorkflowLibrary key={pathname} kind={kind} />;
  }
  const model = /^\/workflows\/models\/(strategy|schema|contract)(?:\/([^/]+))?$/.exec(pathname);
  if (model) return <ModelLibrary key={pathname} kind={model[1] as 'strategy' | 'schema' | 'contract'} id={model[2] ? decodeId(model[2]) : undefined} />;
  if (pathname === '/workflows/tests') return <TestLab />;
  if (pathname === '/workflows/builder') return <Suspense fallback={<p>Workflows werden geladen …</p>}><WorkflowBuilder embedded /></Suspense>;
  return null;
}

const SIGNAL_LIST_KINDS = { '/signals/messages': 'ingress', '/signals/outbox': 'outbox', '/signals/cache': 'messages', '/signals/processed': 'processed' } as const;
function signalsRoute({ pathname, readOnly }: PageProps) {
  const ingress = /^\/signals\/messages\/([^/]+)$/.exec(pathname);
  if (ingress) return <IngressDetail key={ingress[1]} id={decodeId(ingress[1])} />;
  const original = /^\/signals\/(cache|processed)\/([^/]+)$/.exec(pathname);
  if (original) return <SignalOriginal key={pathname} id={decodeId(original[2])} kind={original[1] === 'cache' ? 'messages' : 'processed'} />;
  const kind = SIGNAL_LIST_KINDS[pathname as keyof typeof SIGNAL_LIST_KINDS];
  if (kind) return <SignalsPage kind={kind} readOnly={readOnly} />;
  if (pathname === '/signals/telegram') return <TelegramSettings />;
  if (pathname === '/signals/ai') return <TestLab />;
  return null;
}

function operationsRoute({ pathname }: PageProps) {
  const job = /^\/operations\/jobs(?:\/([^/]+))?$/.exec(pathname);
  if (job) return <JobsPage key={pathname} id={job[1] ? decodeId(job[1]) : undefined} />;
  const backup = /^\/operations\/backups(?:\/([^/]+))?$/.exec(pathname);
  if (backup) return <BackupsPage key={pathname} name={backup[1] ? decodeId(backup[1]) : undefined} />;
  if (pathname === '/operations/capabilities') return <CapabilitiesPage />;
  if (pathname === '/operations/deployment') return <DeploymentEvidence />;
  return null;
}

function riskRoute({ pathname }: PageProps) {
  const account = /^\/risk\/accounts(?:\/([^/]+))?$/.exec(pathname);
  if (account) return account[1] ? <RiskAccountEvidence key={pathname} accountId={decodeId(account[1])} /> : <RiskAccounts />;
  if (pathname === '/risk/adaptive') return <AdaptiveRiskPage />;
  return null;
}

function integrationRoute({ pathname }: PageProps) {
  const proposal = /^\/integrations\/mcp\/proposals\/([^/]+)$/.exec(pathname);
  return proposal ? <ProposalDetail key={pathname} id={decodeId(proposal[1])} /> : null;
}

// Each resolver only selects elements; polling and mutations remain in the mounted page.
const areaPages = { trading: tradingRoute, workflows: workflowRoute, signals: signalsRoute, operations: operationsRoute, risk: riskRoute, integrations: integrationRoute };
export function OperatorPage(props: PageProps) {
  const area = props.pathname.split('/')[1] as keyof typeof areaPages;
  const resolve = Object.hasOwn(areaPages, area) ? areaPages[area] : undefined;
  const page = resolve?.(props);
  if (page) return page;
  const tab = operatorTab(props.pathname);
  if (tab) return <OperationsWorkspace key={props.pathname} trading={props.trading} catalog={props.catalog} systemStatus={props.status} onRefresh={props.onRefresh} initialTab={tab} availableTabs={[tab]} ariaLabel={props.areaLabel ?? 'Betrieb'} filtersOpen />;
  return <section><h1>Seite nicht gefunden</h1><p>Die Objektadresse wird von dieser UI-Version nicht unterstützt.</p><Link to="/cockpit">Cockpit öffnen</Link></section>;
}
