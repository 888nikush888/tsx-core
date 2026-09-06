import { useEffect } from 'react';

/** Only known setting IDs may choose an element; no arbitrary query selectors or draft values. */
export function useSettingFocus(known: string[]) {
  const selected = new URLSearchParams(window.location.search).get('setting'); const available = known.join('|');
  useEffect(() => {
    if (!selected || !available.split('|').includes(selected)) return;
    const target = document.getElementById(`setting-${selected}`);
    target?.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    target?.querySelector<HTMLElement>('input, select, textarea')?.focus({ preventScroll: true });
  }, [selected, available]);
}
