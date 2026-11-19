import type { Metadata } from 'next';
import { Onboarding } from './Onboarding';

export const metadata: Metadata = { title: 'Your first backtest', description: 'Four short steps to your first Straddloop backtest. No account needed.' };

export default function StartPage() { return <Onboarding />; }
