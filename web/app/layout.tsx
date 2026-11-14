import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

const archivo = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-archivo', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-plex-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Straddloop: option strategies, tested as rules', template: '%s · Straddloop' },
  description: 'Three customized option trading strategies for Indian markets, written as formal rules and backtested after costs on a labelled synthetic model. Research only, not investment advice.',
  openGraph: { title: 'Straddloop', description: 'Customized option trading strategies, written as rules and tested after costs.', type: 'website' },
};
export const viewport: Viewport = { themeColor: '#f6f3ea', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${archivo.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
