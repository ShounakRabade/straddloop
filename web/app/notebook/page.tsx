import type { Metadata } from 'next';
import { Shell } from '@/components/Shell';
import { Notebook } from './Notebook';

export const metadata: Metadata = { title: 'Notebook', description: 'Your saved backtest runs.' };
export default function NotebookPage() { return <Shell><Notebook /></Shell>; }
