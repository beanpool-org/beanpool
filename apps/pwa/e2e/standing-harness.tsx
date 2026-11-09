/**
 * Standing deals S2 (standing-shots.mjs): the real StandingTakeUp and StandingPanel (src/components/StandingDeal.tsx) with
 * fixed rows, so the take-up screen and each phase's panel can be measured at 320 px with 1.3x text, light and dark, in
 * English and Spanish. No node is contacted: nothing here fetches.
 *
 *   ?view=take-up        Take this up? on a monthly Offer, as it opens (until one of them stops it, from today)
 *   ?view=panels         the panel for: held (payer), held (payee)
 *   ?view=short          short (payer: the banner with its week), short (payee), held back (payer)
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
    credits: 50, status: 'pending', createdAt: '2026-11-09T08:00:00.000Z',
    standingId: `sd-${id}`, periodNo: 3, standingPhase: 'held', standingBeans: 50, standingUnit: 'month', standingMaxPeriods: 6,
    standingNextDueAt: '2026-12-09T08:00:00.000Z', standingStartsAt: '2026-10-09T08:00:00.000Z', standingShortSince: null, standingStopped: false,
    ...o,
});
const SHORT = { status: 'completed' as const, standingPhase: 'short' as const, standingShortSince: '2026-12-09T08:00:00.000Z' };
const noop = () => {};

await startLanguage(window.location.search);

createRoot(document.getElementById('root')!).render(
    <div data-testid="shot" style={{ padding: 16 }}>
        {view === 'take-up'
            ? <StandingTakeUp unit="month" beans={50} title="Vehicle Storage" payeeName="Rob" busy={false} onCancel={noop} onAgree={noop} now={NOW} />
            : view === 'panels' ? <>
                <StandingPanel tx={row('held-payer')} actingAs={PAYER} busy={false} onStop={noop} onHoldBack={noop} onMessage={noop} messageLabel="Message Rob" />
                <StandingPanel tx={row('held-payee')} actingAs={PAYEE} busy={false} onStop={noop} onHoldBack={noop} onMessage={noop} messageLabel="Message Marty" />
            </> : <>
                <StandingPanel tx={row('short-payer', SHORT)} actingAs={PAYER} busy={false} onStop={noop} onHoldBack={noop} />
                <StandingPanel tx={row('short-payee', SHORT)} actingAs={PAYEE} busy={false} onStop={noop} onHoldBack={noop} />
                <StandingPanel tx={row('held-back', { standingPhase: 'held_back' })} actingAs={PAYER} busy={false} onStop={noop} onHoldBack={noop} />
            </>}
    </div>,
);
