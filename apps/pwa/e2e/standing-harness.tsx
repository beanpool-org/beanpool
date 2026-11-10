/**
 * Standing deals, paid at the start of each period (standing-shots.mjs): the real StandingTakeUp and StandingPanel (src/components/StandingDeal.tsx) with
 * fixed rows, so the take-up screen and each phase's panel can be measured at 320 px with 1.3x text, light and dark, in
 * English and Spanish. No node is contacted: nothing here fetches.
 *
 *   ?view=take-up        Take this up? on a monthly Offer, as it opens (until one of them stops it, from today)
 *   ?view=panels         the panel for: paid (payer), paid (payee)
 *   ?view=short          short (payer: the banner with the grace's end), short (payee), stopped (payer)
 *   ?view=no-room        Take this up? with 30 Beans of room for 50: Agree disabled, the plain line above it (U2)
 *   &lang=es             Spanish (the app's own ?lang= choice); &dark=1 the dark theme
 */
import { createRoot } from 'react-dom/client';
import { StandingPanel, StandingTakeUp } from '../src/components/StandingDeal';
import { startLanguage } from '../src/lib/language';
import type { MarketplaceTransaction } from '../src/lib/api';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);
const view = params.get('view') || 'take-up';
document.documentElement.classList.toggle('dark', params.get('dark') === '1');
document.documentElement.classList.toggle('dark-theme', params.get('dark') === '1');

const PAYER = 'a'.repeat(64);
const PAYEE = 'b'.repeat(64);
const NOW = Date.parse('2026-11-09T08:00:00.000Z');
const row = (id: string, o: Partial<MarketplaceTransaction> = {}): MarketplaceTransaction => ({
    id, postId: 'post-1', postTitle: 'Vehicle Storage', buyerPublicKey: PAYER, buyerCallsign: 'Marty', sellerPublicKey: PAYEE, sellerCallsign: 'Rob',
    amount_c: 5000, status: 'completed', createdAt: '2026-11-09T08:00:00.000Z', completedAt: '2026-11-09T08:00:00.000Z',
    standingId: `sd-${id}`, periodNo: 2, standingPhase: 'paid', standingBeans_c: 5000, standingUnit: 'month', standingMaxPeriods: 6,
    standingNextDueAt: '2026-12-09T08:00:00.000Z', standingStartsAt: '2026-10-09T08:00:00.000Z', standingShortSince: null, standingStopped: false,
    ...o,
});
const SHORT = { periodNo: 1, standingPhase: 'short' as const, standingShortSince: '2026-11-09T08:00:00.000Z', standingNextDueAt: '2026-11-09T09:00:00.000Z' };
const noop = () => {};

await startLanguage(window.location.search);

createRoot(document.getElementById('root')!).render(
    <div data-testid="shot" style={{ padding: 16 }}>
        {view === 'take-up'
            ? <StandingTakeUp unit="month" beans={5000} title="Vehicle Storage" payeeName="Rob" busy={false} onCancel={noop} onAgree={noop} now={NOW} />
            : view === 'no-room'
            ? <StandingTakeUp unit="month" beans={5000} title="Vehicle Storage" payeeName="Rob" busy={false} onCancel={noop} onAgree={noop} now={NOW} room={3000} />
            : view === 'panels' ? <>
                <StandingPanel tx={row('paid-payer')} actingAs={PAYER} busy={false} onStop={noop} onMessage={noop} messageLabel="Message Rob" />
                <StandingPanel tx={row('paid-payee')} actingAs={PAYEE} busy={false} onStop={noop} onMessage={noop} messageLabel="Message Marty" />
            </> : <>
                <StandingPanel tx={row('short-payer', SHORT)} actingAs={PAYER} busy={false} onStop={noop} />
                <StandingPanel tx={row('short-payee', SHORT)} actingAs={PAYEE} busy={false} onStop={noop} />
                <StandingPanel tx={row('stopped', { standingStopped: true })} actingAs={PAYER} busy={false} onStop={noop} />
            </>}
    </div>,
);
