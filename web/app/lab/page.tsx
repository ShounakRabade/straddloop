import type { Metadata } from 'next';
import { Shell } from '@/components/Shell';
import { LabClient } from './LabClient';

export const metadata: Metadata = { title: 'Lab', description: 'Change a rule and rerun the backtest in your browser, on synthetic data.' };

export default function LabPage() {
  return <Shell><LabClient /></Shell>;
}
