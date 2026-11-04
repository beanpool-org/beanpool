/**
 * The real Market page, opened on a listing or on an event (?post=<id>), for e2e/share-menu-shots.mjs: the real page, the real
 * ONE Share button and its menu (components/SharePost.tsx, EventExtras.tsx), the real stylesheet. Every /api request it makes is
 * answered by that script's page route, never a node. The member's key is put in this browser's own store first, so Invite and
 * share has one to offer with.
 */
import { createRoot } from 'react-dom/client';
import { MarketplacePage } from '../src/pages/MarketplacePage';
import { importIdentity, type BeanPoolIdentity } from '../src/lib/identity';
import '../src/index.css';

const q = new URLSearchParams(window.location.search);
if (q.get('dark') === '1') document.documentElement.classList.add('dark', 'dark-theme');
else document.documentElement.classList.remove('dark', 'dark-theme');

const identity: BeanPoolIdentity = { publicKey: 'a'.repeat(64), privateKey: '', callsign: 'Ana', createdAt: '2026-09-01T00:00:00.000Z' };

void importIdentity(identity).catch(() => {}).finally(() => {
    createRoot(document.getElementById('root')!).render(
        <MarketplacePage identity={identity} isMember={true} openPostId={q.get('post')} onPostOpened={() => {}} />,
    );
});
