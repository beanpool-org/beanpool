/**
 * A listing's page and its card (scratch/fable-design/DESIGN-deals-fable.md §3.2, §3.3; slice S4): who a member stands for
 * on each deal of a listing, what they may do on it, and the feed's chip. The node's side of the keeper rule is driven for
 * real in apps/server test-deal-listing-keepers.ts; here the rule's own matrix.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { dealMoves, dealSideOf, listingChips, listingChipWords, listingDealLines, listingDeals, releaseAmount, releaseLine, type DealRow } from '../deal-step.js';
import { ANY_DECIMALS, parseAmount } from '../amount-input.js';
import { readFileSync } from 'node:fs';
import { setLanguage, type Catalog } from '../words.js';

const ME = 'me';
const DAMO = 'damo';
const KOFI = 'kofi';
const ANA = 'ana';
const ENT = 'eggs-co';
const NOW = Date.parse('2026-10-29T00:00:00Z');

/** The five listing kinds (§3.1): who buys and who sells, by who started it. */
const KINDS = [
    { name: 'one-off Offer', type: 'offer', repeatable: false, lendable: false },
    { name: 'recurring Offer', type: 'offer', repeatable: true, lendable: false },
    { name: 'lendable Offer', type: 'offer', repeatable: false, lendable: true },
    { name: 'one-off Need', type: 'need', repeatable: false, lendable: false },
    { name: 'repeatable Need', type: 'need', repeatable: true, lendable: false },
] as const;

/** A deal on `author`'s listing with `other`: on an Offer the other pays; on a Need the author pays. */
function deal(kind: (typeof KINDS)[number], author: string, other: string, status: string, id = `tx-${status}-${other}`): DealRow {
    const offer = kind.type === 'offer';
    return {
        id, postId: 'p', status, createdAt: '2026-10-24T10:00:00Z',
        buyerPublicKey: offer ? other : author, sellerPublicKey: offer ? author : other,
        postAuthorPublicKey: author, postType: kind.type, postRepeatable: kind.repeatable, postLendable: kind.lendable,
    };
}

describe('dealMoves: every listing kind × role × state', () => {
    for (const kind of KINDS) {
        const offer = kind.type === 'offer';
        it(`${kind.name}: held in trust, the payer releases, both sides may cancel, nobody answers`, () => {
            const asAuthor = dealMoves(deal(kind, ME, DAMO, 'pending'), ME)!;
            const asTaker = dealMoves(deal(kind, DAMO, ME, 'pending'), ME)!;
            // On an Offer the author is paid; on a Need the author pays.
            expect(asAuthor.release).toBe(!offer);
            expect(asTaker.release).toBe(offer);
            for (const m of [asAuthor, asTaker]) {
                expect(m.cancelHold).toBe(true);
                expect(m.answer).toBe(false);
                expect(m.withdraw).toBe(false);
                expect(m.actingAs).toBe(ME);
                expect(m.asKeeper).toBe(false);
            }
        });
        it(`${kind.name}: asked, the author answers and the one who asked may withdraw; nothing to release or cancel`, () => {
            const asAuthor = dealMoves(deal(kind, ME, DAMO, 'requested'), ME)!;
            const asTaker = dealMoves(deal(kind, DAMO, ME, 'requested'), ME)!;
            expect([asAuthor.answer, asAuthor.withdraw]).toEqual([true, false]);
            expect([asTaker.answer, asTaker.withdraw]).toEqual([false, true]);
            for (const m of [asAuthor, asTaker]) expect([m.release, m.cancelHold]).toEqual([false, false]);
        });
        it(`${kind.name}: finished, cancelled or declined, no buttons`, () => {
            for (const status of ['completed', 'cancelled', 'rejected']) {
                for (const m of [dealMoves(deal(kind, ME, DAMO, status), ME)!, dealMoves(deal(kind, DAMO, ME, status), ME)!]) {
                    expect([m.release, m.cancelHold, m.answer, m.withdraw]).toEqual([false, false, false, false]);
                }
            }
        });
        it(`${kind.name}: a stranger stands on nothing`, () => {
            for (const status of ['requested', 'pending', 'completed']) expect(dealMoves(deal(kind, DAMO, KOFI, status), ME)).toBeNull();
        });
    }
});

describe("dealMoves: a keeper acts as the enterprise, as the node lets them", () => {
    const need = KINDS[3];
    const offer = KINDS[1];
    it("on the enterprise's Need a keeper releases as it; the node has no door for a keeper to cancel the hold", () => {
        const m = dealMoves(deal(need, ENT, DAMO, 'pending'), ME, [ENT])!;
        expect(m).toMatchObject({ actingAs: ENT, asKeeper: true, release: true, cancelHold: false });
    });
    it("on the enterprise's Offer a keeper neither releases (the buyer pays) nor cancels", () => {
        const m = dealMoves(deal(offer, ENT, DAMO, 'pending'), ME, [ENT])!;
        expect(m).toMatchObject({ actingAs: ENT, release: false, cancelHold: false });
    });
    it("a request the enterprise made has no door for its keeper to withdraw it", () => {
        expect(dealMoves(deal(need, DAMO, ENT, 'requested'), ME, [ENT])).toMatchObject({ actingAs: ENT, answer: false, withdraw: false });
    });
    it("a keeper paid by the enterprise's Need is its payee: no release of their own wages (two-person rule)", () => {
        const m = dealMoves(deal(need, ENT, ME, 'pending'), ME, [ENT])!;
        expect(m).toMatchObject({ actingAs: ME, asKeeper: false, release: false, cancelHold: true });
    });
    it("a keeper answers a request on the enterprise's listing, but not their own request on its Need", () => {
        expect(dealMoves(deal(need, ENT, DAMO, 'requested'), ME, [ENT])).toMatchObject({ actingAs: ENT, answer: true });
        expect(dealMoves(deal(KINDS[2], ENT, DAMO, 'requested'), ME, [ENT])).toMatchObject({ actingAs: ENT, answer: true });
        expect(dealMoves(deal(need, ENT, ME, 'requested'), ME, [ENT])).toMatchObject({ actingAs: ME, answer: false, withdraw: true });
    });
    it('a keeper of another enterprise is a stranger', () => {
        expect(dealMoves(deal(need, ENT, DAMO, 'pending'), ME, ['other-co'])).toBeNull();
        expect(dealSideOf(deal(need, ENT, DAMO, 'pending'), ME, [])).toBeNull();
    });
});

describe('listingDeals: the page, by who you are', () => {
    const recurring = { id: 'p', authorPublicKey: DAMO, type: 'offer', status: 'active' };
    it("the author of a recurring Offer sees one row per open deal, no Accept; each buyer sees only their own", () => {
        const txs = [deal(KINDS[1], DAMO, ME, 'pending', 'tx-me'), deal(KINDS[1], DAMO, KOFI, 'pending', 'tx-kofi'), deal(KINDS[1], DAMO, ANA, 'completed', 'tx-ana')];
        const author = listingDeals(txs, recurring, DAMO, [], NOW);
        expect(author.own).toBe(true);
        expect(author.held.map(m => m.tx.id).sort()).toEqual(['tx-kofi', 'tx-me']);
        expect(author.canTakeUp).toBe(false);
        expect(author.lastDone).toBeNull();
        const buyer = listingDeals(txs, recurring, ME, [], NOW);
        expect(buyer.own).toBe(false);
        expect(buyer.held.map(m => m.tx.id)).toEqual(['tx-me']);
        expect(buyer.held[0].release).toBe(true);
        expect(buyer.canTakeUp).toBe(false);
        const stranger = listingDeals(txs, recurring, 'zed', [], NOW);
        expect(stranger).toMatchObject({ own: false, held: [], requests: [], asked: null, lastDone: null, takenByOther: false, canTakeUp: true });
    });
    it("a keeper of the enterprise is its own people: every deal on it, and no Accept", () => {
        const ent = { ...recurring, authorPublicKey: ENT };
        const txs = [deal(KINDS[1], ENT, DAMO, 'pending', 'tx-1'), deal(KINDS[1], ENT, KOFI, 'pending', 'tx-2')];
        const keeper = listingDeals(txs, ent, ME, [ENT], NOW);
        expect(keeper.own).toBe(true);
        expect(keeper.held.map(m => [m.tx.id, m.actingAs, m.release, m.cancelHold])).toEqual([['tx-1', ENT, false, false], ['tx-2', ENT, false, false]]);
        expect(keeper.canTakeUp).toBe(false);
    });
    it("a request waits on the author's list; the one who asked sees it as theirs, and may not ask again", () => {
        const need = { id: 'p', authorPublicKey: DAMO, type: 'need', status: 'active' };
        const txs = [deal(KINDS[4], DAMO, ME, 'requested', 'tx-ask')];
        expect(listingDeals(txs, need, DAMO, [], NOW).requests.map(m => m.tx.id)).toEqual(['tx-ask']);
        const helper = listingDeals(txs, need, ME, [], NOW);
        expect(helper.asked?.tx.id).toBe('tx-ask');
        expect(helper.requests).toEqual([]);
        expect(helper.canTakeUp).toBe(false);
    });
    it('a one-off taken by someone else says so to others, never to its people; a recurring one says nothing', () => {
        const txs = [deal(KINDS[0], DAMO, KOFI, 'pending')];
        expect(listingDeals(txs, { id: 'p', authorPublicKey: DAMO, type: 'offer', status: 'pending' }, ME, [], NOW).takenByOther).toBe(true);
        expect(listingDeals(txs, { id: 'p', authorPublicKey: DAMO, type: 'offer', status: 'pending' }, DAMO, [], NOW).takenByOther).toBe(false);
        expect(listingDeals(txs, recurring, ME, [], NOW).takenByOther).toBe(false);
    });
    it("a recurring Offer whose last deal is done: Accept again, and that deal named", () => {
        const older = { ...deal(KINDS[1], DAMO, ME, 'completed', 'tx-old'), completedAt: '2026-10-01T00:00:00Z' };
        const newer = { ...deal(KINDS[1], DAMO, ME, 'completed', 'tx-new'), completedAt: '2026-10-20T00:00:00Z' };
        const page = listingDeals([older, newer], recurring, ME, [], NOW);
        expect(page.canTakeUp).toBe(true);
        expect(page.lastDone?.tx.id).toBe('tx-new');
    });
    it('a deal on another listing counts for nothing, and one row seen twice is one deal', () => {
        const mineHere = deal(KINDS[1], DAMO, ME, 'pending', 'tx-me');
        const elsewhere = { ...deal(KINDS[1], DAMO, ME, 'pending', 'tx-else'), postId: 'q' };
        expect(listingDeals([mineHere, mineHere, elsewhere], recurring, DAMO, [], NOW).held.map(m => m.tx.id)).toEqual(['tx-me']);
    });
    it("a row without the listing's author still knows who answers (the listing says)", () => {
        const bare = { ...deal(KINDS[3], DAMO, ME, 'requested'), postAuthorPublicKey: undefined, postType: undefined };
        expect(listingDeals([bare], { id: 'p', authorPublicKey: DAMO, type: 'need' }, DAMO, [], NOW).requests).toHaveLength(1);
    });
});

describe('listingChips: the card says only what is the member’s own', () => {
    const txs = [
        deal(KINDS[1], DAMO, ME, 'pending', 'a'),
        { ...deal(KINDS[3], KOFI, ME, 'requested', 'b'), postId: 'q' },
        { ...deal(KINDS[1], DAMO, KOFI, 'pending', 'c'), postId: 'r' },
        { ...deal(KINDS[1], DAMO, ME, 'completed', 'd'), postId: 's' },
    ];
    it('🤝 IN TRUST on a deal held, ✋ ASKED on a request, nothing on a stranger’s or a finished one', () => {
        const chips = listingChips(txs, ME);
        expect([...chips.entries()].sort()).toEqual([['p', 'in-trust'], ['q', 'asked']]);
        expect(listingChipWords(chips.get('p')!)).toBe('🤝 IN TRUST');
        expect(listingChipWords(chips.get('q')!)).toBe('✋ ASKED');
        // Kofi's deal on r is Kofi's and Damo's: their cards say it to them, never to anyone else.
        expect(listingChips(txs, ANA).size).toBe(0);
        expect(listingChips(txs, KOFI).get('r')).toBe('in-trust');
    });
    it('held in trust wins over a request on the same listing', () => {
        const both = [{ ...deal(KINDS[4], DAMO, ME, 'requested', 'x') }, deal(KINDS[4], DAMO, ME, 'pending', 'y')];
        expect(listingChips(both, ME).get('p')).toBe('in-trust');
    });
});

describe("listingDealLines.heldRow: a deal's own amount, and nothing held on a free one", () => {
    const fr = JSON.parse(readFileSync(new URL('../../words/fr.json', import.meta.url), 'utf8')) as Catalog;
    afterEach(() => setLanguage('en'));
    it('the Beans held, in the language’s way', () => {
        expect(listingDealLines.heldRow('Mo', 20, '24 Oct')).toBe('Mo · 20 Beans held · since 24 Oct');
        expect(listingDealLines.heldRow('Mo', 12.5, '24 Oct')).toBe('Mo · 12.5 Beans held · since 24 Oct');
        setLanguage('fr', [fr]);
        expect(listingDealLines.heldRow('Mo', 12.5, '24 oct.')).toBe('Mo · 12,5 Haricots retenus · depuis le 24 oct.');
    });
    it('a free loan (or any deal for nothing) never reads "0 Beans held"', () => {
        expect(listingDealLines.heldRow('Mo', 0, '24 Oct')).toBe('Mo · no Beans held · since 24 Oct');
        setLanguage('fr', [fr]);
        expect(listingDealLines.heldRow('Mo', 0, '24 oct.')).toBe('Mo · aucun Haricot retenu · depuis le 24 oct.');
    });
});

describe("listingDealLines.helping: a helper's deal by its own amount, and nothing held on a free Need", () => {
    const fr = JSON.parse(readFileSync(new URL('../../words/fr.json', import.meta.url), 'utf8')) as Catalog;
    afterEach(() => setLanguage('en'));
    it('the Beans held for them, in the language’s way', () => {
        expect(listingDealLines.helping(20)).toBe("You're helping with this · 20 Beans held for you");
        expect(listingDealLines.helping(12.5)).toBe("You're helping with this · 12.5 Beans held for you");
        setLanguage('fr', [fr]);
        expect(listingDealLines.helping(12.5)).toBe('Vous aidez pour ceci · 12,5 Haricots retenus pour vous');
    });
    it('a free Need never reads "0 Beans held for you"', () => {
        expect(listingDealLines.helping(0)).toBe("You're helping with this · no Beans held");
        setLanguage('fr', [fr]);
        expect(listingDealLines.helping(0)).toBe('Vous aidez pour ceci · aucun Haricot retenu');
    });
});

describe("releaseAmount and releaseLine: what a payer's Release moves, as the node pays it (review on #2588)", () => {
    const fr = JSON.parse(readFileSync(new URL('../../words/fr.json', import.meta.url), 'utf8')) as Catalog;
    afterEach(() => setLanguage('en'));
    const daily = { priceType: 'daily' };
    // A daily Need at 20 Beans a day, struck for 3 days: 60 held.
    const held3 = { credits: 60, hours: 3 };
    it('a deal struck for a time pays its own rate for the time confirmed: 3 days changed to 5 releases 100, not the 60 held', () => {
        expect(releaseAmount(held3, 5, daily)).toBe(100);
        expect(releaseAmount(held3, 3, daily)).toBe(60);
        expect(releaseAmount(held3, 1.5, daily)).toBe(30);
        expect(releaseLine(held3, daily, parseAmount('5', 'en', ANY_DECIMALS), 'Helper')).toBe('Transferring 100 B to Helper');
        expect(releaseLine(held3, daily, parseAmount('2', 'en', ANY_DECIMALS), 'Helper')).toBe('Transferring 40 B to Helper');
    });
    it('its own rate, never the listing price: a deal struck at 15 a day pays 15 a day', () => {
        expect(releaseAmount({ credits: 45, hours: 3 }, 4, daily)).toBe(60);
    });
    it('a fixed price, a loan for one fee, or a deal with no time on it pays what it holds, whatever is typed', () => {
        expect(releaseAmount({ credits: 45, hours: null }, undefined, { priceType: 'fixed' })).toBe(45);
        expect(releaseLine({ credits: 45, hours: null }, { priceType: 'fixed' }, null, 'Damo')).toBe('Transferring 45 B to Damo');
        expect(releaseAmount({ credits: 10, hours: 7 }, 9, { priceType: 'fixed', lendable: 1 })).toBe(10);
        expect(releaseAmount({ credits: 30, hours: null }, 4, daily)).toBe(30);
    });
    it('a time that is not above 0 releases nothing (Release is off for it); one that could mean two numbers says why', () => {
        expect(releaseLine(held3, daily, parseAmount('', 'en', ANY_DECIMALS), 'Helper')).toBe('Transferring 0 B to Helper');
        expect(releaseLine(held3, daily, parseAmount('0', 'en', ANY_DECIMALS), 'Helper')).toBe('Transferring 0 B to Helper');
        expect(releaseLine(held3, daily, parseAmount('1,000', 'en', ANY_DECIMALS), 'Helper')).toBe('Type the amount without thousands separators, like 1000.5.');
    });
    it("to the cent, in the language's way", () => {
        const thirds = { credits: 100, hours: 3 };
        expect(releaseLine(thirds, daily, parseAmount('2', 'en', ANY_DECIMALS), 'Mo')).toBe('Transferring 66.67 B to Mo');
        setLanguage('fr', [fr]);
        expect(releaseLine(thirds, daily, parseAmount('2', 'fr', ANY_DECIMALS), 'Mo')).toBe('Transfert de 66,67 B à Mo');
    });
});

describe('listingDealLines.finished: what became of a deal an alert named, from its status (review on #2588)', () => {
    it('one line for each way a deal ends; none while it is open', () => {
        expect(listingDealLines.finished('rejected')).toBe('That request was declined.');
        expect(listingDealLines.finished('cancelled')).toBe('That deal was cancelled.');
        expect(listingDealLines.finished('completed')).toBe('That deal is done.');
        expect(listingDealLines.finished('pending')).toBeNull();
        expect(listingDealLines.finished('requested')).toBeNull();
    });
});
