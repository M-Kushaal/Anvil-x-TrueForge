// Small text helpers shared by the extension and the webview.

/** "1 file", "3 files". */
export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** 850 → "850", 12400 → "12.4k". */
export const compactNumber = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** 38000 → "38s", 95000 → "1m 35s". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
