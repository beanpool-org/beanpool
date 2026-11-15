/**
 * Your deals → Bills (src/components/Bills.tsx; DESIGN-getting-paid-fable §4.2, §4.3, slice B2), drawn by the app's own panel
 * for e2e/bills-shots.mjs: `?case=` picks what the node answers, and the driver taps what the member taps. Nothing here talks
 * to a node: the page's fetch answers GET /api/bills and the balance read itself (a lost answer for the case that shows one).
 */
import { createRoot } from 'react-dom/client';
import type { BillView } from '@beanpool/core';
import { BillsPanel } from '../src/components/Bills';
import { useTheme } from '../src/lib/useTheme';
import '../src/index.css';

const ROB = 'a'.repeat(64);
const KIM = 'b'.repeat(64);
const ZED = 'c'.repeat(64);
const SENT = '2026-11-12T10:00:00.000Z';
const UNTIL = new Date(Date.now() + 28 * 86_400_000).toISOString();
const bill = (role: 'to-pay' | 'sent', o: Partial<BillView> = {}): BillView => ({
    id: 'bill-0001', role, billerPublicKey: ROB, billerName: 'Rob', payerPublicKey: KIM, payerName: 'Kim', amount_c: 6000,
    whatFor: 'Power, October', postId: 'post-1', postTitle: "Room at Rob's", standingId: null, state: 'sent', sentAt: SENT, expiresAt: UNTIL,
    paidAt: null, ...(role === 'to-pay' ? { known: true, creditOpen: false } : {}), ...o,
});
const STRANGER = bill('to-pay', { id: 'bill-0002', billerPublicKey: ZED, billerName: 'Zed', whatFor: 'Bike repair, back wheel and brakes', amount_c: 30000, postId: null, postTitle: null, known: false });

const CASES: Record<string, { me: string; toPay: BillView[]; sent: BillView[]; balance_c: number; open?: string; lost?: boolean; balanceFails?: boolean }> = {
    'to-pay-list': { me: KIM, toPay: [bill('to-pay'), STRANGER], sent: [], balance_c: 8500 },
    'sheet-known': { me: KIM, toPay: [bill('to-pay')], sent: [], balance_c: 8500, open: 'bill-0001' },
    'sheet-confirm': { me: KIM, toPay: [bill('to-pay')], sent: [], balance_c: 8500, open: 'bill-0001' },
    'sheet-stranger': { me: KIM, toPay: [STRANGER], sent: [], balance_c: 1200, open: 'bill-0002' },
    'sheet-lost': { me: KIM, toPay: [bill('to-pay')], sent: [], balance_c: 8500, open: 'bill-0001', lost: true },
    'sent-list': {
        me: ROB, toPay: [], balance_c: 0, sent: [
            bill('sent'),
            bill('sent', { id: 'bill-0003', payerName: 'Sam', whatFor: 'Water, October', amount_c: 2500, state: 'paid', paidAt: '2026-11-14T09:00:00.000Z' }),
            bill('sent', { id: 'bill-0004', payerName: 'Alexandria-Rose', whatFor: 'Garden tools, borrowed and broken', amount_c: 199_999, state: 'expired' }),
        ],
    },
    // Round 2 of #3210: a balance read that failed, and a paid bill's door to its sender (Sent, its row marked).
    'sheet-balance-failed': { me: KIM, toPay: [bill('to-pay')], sent: [], balance_c: 8500, open: 'bill-0001', balanceFails: true },
    'sent-door': {
        me: ROB, toPay: [], balance_c: 0, open: 'bill-0003', sent: [
            bill('sent'),
            bill('sent', { id: 'bill-0003', payerName: 'Sam', whatFor: 'Water, October', amount_c: 2500, state: 'paid', paidAt: '2026-11-14T09:00:00.000Z' }),
        ],
    },
};
const name = new URLSearchParams(location.search).get('case') || 'to-pay-list';
const c = CASES[name];

const answer = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
window.fetch = ((input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/bills/') && url.endsWith('/pay')) return c.lost ? Promise.reject(new TypeError('Failed to fetch')) : answer({ success: true });
    if (url.includes('/api/bills')) return answer({ toPay: c.toPay, sent: c.sent });
    if (url.includes('/api/ledger/balance') && c.balanceFails) return Promise.reject(new TypeError('Failed to fetch'));
    if (url.includes('/api/ledger/balance')) return answer({ balance_c: c.balance_c, floor_c: -100000, usableFloor_c: -100000, liveOffers: 1 });
    return Promise.reject(new TypeError('Failed to fetch'));
}) as typeof fetch;

function Harness() {
    useTheme();
    return (
        <div className="min-h-screen bg-white dark:bg-nature-950 p-4" data-testid="case-root">
            <BillsPanel me={c.me} openBillId={c.open ?? null} onMessage={() => {}} onOpenPost={() => {}} onPostOffer={() => {}} />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
