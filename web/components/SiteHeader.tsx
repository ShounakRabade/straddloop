'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Logo, ButtonLink, Button } from './ui';
import { useSession } from '@/lib/useSession';
import { cloudEnabled } from '@/lib/supabase';

const links = [
  { href: '/#strategies', label: 'Strategies', match: '/strategies' },
  { href: '/lab', label: 'Lab', match: '/lab' },
  { href: '/notebook', label: 'Notebook', match: '/notebook' },
];

export function SiteHeader() {
  const path = usePathname();
  const { session, ready } = useSession();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  return (
    <header className="site-header">
      <a href="#main" className="skip">Skip to content</a>
      <div className="wrap">
        <Logo />
        <Button className="menu-btn" size="sm" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Menu'}</Button>
        <nav id="site-nav" className="nav" data-open={open} aria-label="Main">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="nav-link" aria-current={path.startsWith(l.match) ? 'page' : undefined}>{l.label}</Link>
          ))}
          {cloudEnabled && ready && (
            <Link href="/login" className="nav-link" aria-current={path === '/login' ? 'page' : undefined}>{session ? 'Account' : 'Sign in'}</Link>
          )}
          <ButtonLink href="/start" variant="primary" size="sm">Run a backtest</ButtonLink>
        </nav>
      </div>
    </header>
  );
}
