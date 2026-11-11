/**
 * "I can do this" shots (cold start N4): the real Market page, opened on a Need as a neighbour who could answer it, and on a
 * Need the member has already answered (the request card, which carries the 1.5% fee now that the first screen does not).
 * The node's answers are the e2e/need-answer-shots.mjs routes; ?view=request passes the member's waiting request in.
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
const request: MarketplaceTransaction = {
    id: 'tx-req', postId: 'p-stall', postTitle: 'Help at the market stall', amount_c: 2000, status: 'requested', buyerPublicKey: 'kofi-key', buyerCallsign: 'Kofi',
    sellerPublicKey: ME, sellerCallsign: 'Ana', createdAt: '2026-10-24T10:00:00.000Z',
};
const view = q.get('view') || 'confirm';
const postId = q.get('post') || 'p-stall';

createRoot(document.getElementById('root')!).render(
    <MarketplacePage identity={identity} isMember={true} openPostId={postId} onPostOpened={() => {}} transactions={view === 'request' ? [request] : []} />,
);
