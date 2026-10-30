/**
 * The Ledger's doors to deals (deals S6): the real LedgerPage with the member's deals as App.tsx hands them (`deals`), and
 * an onNavigate that records where a tap goes (`window.__navigated`), for e2e/ledger-doors-shots.mjs. `?held=0`: nothing
 * held. Every /api call is answered by that script.
 */
import { createRoot } from 'react-dom/client';
import { showLanguage } from '../src/lib/language';
import { useTheme } from '../src/lib/useTheme';
import { LedgerPage } from '../src/pages/LedgerPage';
import type { MarketplaceTransaction } from '../src/lib/api';
import { IDENTITY } from './fixtures.mjs';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const held = params.get('held') !== '0';
const ME = IDENTITY.publicKey;
const LISTING = '123e4567-e89b-12d3-a456-426614174000';

const DEALS: MarketplaceTransaction[] = held ? [{
    id: 'deal-1', postId: LISTING, postTitle: 'Sourdough baking course', buyerPublicKey: ME, buyerCallsign: 'Visitor',
    sellerPublicKey: 'member-damo', sellerCallsign: 'Damo', credits: 45, status: 'pending', createdAt: new Date().toISOString(),
}] : [];

(window as unknown as { __navigated: unknown[] }).__navigated = [];
const navigated = (tab: string, contextId?: string) => (window as unknown as { __navigated: unknown[] }).__navigated.push([tab, contextId ?? null]);

function Screen() {
    useTheme();
    return <LedgerPage identity={IDENTITY as never} isMember onNavigate={navigated} deals={DEALS} />;
}

void showLanguage('en').then(() => {
    createRoot(document.getElementById('root')!).render(<Screen />);
    document.documentElement.dataset.harnessReady = 'true';
});
