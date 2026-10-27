/**
 * Deals S3b Parity Test: both apps count deals with the one rule from core (DESIGN-deals-fable.md §0.1, §1.2, §4, §5 row S3b).
 * Every deal counter, badge and sheet reads deal-step.
 *
 * Patterned after apps/pwa/src/dealLinesFromLibrary.test.ts: verifies both functional count parity
 * on a single comprehensive fixture and code structure across web and phone.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { dealsNeedingMe, openDeals, type DealRow } from '@beanpool/core';

const PWA_APP_SRC = fs.readFileSync(path.resolve(__dirname, 'App.tsx'), 'utf8');
const PWA_MARKET_SRC = fs.readFileSync(path.resolve(__dirname, 'pages/MarketplacePage.tsx'), 'utf8');
const NATIVE_LAYOUT_SRC = fs.readFileSync(path.resolve(__dirname, '../../native/app/(tabs)/_layout.tsx'), 'utf8');
const NATIVE_MARKET_SRC = fs.readFileSync(path.resolve(__dirname, '../../native/app/(tabs)/market.tsx'), 'utf8');
const NATIVE_SHEET_SRC = fs.readFileSync(path.resolve(__dirname, '../../native/components/MyDealsSheet.tsx'), 'utf8');
const PWA_MODAL_SRC = fs.readFileSync(path.resolve(__dirname, 'components/MyDealsModal.tsx'), 'utf8');

const ME = 'user-pubkey-me';
const OTHER = 'user-pubkey-other';
const NOW = new Date('2026-10-26T12:00:00Z').getTime();

// Comprehensive fixture representing each state from §1.2 / §3.1
const FIXTURE_TRANSACTIONS: DealRow[] = [
    // 1. Pending as payer (ME bought) -> needs me to release
    {
        id: 'tx-pending-payer',
        postId: 'post-1',
        postTitle: 'Offer 1',
        status: 'pending',
        buyerPublicKey: ME,
        sellerPublicKey: OTHER,
        postAuthorPublicKey: OTHER,
        postType: 'offer',
        createdAt: '2026-10-25T00:00:00Z',
    },
    // 2. Pending as payee (ME is seller) -> waiting on other to release, does NOT need me
    {
        id: 'tx-pending-payee',
        postId: 'post-2',
        postTitle: 'Offer 2',
        status: 'pending',
        buyerPublicKey: OTHER,
        sellerPublicKey: ME,
        postAuthorPublicKey: ME,
        postType: 'offer',
        createdAt: '2026-10-25T01:00:00Z',
    },
    // 3. Requested on ME's offer (ME is author/seller) -> needs me to approve/deny
    {
        id: 'tx-req-offer-author',
        postId: 'post-3',
        postTitle: 'Offer 3',
        status: 'requested',
        buyerPublicKey: OTHER,
        sellerPublicKey: ME,
        postAuthorPublicKey: ME,
        postType: 'offer',
        createdAt: '2026-10-26T00:00:00Z',
    },
    // 4. Requested on ME's need (ME is author/buyer) -> needs me to approve/deny helper
    {
        id: 'tx-req-need-author',
        postId: 'post-4',
        postTitle: 'Need 4',
        status: 'requested',
        buyerPublicKey: ME,
        sellerPublicKey: OTHER,
        postAuthorPublicKey: ME,
        postType: 'need',
        createdAt: '2026-10-26T02:00:00Z',
    },
    // 5. Requested on OTHER's offer (ME asked to borrow / buy) -> does NOT need me (waiting on author)
    {
        id: 'tx-req-borrower',
        postId: 'post-5',
        postTitle: 'Offer 5',
        status: 'requested',
        buyerPublicKey: ME,
        sellerPublicKey: OTHER,
        postAuthorPublicKey: OTHER,
        postType: 'offer',
        postLendable: true,
        createdAt: '2026-10-26T03:00:00Z',
    },
    // 6. Completed trade -> does NOT need me
    {
        id: 'tx-completed',
        postId: 'post-6',
        postTitle: 'Offer 6',
        status: 'completed',
        buyerPublicKey: ME,
        sellerPublicKey: OTHER,
        postAuthorPublicKey: OTHER,
        createdAt: '2026-10-20T00:00:00Z',
    },
];

describe('Deals S3b count parity between web and phone', () => {
    it('both apps agree on dealsNeedingMe count for badges, pills, and handshake', () => {
        const needingMe = dealsNeedingMe(FIXTURE_TRANSACTIONS, ME, NOW);
        // Only #1 (pending payer), #3 (offer author requested), #4 (need author requested) need ME
        expect(needingMe.map(t => t.id)).toEqual([
            'tx-pending-payer',
            'tx-req-offer-author',
            'tx-req-need-author',
        ]);
        expect(needingMe.length).toBe(3);
    });

    it('phone MyDealsSheet.tsx uses dealsNeedingMe for usePendingDealsCount', () => {
        expect(NATIVE_SHEET_SRC).toMatch(/export function usePendingDealsCount[\s\S]*?dealsNeedingMe\(/);
    });

    it('both apps agree on openDeals count for In Progress tab and cards', () => {
        const open = openDeals(FIXTURE_TRANSACTIONS, ME);
        // 5 open deals (#1, #2, #3, #4, #5)
        expect(open.length).toBe(5);
        expect(open.map(t => t.id)).not.toContain('tx-completed');
    });

    it('web App.tsx uses dealsNeedingMe for pendingDealsCount and sets sidebar badge to danger red', () => {
        expect(PWA_APP_SRC).toMatch(/dealsNeedingMe\(/);
        expect(PWA_APP_SRC).not.toMatch(/activeDeals \+ pendingRequests/);
        // Sidebar Market badge color matches bottom nav's danger color
        expect(PWA_APP_SRC).toMatch(/tab\.id === 'marketplace'[\s\S]*?var\(--danger\)/);
    });

    it('web MarketplacePage.tsx uses dealsNeedingMe for the My Deals pill', () => {
        expect(PWA_MARKET_SRC).toMatch(/dealsNeedingMe\(/);
        expect(PWA_MARKET_SRC).not.toMatch(/globalRequests\.length \+ /);
    });

    it('phone _layout.tsx uses dealsNeedingMe for the Market tab badge', () => {
        expect(NATIVE_LAYOUT_SRC).toMatch(/dealsNeedingMe\(/);
    });

    it('phone market.tsx uses dealsNeedingMe / usePendingDealsCount without dealPosts', () => {
        expect(NATIVE_MARKET_SRC).not.toMatch(/const \[dealPosts, setDealPosts\]/);
    });

    it('both sheets (MyDealsSheet and MyDealsModal) render title row "{n} under way · {m} need you"', () => {
        expect(NATIVE_SHEET_SRC).toMatch(/under way ·/);
        expect(PWA_MODAL_SRC).toMatch(/under way ·/);
    });
});
