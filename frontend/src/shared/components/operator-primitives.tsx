import type { ReactNode } from 'react';

export function time(value: unknown): string {
  return typeof value === 'number' && value > 0 ? new Date(value).toLocaleString('de-DE') : '–';
}
export function Metric({ label, value, danger = false }: { label: string; value: ReactNode; danger?: boolean }) {
  return <div className={`operation-metric ${danger ? 'danger' : ''}`}><strong>{value}</strong><span>{label}</span></div>;
}
export function Empty({ text }: { text: string }) { return <div className="operations-empty">{text}</div>; }
