/** Anvil brand mark: single colour, inherits currentColor. */
export function Mark({ size = 16, class: className }: { size?: number; class?: string }) {
  return (
    <svg class={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M2 6h14.5c1.6 0 3-.9 3.7-2.3L21 2v5.2A4.8 4.8 0 0 1 16.2 12H15l1.2 4H18v3H6v-3h1.8L9 12H6.5A4.5 4.5 0 0 1 2 7.5z" />
      <rect x="4" y="20" width="16" height="2" rx="1" />
    </svg>
  );
}
