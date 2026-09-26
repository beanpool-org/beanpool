/**
 * Settings → Account & Identity as the member sees it, rendered by the real SettingsPage so signin-recovery-check.mjs
 * can photograph and measure the whole recovery section at 320px with 1.3x text: the words banner, View Recovery
 * Phrase and "Sign-in recovery", for a browser that holds the 12 words (`?words=1`) and one restored from a sign-in
 * copy without them (`?words=0`, web-restore.ts), and the words screen (`&mode=seed`). The node's answers (the list of
 * sign-ins, POST /api/recovery/shares/status) come from the check's page route, never a node; the harness stores no
 * identity, so nothing is signed.
 */
import { createRoot } from 'react-dom/client';
import { SettingsPage } from '../src/pages/SettingsPage';
import type { BeanPoolIdentity } from '../src/lib/identity';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const identity: BeanPoolIdentity = {
    publicKey: 'a1'.repeat(32),
    privateKey: 'b2'.repeat(48),
    callsign: 'Harness',
    createdAt: '2026-09-26T00:00:00.000Z',
    ...(params.get('words') === '1' ? { mnemonic: WORDS } : {}),
};

createRoot(document.getElementById('root')!).render(
    <SettingsPage
        identity={identity}
        onIdentityUpdated={() => {}}
        onBack={() => {}}
        themePreference="system"
        onThemePreferenceChange={() => {}}
        initialMode={params.get('mode') === 'seed' ? 'seed' : undefined}
    />,
);
