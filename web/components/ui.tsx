import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

/** The offset shadow is a deliberate part of the printed-blotter look (see DESIGN.md), so the detector skips it. */
export const hard = { 'data-impeccable-ignore': 'hard-offset-shadow' } as const;

export function Logo({ href = '/' }: { href?: string }) {
  return (
    <Link href={href} className="logo" aria-label="Straddloop home">
      <span aria-hidden="true">straddl</span>
      <svg viewBox="0 0 62 33" fill="none" aria-hidden="true">
        <path d="M31 16.5C25 7 20.5 4 14.5 4a12.5 12.5 0 1 0 0 25C20.5 29 25 26 31 16.5Zm0 0C37 26 41.500 29 47.500 29a12.500 12.500 0 1 0 0-25C41.500 4 37 7 31 16.500Z" stroke="var(--cobalt)" strokeWidth="7.5" strokeLinejoin="round" />
      </svg>
      <span aria-hidden="true">p</span>
    </Link>
  );
}

type BtnProps = { variant?: 'primary' | 'marker' | 'plain'; size?: 'sm' | 'lg'; arrow?: boolean; children: ReactNode };
const cls = (variant?: string, size?: string, extra?: string) =>
  ['btn', variant && variant !== 'plain' ? `btn--${variant}` : '', size ? `btn--${size}` : '', extra ?? ''].filter(Boolean).join(' ');

export function ButtonLink({ variant, size, arrow, children, className, ...rest }: BtnProps & ComponentProps<typeof Link>) {
  return (
    <Link {...rest} {...hard} className={cls(variant, size, className)}>
      {children}{arrow && <span className="arrow" aria-hidden="true">→</span>}
    </Link>
  );
}

export function Button({ variant, size, arrow, children, className, ...rest }: BtnProps & ComponentProps<'button'>) {
  return (
    <button type="button" {...rest} {...hard} className={cls(variant, size, className)}>
      {children}{arrow && <span className="arrow" aria-hidden="true">→</span>}
    </button>
  );
}

export function SyntheticNote({ children }: { children?: ReactNode }) {
  return (
    <div className="callout" role="note">
      <span className="tag">Synthetic</span>
      <p>{children ?? 'These figures come from a labelled synthetic model with dates in 2099, not from NSE data. They show how the rules behave under assumptions. They are not evidence about real markets and not investment advice.'}</p>
    </div>
  );
}
