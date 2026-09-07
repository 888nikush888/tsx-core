import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphTable } from '@/features/workflows/graph-table';
import type { WorkflowGraph, WorkflowKind, WorkflowResource } from '@/app/workflow/types';

function node(id: string, kind: WorkflowKind) {
  return { id, kind, resourceVersionId: `${id}-v1`, position: { x: 0, y: 0 } };
}
const graph: WorkflowGraph = {
  schemaVersion: 3,
  nodes: [node('channel', 'channel'), node('primary', 'account'), node('fallback', 'account')],
  edges: [
    { id: 'normal', source: 'channel', target: 'primary' },
    { id: 'fallback-edge', source: 'primary', target: 'fallback', kind: 'account_fallback', channelNodeIds: ['channel'], fallbackOn: ['SYMBOL_UNAVAILABLE', 'MAX_CONCURRENT_POSITIONS'] },
  ],
};
const resources: WorkflowResource[] = graph.nodes.map((item, index) => ({
  id: item.resourceVersionId, resourceId: item.id, version: 1, kind: item.kind,
  name: ['VIP Signale', 'Primärkonto', 'Reservekonto'][index], description: '',
  status: 'published', configuration: {}, configurationSha256: 'fixture-hash', createdAt: 1, publishedAt: 1,
}));
function setup(overrides: Partial<React.ComponentProps<typeof GraphTable>> = {}) {
  const props = { graph, resources, readOnly: false, edit: vi.fn(), connect: vi.fn(), remove: vi.fn(), ...overrides };
  return { ...render(<GraphTable {...props} />), props };
}
function selectConnection(source = 'channel', target = 'primary') {
  fireEvent.change(screen.getByRole('combobox', { name: 'Von' }), { target: { value: source } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Nach' }), { target: { value: target } });
}
const connectButton = () => screen.getByRole('button', { name: 'Verbindung im Entwurf anlegen' });

describe('workflow graph table', () => {
  afterEach(cleanup);

  it('renders an empty graph without fabricating nodes or an actionable connection', () => {
    const { props } = setup({ graph: { schemaVersion: 1, nodes: [], edges: [] }, resources: [] });
    expect(screen.getByRole('table')).toHaveAccessibleName('Dieselben Bausteine und Verbindungen wie im Canvas');
    expect(screen.getAllByRole('row')).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: 'Von' })).toHaveValue('');
    expect(connectButton()).toBeDisabled();
    fireEvent.click(connectButton());
    expect(props.connect).not.toHaveBeenCalled();
  });

  it('keeps identifiers and unknown version state visible when resource metadata or edge targets are missing', () => {
    setup({ graph: { ...graph, edges: [...graph.edges, { id: 'dangling-edge', source: 'fallback', target: 'missing-node' }] }, resources: [] });
    const row = screen.getByRole('row', { name: /fallback account/ });
    expect(row).toHaveTextContent('unbekannt · unbekannt');
    expect(row).toHaveTextContent('fallback-v1');
    expect(row).toHaveTextContent('missing-node · flow · alle eingehenden Kanäle');
  });

  it('filters displayed rows by case-insensitive resource name or node kind', () => {
    setup();
    const filter = screen.getByRole('textbox', { name: 'Bausteine filtern' });
    fireEvent.change(filter, { target: { value: 'PRIMÄR' } });
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('rowheader', { name: 'Primärkonto' })).toBeVisible();
    fireEvent.change(filter, { target: { value: 'ACCOUNT' } });
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.queryByRole('rowheader', { name: 'VIP Signale' })).not.toBeInTheDocument();
    fireEvent.change(filter, { target: { value: 'no matches' } });
    expect(screen.getAllByRole('row')).toHaveLength(1);
    fireEvent.change(filter, { target: { value: '' } });
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });

  it('distinguishes ordinary edge scope from pinned fallback channels and reasons', () => {
    setup();
    const normal = screen.getByRole('row', { name: /VIP Signale channel/ });
    expect(normal).toHaveTextContent('Primärkonto · flow · alle eingehenden Kanäle');
    const fallback = screen.getByRole('row', { name: /Primärkonto account/ });
    expect(fallback).toHaveTextContent('Reservekonto · account_fallback · VIP Signale SYMBOL_UNAVAILABLE, MAX_CONCURRENT_POSITIONS');
  });

  it('edits and removes exactly the selected objects', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Baustein Reservekonto bearbeiten' }));
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung fallback-edge entfernen' }));
    expect(props.edit).toHaveBeenCalledExactlyOnceWith('fallback');
    expect(props.remove).toHaveBeenCalledExactlyOnceWith('fallback-edge');
    expect(props.connect).not.toHaveBeenCalled();
  });

  it('blocks every mutation after a selected graph becomes read-only while filtering stays available', () => {
    const { props, rerender } = setup();
    selectConnection();
    rerender(<GraphTable {...props} readOnly />);
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(screen.getByRole('combobox', { name: 'Von' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Nach' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Bausteine filtern' })).toBeEnabled();
    expect(props.connect).not.toHaveBeenCalled();
    expect(props.edit).not.toHaveBeenCalled();
    expect(props.remove).not.toHaveBeenCalled();
  });

  it('requires both endpoints and emits their IDs exactly once for a valid connection', () => {
    const { props } = setup();
    fireEvent.change(screen.getByRole('combobox', { name: 'Von' }), { target: { value: 'channel' } });
    expect(connectButton()).toBeDisabled();
    expect(within(screen.getByRole('combobox', { name: 'Nach' })).queryByRole('option', { name: 'VIP Signale · channel' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Nach' }), { target: { value: 'primary' } });
    expect(connectButton()).toBeEnabled();
    fireEvent.click(connectButton());
    expect(props.connect).toHaveBeenCalledExactlyOnceWith('channel', 'primary');
    expect(props.edit).not.toHaveBeenCalled();
    expect(props.remove).not.toHaveBeenCalled();
  });

  it('invalidates an existing target when the source changes to that same node', () => {
    const { props } = setup();
    selectConnection();
    fireEvent.change(screen.getByRole('combobox', { name: 'Von' }), { target: { value: 'primary' } });
    expect(screen.getByRole('combobox', { name: 'Nach' })).toHaveValue('');
    expect(connectButton()).toBeDisabled();
    fireEvent.click(connectButton());
    expect(props.connect).not.toHaveBeenCalled();
  });

  it.each(['channel', 'primary'])('blocks a selected connection after endpoint %s disappears from the current graph', id => {
    const { props, rerender } = setup();
    selectConnection();
    rerender(<GraphTable {...props} graph={{ ...graph, nodes: graph.nodes.filter(item => item.id !== id), edges: [] }} />);
    expect(connectButton()).toBeDisabled();
    fireEvent.click(connectButton());
    expect(props.connect).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: id === 'channel' ? 'Von' : 'Nach' })).toHaveValue('');
  });
});
