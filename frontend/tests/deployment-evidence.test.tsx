import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DeploymentEvidence } from '@/features/operations/deployment';

const api = vi.hoisted(() => ({ jsonRequest: vi.fn() }));
vi.mock('@/lib/api', () => api);

const observation = {
  observedAt: 1_780_000_000_000,
  listener: { source: 'socket', interpretation: 'Listener evidence only.' },
  process: { platform: 'linux', nodeVersion: 'v22.23.2', availableCpuParallelism: 2,
    operatingSystemMemoryBytes: '9007199254740993', source: 'os', interpretation: 'Observed operating system.' },
  limits: { memory: null, cpu: null, interpretation: 'Unreadable limits remain unknown.' },
  declarations: [{ name: 'HOST_WEB_PORT', value: null, source: 'process.env.HOST_WEB_PORT', interpretation: 'Declaration only.' }],
  boundary: 'Deployment changes require operator action.',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('__UI_VERSION__', 'test-build');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('preserves unknown listener and kernel limits without inventing deployment values', async () => {
  api.jsonRequest.mockResolvedValue(observation);
  render(<DeploymentEvidence />);
  expect(await screen.findByText('unbekannt:unbekannt')).toBeVisible();
  expect(screen.getByText('9007199254740993')).toBeVisible();
  const memory = screen.getByText('Sichtbares cgroup-RAM-Limit (Bytes oder max)').parentElement;
  if (!memory) throw new Error('Memory evidence row missing.');
  expect(within(memory).getByText('nicht verfügbar')).toBeVisible();
  expect(screen.getByText(observation.boundary)).toBeVisible();
});

it('shows literal kernel declarations and an explicitly observed zero port', async () => {
  api.jsonRequest.mockResolvedValue({ ...observation,
    listener: { ...observation.listener, address: '127.0.0.1', port: 0 },
    limits: { ...observation.limits, memory: { source: 'memory.max', value: 'max' },
      cpu: { source: 'cpu.max', value: '200000 100000' } },
  });
  render(<DeploymentEvidence />);
  expect(await screen.findByText('127.0.0.1:0')).toBeVisible();
  expect(screen.getByText('max')).toBeVisible();
  expect(screen.getByText('200000 100000')).toBeVisible();
});
