/**
 * The web's invite screen drawn on its own (pages/InvitePage.tsx, the real page) so invite-vouch-320.mjs can measure and
 * photograph it in a real Chromium layout. Every /api request it makes is answered by that check's page route, never a node.
 */
import { createRoot } from 'react-dom/client';
import { InvitePage } from '../src/pages/InvitePage';
import { showLanguage } from '../src/lib/language';
import '../src/index.css';

const identity = { publicKey: 'a'.repeat(64), privateKey: '', callsign: 'Robin', createdAt: '2026-10-01T00:00:00.000Z' };
void showLanguage(new URLSearchParams(location.search).get('lang') ?? 'en').finally(() => {
    createRoot(document.getElementById('root')!).render(<InvitePage identity={identity} preview={false} />);
});
