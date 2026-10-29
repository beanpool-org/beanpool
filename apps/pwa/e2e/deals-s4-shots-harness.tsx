/**
 * Deals S4 shots (scratch/fable-design/DESIGN-deals-fable.md §3.2, §3.3): the real Market page, opened on a listing as each
 * of its people reads it, and the feed with each chip. The node's answers are the e2e/deals-s4-shots.mjs routes; the
 * member's own deals come in as App passes them (transactions).
 */
import { createRoot } from 'react-dom/client';
import { MarketplacePage } from '../src/pages/MarketplacePage';
import type { MarketplaceTransaction } from '../src/lib/api';
import type { BeanPoolIdentity } from '../src/lib/identity';
import '../src/index.css';

const q = new URLSearchParams(window.location.search);
if (q.get('dark') === '1') document.documentElement.classList.add('dark', 'dark-theme');
else document.documentElement.classList.remove('dark', 'dark-theme');

const ME = 'me-key';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: '00'.repeat(32), callsign: 'Ana', createdAt: '2026-09-01T00:00:00.000Z' };
const AT = '2026-10-24T10:00:00.000Z';
const deal = (over: Partial<MarketplaceTransaction>): MarketplaceTransaction => ({
    id: 'tx', postId: 'p', postTitle: 'Listing', credits: 45, status: 'pending', buyerPublicKey: ME, buyerCallsign: 'Ana',
    sellerPublicKey: 'damo-key', sellerCallsign: 'Damo', createdAt: AT, ...over,
});

/** The member's own deals, by view (the node's answers for the listing itself are the routes'). */
const MINE: Record<string, MarketplaceTransaction[]> = {
    payer: [deal({ id: 'tx-pay', postId: 'p-course' })],
    payee: [deal({ id: 'tx-help', postId: 'p-stall', credits: 20, buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi', sellerPublicKey: ME, sellerCallsign: 'Ana' })],
    author: [
        deal({ id: 'tx-a', postId: 'p-mine', buyerPublicKey: 'marty-key', buyerCallsign: 'Marty', sellerPublicKey: ME, sellerCallsign: 'Ana', createdAt: '2026-10-26T10:00:00.000Z' }),
        deal({ id: 'tx-b', postId: 'p-mine', credits: 30, buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi', sellerPublicKey: ME, sellerCallsign: 'Ana' }),
    ],
    keeper: [],
    feed: [
        deal({ id: 'tx-1', postId: 'p-course' }),
        deal({ id: 'tx-2', postId: 'p-ladder', status: 'requested' }),
    ],
};
const OPEN: Record<string, string | undefined> = { payer: 'p-course', payee: 'p-stall', author: 'p-mine', keeper: 'p-farm' };
const view = q.get('view') || 'feed';

createRoot(document.getElementById('root')!).render(
    <div className="max-w-[320px]">
        <MarketplacePage identity={identity} isMember={true} openPostId={OPEN[view] ?? null} onPostOpened={() => {}}
            openTxId={view === 'author' ? 'tx-b' : null} transactions={MINE[view] ?? []} />
    </div>,
);
