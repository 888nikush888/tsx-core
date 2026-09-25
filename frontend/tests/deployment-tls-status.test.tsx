import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), ...api }));

import { DeploymentEvidence } from '@/features/operations/deployment';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows all five TLS paths, missing peer state and only non-secret certificate metadata', async () => {
  api.jsonRequest.mockResolvedValue({
    observedAt: Date.now(),
    listener: { address: '127.0.0.1', port: 8080, interpretation: 'Internal' },
    process: { platform: 'linux', nodeVersion: 'v22', availableCpuParallelism: 2, operatingSystemMemoryBytes: '1000', interpretation: 'OS' },
    limits: { memory: null, cpu: null, interpretation: 'Limits' }, declarations: [], boundary: 'External deployment',
    tls: {
      trustAnchor: { state: 'available', earliestExpiryAt: '2026-10-30T00:00:00.000Z', certificates: [
        { fingerprint256: 'CA:FINGERPRINT:ONE', expiresAt: '2026-11-01T00:00:00.000Z' },
        { fingerprint256: 'CA:FINGERPRINT:TWO', expiresAt: '2026-10-30T00:00:00.000Z' },
      ] },
      endpoints: [
        { id: 'dashboard', label: 'Dashboard', file: { state: 'available', certificate: { fingerprint256: 'FILE:FINGERPRINT', subjectAltName: 'DNS:new-host', expiresAt: '2026-11-01T00:00:00.000Z' } }, active: { state: 'observed', certificate: { fingerprint256: 'ACTIVE:FINGERPRINT', subjectAltName: 'DNS:localhost', expiresAt: '2026-10-01T00:00:00.000Z' }, checkedAt: Date.now() }, activeMatchesFile: false },
        ...['Messwerte', 'Alarmweiterleitung', 'Viewer-Status', 'Exchange Executor'].map((label, index) => ({ id: `peer-${index}`, label, file: { state: 'not_visible', certificate: null }, active: { state: 'unreachable', certificate: null, checkedAt: Date.now() }, activeMatchesFile: null })),
      ], interpretation: 'Nicht erreichbare Dienste bleiben unbekannt.',
    },
  });
  render(<DeploymentEvidence />);
  const table = await screen.findByRole('table', { name: 'TLS-Zertifikate der fünf internen Wege' });
  for (const label of ['Dashboard', 'Messwerte', 'Alarmweiterleitung', 'Viewer-Status', 'Exchange Executor']) {
    expect(within(table).getByText(label)).toBeVisible();
  }
  expect(within(table).getAllByText('nicht erreichbar')).toHaveLength(4);
  expect(screen.getByText('CA:FINGERPRINT:ONE')).toBeVisible();
  expect(screen.getByText('CA:FINGERPRINT:TWO')).toBeVisible();
  expect(within(table).getByText('ACTIVE:FINGERPRINT')).toBeVisible();
  expect(within(table).getByText('FILE:FINGERPRINT')).toBeVisible();
  expect(within(table).getByText('DNS:localhost')).toBeVisible();
  expect(within(table).getByText('DNS:new-host')).toBeVisible();
  expect(within(table).getByText('nein – Datei und Listener weichen ab')).toBeVisible();
  expect(within(table).getByText('2026-10-01T00:00:00.000Z')).toBeVisible();
  expect(within(table).getByText('2026-11-01T00:00:00.000Z')).toBeVisible();
  expect(screen.queryByText('Zertifikatsdatei gültig')).not.toBeInTheDocument();
  expect(screen.getByText(/Zertifikatsverwaltung und Rotation erfolgen derzeit außerhalb/)).toBeVisible();
  expect(document.body.textContent).not.toContain('PRIVATE KEY');
});
