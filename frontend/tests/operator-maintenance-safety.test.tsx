import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationProvider } from '@/lib/navigation';
import { OperatorReadOnlyContext } from '@/shared/api/operator-session';
import { BackupsPage } from '@/features/operations/backups-page';
import { JobsPage } from '@/features/operations/jobs-page';
import { System } from '@/features/operations/system';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), ...api }));
vi.mock('@/features/signals/telegram-settings', () => ({ TelegramSettings: () => null }));

const now = 1_780_000_000_000;
const artifact = 'backup-recovery.tgfb';
const job = { id: 'job-1', kind: 'backup-restore', state: 'unknown', actorId: 'operator', acceptedAt: now, updatedAt: now, stage: 'restore-started', error: 'Dienstverbindung unterbrochen' };

function mount(element: ReactNode, readOnly = false) {
  return render(<NavigationProvider><OperatorReadOnlyContext.Provider value={readOnly}>{element}</OperatorReadOnlyContext.Provider></NavigationProvider>);
}
function writes() { return api.jsonRequest.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET'); }
async function refreshVisiblePage() {
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
}
async function acceptRestore() {
  fireEvent.click(await screen.findByRole('button', { name: 'Wiederherstellen' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(dialog.querySelector('input')!, { target: { value: 'RESTORE' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Wiederherstellen' }).at(-1)!);
}

describe('operator maintenance safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    window.history.replaceState(null, '', '/operations/backups');
    api.jsonRequest.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/backups/verify')) return { evidence: { artifactSha256: 'verified-sha', restoreEligibility: { status: 'eligible' } } };
      if (url === '/api/backups') return { backups: [artifact] };
      if (url.startsWith('/api/operations/jobs')) return { job };
      if (url === '/api/operations') return { operations: { backup: { healthy: true, restoreEligibility: { status: 'eligible' } } } };
      if (url === '/api/runtime-settings') return { settings: {}, revision: 1, parameters: [] };
      if (url === '/api/recovery') return { serverInstanceId: 'instance-before', active: false };
      return {};
    });
  });
  afterEach(cleanup);

  it('keeps backup evidence readable while viewer commands remain disabled', async () => {
    mount(<BackupsPage name={artifact} />, true);
    expect(await screen.findByText('verified-sha')).toBeVisible();
    for (const name of ['Isolierten Probelauf starten', 'Wiederherstellen']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(writes()).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not restore when confirmation is cancelled or the required text is missing', async () => {
    mount(<BackupsPage name={artifact} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Wiederherstellen' }));
    await screen.findByRole('dialog');
    expect(screen.getAllByRole('button', { name: 'Wiederherstellen' }).at(-1)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(writes()).toHaveLength(0);
  });

  it('retains the restore receipt address after a lost response and only repeats reads', async () => {
    const read = api.jsonRequest.getMockImplementation()!;
    api.jsonRequest.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new TypeError('Verbindung verloren');
      return read(url, init);
    });
    mount(<BackupsPage name={artifact} />);
    await acceptRestore();
    expect(await screen.findByRole('alert')).toHaveTextContent('Aktion nicht bestätigt');
    expect(screen.getByRole('alert')).toHaveTextContent('Nicht automatisch wiederholen');
    expect(writes()).toHaveLength(1);
    const [url, init] = writes()[0];
    const payload = JSON.parse(init.body);
    expect(url).toBe('/api/backups/restore');
    expect(payload).toMatchObject({ name: artifact, jobId: expect.any(String) });
    expect(init.headers['X-Operator-Job-ID']).toBe(payload.jobId);
    expect(init.headers['X-Destructive-Confirmation']).toBe('restore-backup');
    const link = screen.getByRole('link', { name: `Auftrag ${payload.jobId} prüfen` });
    expect(link).toHaveAttribute('href', `/operations/jobs/${payload.jobId}`);
    await refreshVisiblePage();
    await refreshVisiblePage();
    expect(writes()).toHaveLength(1);
    expect(link).toBeVisible();
  });

  it('reports an accepted backup as a pending job without inventing a completed artifact', async () => {
    const read = api.jsonRequest.getMockImplementation()!;
    api.jsonRequest.mockImplementation(async (url: string, init?: RequestInit) => init?.method === 'POST' ? { job: { state: 'accepted' } } : read(url, init));
    mount(<BackupsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt sichern' }));
    expect(await screen.findByText(/Auftrag dauerhaft angenommen/)).toBeVisible();
    expect(screen.queryByText('Abschluss belegt')).not.toBeInTheDocument();
    expect(writes()[0][0]).toBe('/api/operations/backup');
    expect(writes()[0][1].headers['X-Destructive-Confirmation']).toBeUndefined();
    await refreshVisiblePage();
    expect(writes()).toHaveLength(1);
  });

  it('keeps the last job evidence with a stale warning when a later read fails', async () => {
    mount(<JobsPage id={job.id} />);
    expect(await screen.findByRole('heading', { name: 'Ergebnis unbekannt – keine automatische Wiederholung' })).toBeVisible();
    api.jsonRequest.mockRejectedValue(new Error('Statusquelle nicht erreichbar'));
    await refreshVisiblePage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Letzte Anzeige möglicherweise veraltet; kein Abschlussbeleg');
    expect(screen.getByText('restore-started')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Abschluss belegt' })).not.toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it('isolates an obsolete job response after navigation to a different job', async () => {
    let resolveOld!: (value: unknown) => void;
    api.jsonRequest.mockImplementation((url: string) => url.includes('id=old') ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve({ job: { ...job, id: 'current', state: 'failed', stage: 'current-job-stage' } }));
    const { rerender } = mount(<JobsPage id="old" />);
    await waitFor(() => expect(resolveOld).toBeDefined());
    rerender(<NavigationProvider><JobsPage id="current" /></NavigationProvider>);
    expect(await screen.findByText('current-job-stage')).toBeVisible();
    await act(async () => resolveOld({ job: { ...job, id: 'old', state: 'succeeded', stage: 'obsolete-success' } }));
    expect(screen.queryByText('obsolete-success')).not.toBeInTheDocument();
    expect(screen.getByText('current-job-stage')).toBeVisible();
    expect(writes()).toHaveLength(0);
  });

  it('preserves a factory-reset job ID when acceptance is unknown, without replaying reset', async () => {
    const read = api.jsonRequest.getMockImplementation()!;
    api.jsonRequest.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/factory-reset') throw new TypeError('Verbindung verloren');
      return read(url, init);
    });
    const refresh = vi.fn(async () => undefined);
    mount(<System catalog={null} systemStatus={null} onRefresh={refresh} />);
    await screen.findByText(/lokal wiederherstellbar/);
    fireEvent.change(screen.getByPlaceholderText('DATENBANK LEEREN oder FACTORY RESET'), { target: { value: 'FACTORY RESET' } });
    fireEvent.click(screen.getByRole('button', { name: 'Factory Reset' }));
    expect(await screen.findByText(/Factory Reset nicht bestätigt/)).toBeVisible();
    const [url, init] = writes()[0];
    const payload = JSON.parse(init.body);
    expect(url).toBe('/api/factory-reset');
    expect(payload).toEqual({ confirmation: 'FACTORY RESET', jobId: expect.any(String) });
    expect(screen.getByRole('link', { name: `Auftrag ${payload.jobId} prüfen` })).toHaveAttribute('href', `/operations/jobs/${payload.jobId}`);
    await refreshVisiblePage();
    expect(writes()).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
