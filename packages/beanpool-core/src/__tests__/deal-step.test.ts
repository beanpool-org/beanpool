import { describe, expect, it } from 'vitest';
import {
    dealStep,
    dealsNeedingMe,
    openDeals,
    dealStateWords,
    type DealRow,
    type DealRole,
    type DealState,
    type DealStep,
} from '../deal-step.js';

describe('dealStep matrix test (5 listing kinds x 2 roles x states)', () => {
    const ME = 'm'.repeat(64);
    const OTHER = 'o'.repeat(64);
    const BASE_NOW = 1_700_000_000_000;

    // 5 listing kinds (DESIGN-deals-fable §3.1)
    const LISTING_KINDS = [
        { name: 'offer-one-off', postType: 'offer', postRepeatable: false, postLendable: false },
        { name: 'offer-recurring', postType: 'offer', postRepeatable: true, postLendable: false },
        { name: 'offer-lendable', postType: 'offer', postRepeatable: true, postLendable: true },
        { name: 'need-one-off', postType: 'need', postRepeatable: false, postLendable: false },
        { name: 'need-repeatable', postType: 'need', postRepeatable: true, postLendable: false },
    ] as const;

    // 2 roles
    const ROLES: DealRole[] = ['payer', 'payee'];

    for (const kind of LISTING_KINDS) {
        for (const role of ROLES) {
            describe(`listing: ${kind.name}, role: ${role}`, () => {
                const isPayer = role === 'payer';
                const buyerPublicKey = isPayer ? ME : OTHER;
                const sellerPublicKey = isPayer ? OTHER : ME;

                // On an Offer, the author is the seller (payee).
                // On a Need, the author is the buyer (payer).
                const authorPublicKey = kind.postType === 'need' ? buyerPublicKey : sellerPublicKey;
                const isAuthor = authorPublicKey === ME;

                const makeTx = (overrides: Partial<DealRow> = {}): DealRow => ({
                    id: 'tx-1',
                    status: 'pending',
                    buyerPublicKey,
                    sellerPublicKey,
                    postAuthorPublicKey: authorPublicKey,
                    postType: kind.postType,
                    postRepeatable: kind.postRepeatable,
                    postLendable: kind.postLendable,
                    createdAt: new Date(BASE_NOW - 1000).toISOString(),
                    ratedByBuyer: false,
                    ratedBySeller: false,
                    ...overrides,
                });

                it('evaluates role correctly', () => {
                    const step = dealStep(makeTx(), ME, BASE_NOW);
                    expect(step.role).toBe(role);
                });

                // State: requested
                it('handles requested state (to-answer if author, asked otherwise)', () => {
                    const tx = makeTx({ status: 'requested' });
                    const step = dealStep(tx, ME, BASE_NOW);

                    if (isAuthor) {
                        expect(step.state).toBe('to-answer');
                        expect(step.needsMe).toBe(true);
                        expect(step.pressing).toBe(true); // pressing immediately
                        expect(step.dueSince).toBe(tx.createdAt);
                    } else {
                        expect(step.state).toBe('asked');
                        expect(step.needsMe).toBe(false);
                        expect(step.pressing).toBe(false);
                        expect(step.dueSince).toBeNull();
                    }
                });

                // State: pending
                it('handles pending state (to-release if payer, to-deliver if payee)', () => {
                    const recentCreatedAt = new Date(BASE_NOW - 3 * 86_400_000).toISOString();
                    const tx = makeTx({ status: 'pending', createdAt: recentCreatedAt });
                    const step = dealStep(tx, ME, BASE_NOW);

                    if (isPayer) {
                        expect(step.state).toBe('to-release');
                        expect(step.needsMe).toBe(true);
                        expect(step.pressing).toBe(false); // calm under 7 days
                        expect(step.dueSince).toBe(recentCreatedAt);
                    } else {
                        expect(step.state).toBe('to-deliver');
                        expect(step.needsMe).toBe(false);
                        expect(step.pressing).toBe(false);
                        expect(step.dueSince).toBeNull();
                    }
                });

                // Pressing at 7 days for payer in pending state
                it('payer in pending becomes pressing after 7 days', () => {
                    const exactly7DaysAgo = new Date(BASE_NOW - 7 * 86_400_000).toISOString();
                    const tx7 = makeTx({ status: 'pending', createdAt: exactly7DaysAgo });
                    const step7 = dealStep(tx7, ME, BASE_NOW);

                    if (isPayer) {
                        expect(step7.state).toBe('to-release');
                        expect(step7.needsMe).toBe(true);
                        expect(step7.pressing).toBe(true); // pressing at 7 days
                    } else {
                        expect(step7.state).toBe('to-deliver');
                        expect(step7.needsMe).toBe(false);
                        expect(step7.pressing).toBe(false);
                    }

                    const tenDaysAgo = new Date(BASE_NOW - 10 * 86_400_000).toISOString();
                    const step10 = dealStep(makeTx({ status: 'pending', createdAt: tenDaysAgo }), ME, BASE_NOW);
                    if (isPayer) {
                        expect(step10.pressing).toBe(true);
                    }
                });

                // State: completed
                it('handles completed state: done-to-review if unreviewed, done if reviewed', () => {
                    // Unreviewed
                    const unreviewedTx = makeTx({
                        status: 'completed',
                        ratedByBuyer: isPayer ? false : true,
                        ratedBySeller: isPayer ? true : false,
                    });
                    const stepUnreviewed = dealStep(unreviewedTx, ME, BASE_NOW);
                    expect(stepUnreviewed.state).toBe('done-to-review');
                    expect(stepUnreviewed.needsMe).toBe(false);
                    expect(stepUnreviewed.pressing).toBe(false);
                    expect(stepUnreviewed.dueSince).toBeNull();

                    // Reviewed
                    const reviewedTx = makeTx({
                        status: 'completed',
                        ratedByBuyer: true,
                        ratedBySeller: true,
                    });
                    const stepReviewed = dealStep(reviewedTx, ME, BASE_NOW);
                    expect(stepReviewed.state).toBe('done');
                    expect(stepReviewed.needsMe).toBe(false);
                    expect(stepReviewed.pressing).toBe(false);
                    expect(stepReviewed.dueSince).toBeNull();
                });

                // State: cancelled
                it('handles cancelled state', () => {
                    const tx = makeTx({ status: 'cancelled' });
                    const step = dealStep(tx, ME, BASE_NOW);
                    expect(step.state).toBe('cancelled');
                    expect(step.needsMe).toBe(false);
                    expect(step.pressing).toBe(false);
                    expect(step.dueSince).toBeNull();
                });

                // State: declined / rejected
                it('handles declined/rejected states', () => {
                    for (const status of ['rejected', 'declined']) {
                        const tx = makeTx({ status });
                        const step = dealStep(tx, ME, BASE_NOW);
                        expect(step.state).toBe('declined');
                        expect(step.needsMe).toBe(false);
                        expect(step.pressing).toBe(false);
                        expect(step.dueSince).toBeNull();
                    }
                });
            });
        }
    }
});

describe('dealsNeedingMe and openDeals', () => {
    const ME = 'm'.repeat(64);
    const OTHER = 'o'.repeat(64);
    const NOW = 1_700_000_000_000;

    const txs: DealRow[] = [
        // 1. Need requested - ME is author (buyer) -> needsMe = true (to-answer)
        {
            id: 'tx-answer',
            status: 'requested',
            buyerPublicKey: ME,
            sellerPublicKey: OTHER,
            postAuthorPublicKey: ME,
            postType: 'need',
            createdAt: new Date(NOW - 1000).toISOString(),
        },
        // 2. Lendable requested - OTHER is author (seller), ME is borrower (buyer) -> asked -> needsMe = false
        {
            id: 'tx-asked',
            status: 'requested',
            buyerPublicKey: ME,
            sellerPublicKey: OTHER,
            postAuthorPublicKey: OTHER,
            postType: 'offer',
            postLendable: true,
            createdAt: new Date(NOW - 2000).toISOString(),
        },
        // 3. Pending - ME is payer (buyer) -> to-release -> needsMe = true
        {
            id: 'tx-release',
            status: 'pending',
            buyerPublicKey: ME,
            sellerPublicKey: OTHER,
            postAuthorPublicKey: OTHER,
            postType: 'offer',
            createdAt: new Date(NOW - 3000).toISOString(),
        },
        // 4. Pending - ME is payee (seller) -> to-deliver -> needsMe = false
        {
            id: 'tx-deliver',
            status: 'pending',
            buyerPublicKey: OTHER,
            sellerPublicKey: ME,
            postAuthorPublicKey: ME,
            postType: 'offer',
            createdAt: new Date(NOW - 4000).toISOString(),
        },
        // 5. Completed -> done -> needsMe = false
        {
            id: 'tx-done',
            status: 'completed',
            buyerPublicKey: ME,
            sellerPublicKey: OTHER,
            ratedByBuyer: true,
            createdAt: new Date(NOW - 5000).toISOString(),
        },
    ];

    it('dealsNeedingMe filters only to-answer and to-release', () => {
        const needing = dealsNeedingMe(txs, ME, NOW);
        expect(needing.map(t => t.id)).toEqual(['tx-answer', 'tx-release']);
    });

    it('openDeals filters requested and pending for me, sorted newest first', () => {
        const open = openDeals(txs, ME);
        expect(open.map(t => t.id)).toEqual(['tx-answer', 'tx-asked', 'tx-release', 'tx-deliver']);
    });
});

describe('dealStateWords', () => {
    it('formats state words for all states', () => {
        const makeStep = (state: DealState, role: DealRole = 'payer'): DealStep => ({
            role,
            state,
            needsMe: state === 'to-answer' || state === 'to-release',
            pressing: state === 'to-answer',
            dueSince: null,
        });

        expect(dealStateWords(makeStep('to-answer', 'payee'), 'Bob')).toBe('Waiting on you: answer');
        expect(dealStateWords(makeStep('to-release', 'payer'), 'Bob')).toBe('Waiting on you: release');
        expect(dealStateWords(makeStep('to-release', 'payer'), 'Bob', '3 Nov')).toBe('You have it until 3 Nov');
        expect(dealStateWords(makeStep('to-deliver', 'payee'), 'Ana')).toBe('Waiting on Ana to release');
        expect(dealStateWords(makeStep('to-deliver', 'payee'), null)).toBe('Waiting on them to release');
        expect(dealStateWords(makeStep('asked', 'payer'), 'Ana')).toBe('You asked · waiting on Ana');
        expect(dealStateWords(makeStep('asked', 'payer'), null)).toBe('You asked · waiting on them');
    });
});
