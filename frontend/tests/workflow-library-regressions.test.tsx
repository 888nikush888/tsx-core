import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationProvider } from '@/lib/navigation';
import { OperatorReadOnlyContext } from '@/shared/api/operator-session';
import { WorkflowLibrary, WorkflowObject } from '@/features/workflows/workflow-library';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), ...api }));
const observedAt = 1_780_000_000_000;
const resource = { id: 'version/1', resourceId: 'family/1', name: 'Risk source', version: 1, kind: 'sizing', status: 'draft', editRevision: 4, configuration: { riskPercent: 0, enabled: false } };
const revision = { id: 'revision/7', revision: 7, status: 'archived', graph: { nodes: [], edges: [] }, warnings: ['Original warning', 'Original warning'] };
function mount(element: ReactNode, readOnly = false) {
  return render(<NavigationProvider><OperatorReadOnlyContext.Provider value={readOnly}>{element}</OperatorReadOnlyContext.Provider></NavigationProvider>);
}
function writes() { return api.jsonRequest.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET'); }
async function refresh() { await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); }
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, '', '/workflows/resources'); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
afterEach(cleanup);

describe('workflow library filtering and object navigation', () => {
  it.each([
    ['resources', { ...resource, createdAt: observedAt }, 'Risk source · v1', '/workflows/resources/family%2F1/versions/version%2F1', 'Bausteinart'],
    ['paths', { id: 'path/1', accountId: 'account/1', channelId: 'channel', enabled: 1 }, 'path/1', '/workflows/paths/path%2F1', 'Fallbackrang (0 = primär)'],
    ['revisions', revision, 'Revision 7', '/workflows/revisions/revision%2F7', 'Erstellt von'],
  ] as const)('shows the correct %s object links and clears paging on filter changes', async (kind, entry, title, href, column) => {
    api.jsonRequest.mockResolvedValue({ entries: [entry], hasMore: true, nextCursor: 'next-page', observedAt });
    mount(<WorkflowLibrary kind={kind} />);
    expect(await screen.findByRole('link', { name: title })).toHaveAttribute('href', href);
    expect(screen.getByRole('columnheader', { name: column })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Nächste Seite' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('cursor')).toBe('next-page'));
    const filter = kind === 'paths' ? screen.getByLabelText('Revision-ID') : screen.getByLabelText('Versionsstatus');
    fireEvent.change(filter, { target: { value: kind === 'paths' ? 'revision/7' : 'archived' } });
    await waitFor(() => expect(new URLSearchParams(window.location.search).has('cursor')).toBe(false));
    expect(api.jsonRequest.mock.calls.at(-1)?.[0]).toContain(kind === 'paths' ? 'revisionId=revision%2F7' : 'status=archived');
    fireEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(writes()).toHaveLength(0);
  });

  it('retains the last library evidence with a stale warning after a read fails', async () => {
    api.jsonRequest.mockResolvedValue({ entries: [resource], hasMore: false, observedAt });
    mount(<WorkflowLibrary kind="resources" resourceId={resource.resourceId} />);
    await screen.findByRole('link', { name: 'Risk source · v1' });
    expect(screen.getByRole('button', { name: 'Nächste Seite' })).toBeDisabled();
    api.jsonRequest.mockRejectedValue(new Error('Library offline'));
    await refresh();
    expect(await screen.findByRole('alert')).toHaveTextContent('Library offline · Angezeigte Daten können veraltet sein.');
    expect(screen.getByRole('link', { name: 'Risk source · v1' })).toBeVisible();
  });
});

describe('resource lifecycle intent and confirmation', () => {
  it.each([
    ['draft', 'Version publizieren', 'Ressourcenversion publizieren', 'Publizieren', 'publish', false, 'publish-workflow-dependencies', 'Publikation bestätigt. Noch keine neue Graphaktivierung.'],
    ['published', 'Version archivieren', 'Ressource archivieren', 'Archivieren', 'archive', false, 'delete-workflow-resource', 'Archivierung bestätigt.'],
    ['draft', 'Entwurf löschen', 'Ressource dauerhaft löschen', 'Löschen', 'archive', false, 'delete-workflow-resource', 'Löschung bestätigt; die alte Objektadresse kann nun 404 melden.'],
    ['published', 'Familie dauerhaft löschen', 'Ressource dauerhaft löschen', 'Löschen', 'delete', true, 'delete-workflow-resource-permanently', 'Löschung bestätigt; die alte Objektadresse kann nun 404 melden.'],
  ] as const)('keeps %s / %s bound to its exact version or family command', async (status, button, title, confirmLabel, operation, family, confirmation, success) => {
    const original = { resource: { ...resource, status }, activePaths: [], observedAt, publication: { publicationHash: 'fixture-publication', dependency: { id: 'model-version' } } };
    api.jsonRequest.mockResolvedValue(original);
    mount(<WorkflowObject kind="resources" id={resource.id} resourceId={resource.resourceId} />);
    fireEvent.click(await screen.findByRole('button', { name: button, exact: true }));
    const dialog = await screen.findByRole('dialog', { name: title });
    expect(writes()).toHaveLength(0);
    if (confirmLabel === 'Löschen') {
      expect(within(dialog).getByRole('button', { name: confirmLabel })).toBeDisabled();
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'RESSOURCE LÖSCHEN' } });
    }
    fireEvent.click(within(dialog).getByRole('button', { name: confirmLabel }));
    expect(await screen.findByText(success)).toBeVisible();
    expect(writes()).toHaveLength(1);
    const [url, init] = writes()[0];
    expect(url).toBe(operation === 'publish' ? '/api/workflow/resources/publish' : '/api/workflow/resources');
    expect(init.method).toBe(operation === 'publish' ? 'POST' : 'DELETE');
    expect(init.headers['X-Destructive-Confirmation']).toBe(confirmation);
    expect(JSON.parse(init.body)).toEqual(operation === 'publish'
      ? { id: resource.id, baseEditRevision: 4, publishDependencies: true, publicationHash: 'fixture-publication' }
      : { [family ? 'resourceId' : 'id']: family ? resource.resourceId : resource.id, operation });
    expect(writes().some(([address]) => address.includes('activate'))).toBe(false);
  });

  it('blocks viewer lifecycle commands and rejects a mismatched resource family', async () => {
    api.jsonRequest.mockResolvedValue({ resource, activePaths: [], observedAt });
    const view = mount(<WorkflowObject kind="resources" id={resource.id} />, true);
    expect(await screen.findByRole('button', { name: 'Version publizieren' })).toBeDisabled();
    for (const button of ['Entwurf bearbeiten', 'Entwurf löschen', 'Familie archivieren', 'Familie dauerhaft löschen']) expect(screen.getByRole('button', { name: button })).toBeDisabled();
    expect(writes()).toHaveLength(0);
    view.unmount();
    mount(<WorkflowObject kind="resources" id={resource.id} resourceId="another-family" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Diese Version gehört nicht zur angefragten Ressourcenfamilie.');
    expect(screen.queryByRole('button', { name: 'Version publizieren' })).not.toBeInTheDocument();
  });

  it('retains an unknown lifecycle outcome without retrying on the next poll', async () => {
    api.jsonRequest.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method) throw new TypeError('Transport lost');
      return { resource: { ...resource, status: 'published' }, activePaths: [], observedAt };
    });
    mount(<WorkflowObject kind="resources" id={resource.id} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Version archivieren' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Archivieren' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Aktion nicht bestätigt: Transport lost. Keine automatische Wiederholung.');
    await refresh();
    expect(writes()).toHaveLength(1);
  });
});

describe('historical workflow evidence', () => {
  it('preserves absent, null, structured and false strategy values and links each source version', async () => {
    const values = [undefined, null, { limit: 0 }, false];
    api.jsonRequest.mockResolvedValue({ revision, path: { id: 'path', accountId: 'account/1', channelId: 'channel/1', fallbackRank: 0, effectiveConfiguration: {} }, observedAt, integrityVerified: true,
      sources: [{ nodeId: 'gone', resource: null }, { nodeId: 'current', resource }],
      parameterEffects: values.map((value, index) => ({ field: `parameter-${index}`, value: value ?? null, strategyValuePresent: index !== 0, strategyValue: value,
        source: 'sizing', resourceId: index === 0 ? null : resource.resourceId, sourceVersionId: index === 0 ? null : resource.id, overridesStrategy: index > 0 })),
    });
    mount(<WorkflowObject kind="paths" id="path" />);
    const table = await screen.findByRole('table', { name: 'Wirksame Strategieparameter und Ursprung' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map(row => within(row).getAllByRole('cell')[4].textContent)).toEqual(['nicht gesetzt', 'null', '{"limit":0}', 'nein']);
    expect(rows.map(row => within(row).getAllByRole('cell')[1].textContent)).toEqual(['null', 'null', '{"limit":0}', 'nein']);
    expect(within(table).getAllByRole('link')[0]).toHaveAttribute('href', '/workflows/resources/family%2F1/versions/version%2F1');
    expect(screen.getByText('Originalquelle nicht verfügbar')).toBeVisible();
    expect(screen.getAllByText('Original warning')).toHaveLength(2);
  });

  it('restores an archived graph only into a draft pinned to the observed active revision', async () => {
    api.jsonRequest.mockImplementation(async (url: string) => {
      if (url === '/api/workflow/drafts?id=operator') return { draft: { version: 9 } };
      if (url === '/api/workflow') return { workflow: { id: 'active-revision' } };
      return { revision, sources: [], observedAt };
    });
    mount(<WorkflowObject kind="revisions" id={revision.id} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Historischen Graph als Entwurf übernehmen' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Operatorentwurf 9');
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Entwurf übernehmen' }));
    await screen.findByText(/Historischer Graph als neuer Operatorentwurf gespeichert/);
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe('/api/workflow/drafts');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ id: 'operator', baseVersion: 9, baseRevisionId: 'active-revision', graph: revision.graph });
  });
});
