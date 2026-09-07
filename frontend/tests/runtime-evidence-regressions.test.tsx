import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeParameters, runtimeInputError } from '@/features/operations/runtime-parameters';
import { EvidenceFields, EvidenceTable } from '@/shared/components/evidence';

afterEach(cleanup);

const parameter: NonNullable<Parameters<typeof runtimeInputError>[1]>[number] = {
  path: 'text', group: 'Runtime', type: 'string', unit: null, default: '', range: null,
  values: null, maxLength: 30, nullable: false, editable: true, secret: false,
  environmentName: 'FIXTURE_SETTING', source: 'fixture', requiresRestart: false,
};
const parameters: NonNullable<Parameters<typeof runtimeInputError>[1]> = [
  parameter,
  { ...parameter, path: 'count', type: 'number', unit: 'ms', range: [0, 10], default: 0, requiresRestart: true },
  { ...parameter, path: 'enabled', type: 'boolean', default: false },
  { ...parameter, path: 'mode', values: ['first', 'second'], default: 'first' },
];

function EditableRuntime() {
  const [value, setValue] = useState<Record<string, unknown>>({ text: '', count: 0, enabled: false, mode: 'first', futureField: { preserved: true } });
  return <>
    <RuntimeParameters value={value} onChange={setValue} payload={{
      parameters, settings: { text: '', count: 0, enabled: false }, active: { text: null, count: 5, enabled: true },
    }} />
    <pre aria-label="Submitted runtime draft">{JSON.stringify(value)}</pre>
    <p role="status">{runtimeInputError(value, parameters) ?? 'Valid runtime draft'}</p>
  </>;
}

describe('runtime field and evidence value contracts', () => {
  it('edits numeric, boolean, selection and text controls while preserving unknown server fields', () => {
    render(<EditableRuntime />);
    expect(screen.getByRole('spinbutton', { name: /^count / })).toHaveValue(0);
    expect(screen.getByRole('checkbox', { name: /^enabled/ })).not.toBeChecked();
    fireEvent.change(screen.getByRole('textbox', { name: /^text/ }), { target: { value: 'new value' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: /^count / }), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /^enabled/ }));
    fireEvent.change(screen.getByRole('combobox', { name: /^mode/ }), { target: { value: 'second' } });
    expect(JSON.parse(screen.getByLabelText('Submitted runtime draft').textContent!)).toEqual({
      text: 'new value', count: 7, enabled: true, mode: 'second', futureField: { preserved: true },
    });
    expect(screen.getByRole('status')).toHaveTextContent('Valid runtime draft');
    fireEvent.change(screen.getByRole('spinbutton', { name: /^count / }), { target: { value: '' } });
    expect(screen.getByRole('spinbutton', { name: /^count / })).toHaveValue(null);
    expect(screen.getByRole('status')).toHaveTextContent('count: ganze Zahl 0 bis 10 erforderlich.');
  });

  it('distinguishes saved false, zero, empty, absent and null observations', () => {
    render(<EditableRuntime />);
    expect(screen.getByRole('textbox', { name: /^text/ }).closest('label')).toHaveTextContent('Gespeichert: leer · aktiv beim Start: null');
    expect(screen.getByRole('spinbutton', { name: /^count / }).closest('label')).toHaveTextContent('Gespeichert: 0 · aktiv beim Start: 5');
    expect(screen.getByRole('checkbox', { name: /^enabled/ }).closest('label')).toHaveTextContent('Gespeichert: nein · aktiv beim Start: ja');
    expect(screen.getByRole('combobox', { name: /^mode/ }).closest('label')).toHaveTextContent('Gespeichert: nicht beobachtet');
  });

  it('keeps protected and unknown runtime fields disabled and withholds secret field values', () => {
    const onChange = vi.fn();
    const { rerender } = render(<RuntimeParameters value={{ text: 'configured', unknown: { enabled: true } }} onChange={onChange} payload={{ parameters: [
      { ...parameter, editable: false }, { ...parameter, path: 'unknown', type: 'object' },
      { ...parameter, path: 'secret', secret: true },
    ] }} />);
    for (const control of screen.getAllByRole('textbox')) expect(control).toBeDisabled();
    expect(screen.getAllByDisplayValue('Unbekannter Feldtyp / schreibgeschützt')).toHaveLength(2);
    rerender(<RuntimeParameters value={{ text: 'configured', count: 0, enabled: false, mode: 'first' }} onChange={onChange} payload={{ parameters }} readOnly />);
    for (const role of ['textbox', 'spinbutton', 'checkbox', 'combobox']) expect(screen.getByRole(role)).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders evidence cells without losing zero, false, empty strings or embedded links', () => {
    render(<>
      <EvidenceFields fields={[
        ['Missing', undefined], ['Null', null], ['Empty', ''], ['False', false], ['True', true], ['Zero', 0],
      ]} />
      <EvidenceTable caption="Observed values" rows={[{ id: 'row', missing: undefined, null: null, empty: '', no: false, yes: true, zero: 0, link: <a href="/proof">Original proof</a> }]}
        columns={[['missing', 'Missing'], ['null', 'Null'], ['empty', 'Empty'], ['no', 'False'], ['yes', 'True'], ['zero', 'Zero'], ['link', 'Proof']]} />
    </>);
    expect(screen.getAllByRole('definition').map(cell => cell.textContent)).toEqual(['nicht verfügbar', 'nicht verfügbar', 'leer', 'nein', 'ja', '0']);
    expect(within(screen.getByRole('table')).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['nicht verfügbar', 'nicht verfügbar', '', 'nein', 'ja', '0', 'Original proof']);
    expect(screen.getByRole('link', { name: 'Original proof' })).toHaveAttribute('href', '/proof');
  });

  it('shows the absence of table evidence and supports rows without an external identifier', () => {
    const { rerender } = render(<EvidenceTable caption="Empty observations" rows={[]} columns={[["state", "State"]]} />);
    expect(screen.getByText('Keine belegten Einträge.')).toBeVisible();
    rerender(<EvidenceTable caption="Empty observations" rows={[{ state: 'observed' }]} columns={[["state", "State"]]} />);
    expect(screen.queryByText('Keine belegten Einträge.')).not.toBeInTheDocument();
    expect(screen.getByRole('cell')).toHaveTextContent('observed');
  });
});
