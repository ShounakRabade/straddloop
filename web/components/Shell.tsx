import type { ReactNode } from 'react';
import { SiteHeader } from './SiteHeader';
import { SiteFooter } from './SiteFooter';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main">{children}</main>
      <SiteFooter />
    </>
  );
}
