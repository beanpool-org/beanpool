/**
 * A short week's card and sheets (src/components/StandingDeal.tsx; DESIGN-getting-paid-fable §3.2, slice L2), drawn by the
 * app's own components for e2e/short-week-shots.mjs: `?case=` picks the deal row and the side, and the driver taps what
 * opens a sheet. Nothing here talks to a node: `onLower` answers here (a refusal for the case that shows one).
 */
import { createRoot } from 'react-dom/client';
import { StandingPanel, StandingTakeUp } from '../src/components/StandingDeal';
import type { MarketplaceTransaction } from '../src/lib/api';
import { useTheme } from '../src/lib/useTheme';
import '../src/index.css';

const PAYER = 'a'.repeat(64);
const PAYEE = 'b'.repeat(64);
const START = '2026-11-11T08:00:00.000Z';
const row = (o: Partial<MarketplaceTransaction> = {}): MarketplaceTransaction => ({
    id: 'tx-1', postId: 'post-1', postTitle: "Room at Rob's", buyerPublicKey: PAYER, buyerCallsign: 'Kim', sellerPublicKey: PAYEE, sellerCallsign: 'Rob',
    amount_c: 20000, status: 'completed', createdAt: START, completedAt: START,
    standingId: 'sd-1', periodNo: 1, standingPhase: 'paid', standingBeans_c: 20000, standingUnit: 'week', standingMaxPeriods: null,
    standingNextDueAt: '2026-11-18T08:00:00.000Z', standingStartsAt: START, standingShortSince: null, standingStopped: false,
    standingAsksLeft: 3, standingAsk: null, ...o,
});
const GRACE = { standingPhase: 'short' as const, standingShortSince: '2026-11-18T08:00:00.000Z', standingNextDueAt: '2026-11-18T09:00:00.000Z' };
const ASK = { standingAsk: { id: 'chg-1', beans_c: 10000, periodNo: 2, askedAt: '2026-11-14T08:00:00.000Z' }, standingAsksLeft: 2 };

const CASES: Record<string, { tx: MarketplaceTransaction; side: string; refuse?: string }> = {
    'payer-card': { tx: row(), side: PAYER },
    'payer-ask-sheet': { tx: row(), side: PAYER },
    'payer-ask-refused': { tx: row(), side: PAYER, refuse: "You've asked about this week three times, which is the most." },
    'payer-ask-open': { tx: row(ASK), side: PAYER },
    'payee-answer-sheet': { tx: row(ASK), side: PAYEE },
    'payee-lower-sheet': { tx: row(), side: PAYEE },
    'payee-grace-lower': { tx: row(GRACE), side: PAYEE },
    'payer-grace-ask-sheet': { tx: row(GRACE), side: PAYER },
    'payer-agreed': { tx: row({ standingDueBeans_c: 10000, standingAsksLeft: 2 }), side: PAYER },
    'payee-zero-week': { tx: row({ amount_c: 0, periodNo: 2, completedAt: '2026-11-18T08:00:00.000Z', standingNextDueAt: '2026-11-25T08:00:00.000Z' }), side: PAYEE },
};

function Harness() {
    useTheme();
    const name = new URLSearchParams(location.search).get('case') || 'payer-card';
    if (name === 'take-up') {
        return (
            <div className="min-h-screen bg-surface-canvas p-4">
                <StandingTakeUp unit="week" beans={20000} title="Room at Rob's" payeeName="Rob" busy={false} onCancel={() => {}} onAgree={() => {}} now={Date.parse(START)} />
            </div>
        );
    }
    const c = CASES[name];
    return (
        <div className="min-h-screen bg-surface-canvas p-4">
            <StandingPanel tx={c.tx} actingAs={c.side} busy={false} onStop={() => {}} onMessage={() => {}}
                messageLabel={c.side === PAYER ? 'Message Rob' : 'Message Kim'}
                onLower={async () => { if (c.refuse) throw new Error(c.refuse); }} />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
