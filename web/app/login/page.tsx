import type { Metadata } from 'next';
import { Shell } from '@/components/Shell';
import { Auth } from './Auth';

export const metadata: Metadata = { title: 'Sign in' };
export default function LoginPage() { return <Shell><Auth /></Shell>; }
