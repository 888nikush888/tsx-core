import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeParameters, runtimeInputError } from '@/features/operations/runtime-parameters';

afterEach(cleanup);

const parameter = {
  path: 'clockMaxDriftMs', group: 'Laufzeit', type: 'number', unit: 'ms', default: 1000,
  range: [100, 5000] as [number, number], values: null, maxLength: 2048, nullable: false,
  editable: true, secret: false, environmentName: 'CLOCK_MAX_DRIFT_MS',
  source: 'managed-runtime-store', requiresRestart: true,
};

it('shows bounded stored and active clock thresholds without changing the guard on edit', () => {
  const onChange = vi.fn();
  const payload = { parameters: [parameter], settings: { clockMaxDriftMs: 450 }, active: { clockMaxDriftMs: 1000 } };
  render(<RuntimeParameters value={{ clockMaxDriftMs: 450 }} onChange={onChange} payload={payload} />);
  const input = screen.getByRole('spinbutton');
  expect(input).toHaveAttribute('min', '100');
  expect(input).toHaveAttribute('max', '5000');
  expect(input).toHaveAttribute('step', '1');
  expect(input).toHaveValue(450);
  expect(screen.getByText(/Gespeichert: 450 · aktiv beim Start: 1000/)).toBeInTheDocument();
  fireEvent.change(input, { target: { value: '500' } });
  expect(onChange).toHaveBeenCalledWith({ clockMaxDriftMs: 500 });
  expect(payload.active.clockMaxDriftMs).toBe(1000);
});

it('rejects invalid UI values and leaves a read-only operator unable to edit', () => {
  for (const value of [99, 5001, 500.5, Number.NaN, '500']) {
    expect(runtimeInputError({ clockMaxDriftMs: value }, [parameter])).toMatch(/clockMaxDriftMs/);
  }
  expect(runtimeInputError({ clockMaxDriftMs: 100 }, [parameter])).toBeNull();
  expect(runtimeInputError({ clockMaxDriftMs: 5000 }, [parameter])).toBeNull();
  render(<RuntimeParameters value={{ clockMaxDriftMs: 450 }} onChange={vi.fn()}
    payload={{ parameters: [parameter] }} readOnly />);
  expect(screen.getByRole('spinbutton')).toBeDisabled();
});
