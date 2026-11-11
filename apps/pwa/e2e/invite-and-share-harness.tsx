/**
 * A listing's share buttons drawn on their own (components/SharePost.tsx, the real component with the real Invite and share
 * button), so invite-and-share-320.mjs can measure and photograph them in a real Chromium layout. Every /api request it makes
 * is answered by that check's page route, never a node. The member's key is put in this browser's own store first.
 */
import { createRoot } from 'react-dom/client';
import { SharePostButtons } from '../src/components/SharePost';
import { importIdentity } from '../src/lib/identity';
import { showLanguage } from '../src/lib/language';
import '../src/index.css';

const identity: any = { publicKey: 'a'.repeat(64), privateKey: '', callsign: 'Robin', createdAt: '2026-10-01T00:00:00.000Z' };
const post: any = {
    id: '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a34', title: 'Ladder for borrowing', type: 'offer', category: 'tools', description: 'A 6 m ladder',
    price_c: 0, authorPublicKey: 'b'.repeat(64), status: 'active', active: true, audienceScope: 'public',
};

void importIdentity(identity).catch(() => {}).then(() => showLanguage(new URLSearchParams(location.search).get('lang') ?? 'en')).finally(() => {
    createRoot(document.getElementById('root')!).render(
        <div className="p-4 max-w-[500px] mx-auto">
            <div className="rounded-2xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 p-3">
                <h2 className="m-0 text-lg font-black text-nature-950 dark:text-white">{post.title}</h2>
                <SharePostButtons post={post} />
            </div>
        </div>,
    );
});
