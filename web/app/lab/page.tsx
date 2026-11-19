import type { Metadata } from 'next';
import { LabClient } from './LabClient';
import './lab.css';

export const metadata: Metadata = { title: 'Lab', description: 'Change a rule and rerun the backtest in your browser, on the synthetic model or on real NIFTY option candles.' };

/** The Lab is a full-width workspace with its own app bar, so it does not use the site Shell. */
export default function LabPage() {
  return <LabClient />;
}
