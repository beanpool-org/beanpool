import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    busyError, feeOf, formatHundredths, takeUpListingMoved, takeUpOutcomeOf, takeUpRefusalText, takeUpUnansweredBook, type TakeUpButton,
} from '@beanpool/core';
import { EnterpriseTakeUp } from './EnterpriseTakeUp';

/**
 * "Buy for {enterprise}" on the web (DESIGN-stall-consignment-fable.md §5.6, §6 slice 2): components/EnterpriseTakeUp.tsx draws
 * core's buttons, the member's count picker and the §5.6 sentence, and sends exactly what the sheet showed with a retry id (the
 * same id on a retry, a new one for another sale); refusals show core's words; the item page and the console use core's rules.
 * Who sees the button, the sheet's figures and every refusal's words are core's (packages/beanpool-core enterprise-take-up.test.ts);
 * the phone's twin is apps/native/utils/__tests__/enterprise-take-up.test.ts. Each check names the change that turns it red.
 */
const STALL = 'stall-key';
const BUTTON: TakeUpButton = { enterprise: STALL, name: 'Riverside stall', label: 'Buy for Riverside stall' };
// The web's post of a member's Offer: 20 Beans each, 3 left.
const APPLES = { id: 'p1', type: 'offer', priceType: 'each', price_c: 2000, unitsLeft: 3, status: 'active', authorPublicKey: 'alice-key', title: 'Apples' };

afterEach(cleanup);

function draw(props: Partial<Parameters<typeof EnterpriseTakeUp>[0]> = {}) {
    const send = props.send ?? vi.fn(async () => ({ success: true, released: true }));
    const onDone = props.onDone ?? vi.fn();
    const onListingMoved = props.onListingMoved ?? vi.fn();
    render(<EnterpriseTakeUp listing={APPLES} postId="p1" title="Apples" sellerName="Alice" buttons={[BUTTON]} send={send} onDone={onDone}
        onListingMoved={onListingMoved} {...props} />);
    return { send, onDone, onListingMoved };
}
const tap = async (id: string) => { await act(async () => { fireEvent.click(screen.getByTestId(id)); }); };

describe('components/EnterpriseTakeUp.tsx: the button, the count picker, the sheet', () => {
    it('no buttons: nothing drawn (red if an empty box shows for a member who keeps nothing)', () => {
        const { container } = render(<EnterpriseTakeUp listing={APPLES} postId="p1" title="Apples" sellerName="Alice" buttons={[]} send={vi.fn()} onDone={vi.fn()} />);
        expect(container.textContent).toBe('');
    });

    it('a button per enterprise; a tap opens the count picker and the §5.6 sentence, whose figures are the fee function\'s', async () => {
        draw({ buttons: [BUTTON, { enterprise: 'cafe-key', name: 'Hill Cafe', label: 'Buy for Hill Cafe' }] });
        expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Buy for Riverside stall', 'Buy for Hill Cafe']);
        await tap(`take-up-${STALL}`);
        expect(screen.getByTestId('each-take-up')).toBeTruthy();
        expect(screen.queryByTestId('each-trust')).toBeNull(); // the member's own "into trust … when you release" is not this sale's
        expect(screen.getByTestId('take-up-sentence').textContent).toBe('Riverside stall pays Alice 20 Beans for 1 of “Apples”. Alice gets 19.70 Beans; 0.30 Beans go to the Commons. BeanPool moves Beans only. Any cash is between you and the buyer.');
        await tap('each-more');
        const total = 4000, fee = feeOf(total);
        expect(screen.getByTestId('take-up-sentence').textContent).toContain(`pays Alice ${formatHundredths(total)} Beans for 2 of “Apples”. Alice gets ${formatHundredths(total - fee)} Beans; ${formatHundredths(fee)} Beans go to the Commons.`);
    });

    it('Confirm sends the total the sheet showed, the count, the way and a retry id, no key; released -> onDone(released)', async () => {
        const { send, onDone } = draw();
        await tap(`take-up-${STALL}`);
        await tap('each-more');
        await tap('take-up-confirm');
        expect(send).toHaveBeenCalledTimes(1);
        const [enterprise, body] = (send as any).mock.calls[0];
        expect(enterprise).toBe(STALL);
        expect(body).toMatchObject({ postId: 'p1', hours: 2, itemOption: 'each', expect_c: 4000 });
        expect(body.requestId).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
        expect(Object.keys(body).sort()).toEqual(['expect_c', 'hours', 'itemOption', 'postId', 'requestId']);
        expect(onDone).toHaveBeenCalledWith(BUTTON, { released: true, held: null });
        expect(screen.queryByTestId('take-up-sheet')).toBeNull();
    });

    it('the node\'s own refusal, then Confirm again on the same sale: the same id; another count: a new id', async () => {
        const refused = () => Object.assign(new Error('You are not a keeper of this enterprise'), { status: 403 });
        const send = vi.fn().mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused()).mockResolvedValue({ success: true, released: true });
        draw({ send, unanswered: takeUpUnansweredBook() });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        expect(screen.getByTestId('take-up-refusal').textContent).toBe('You are not a keeper of this enterprise');
        await tap('take-up-confirm');
        const ids = send.mock.calls.map((c: any[]) => c[1].requestId);
        expect(ids[1]).toBe(ids[0]);
        await tap('each-more');
        await tap('take-up-confirm');
        expect(send.mock.calls[2][1].requestId).not.toBe(ids[0]);
    });

    it('a refusal with a code shows core\'s line, nothing is paid, and a moved listing is read again', async () => {
        const send = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('Cannot accept your own post'), { status: 403, code: 'TWO_PERSON_RULE' }))
            .mockRejectedValueOnce(Object.assign(new Error('Post not found or not active'), { status: 400, code: 'post_gone' }));
        const { onDone, onListingMoved } = draw({ send });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        expect(screen.getByTestId('take-up-refusal').textContent).toBe('A keeper can’t buy their own Offer for the enterprise. Another keeper can.');
        expect(onListingMoved).not.toHaveBeenCalled();
        await tap('take-up-confirm');
        expect(screen.getByTestId('take-up-refusal').textContent).toBe('This Offer is no longer on the board, so nothing was paid.');
        expect(onListingMoved).toHaveBeenCalledTimes(1);
        expect(onDone).not.toHaveBeenCalled();
    });

    it('held, not released: onDone carries the node\'s words (never a false success)', async () => {
        const held = 'The Beans are held for this sale, but it isn’t released yet. A keeper can release it from the enterprise’s deals.';
        const { onDone } = draw({ send: vi.fn(async () => ({ success: true, released: false, error: held })) });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        expect(onDone).toHaveBeenCalledWith(BUTTON, { released: false, held });
    });

    it('dark mode and 320 px: every line of the sheet has its dark ink and wraps (red if a line is light-only or can overflow)', async () => {
        draw();
        await tap(`take-up-${STALL}`);
        for (const id of ['take-up-sheet', 'take-up-sentence']) {
            const cls = screen.getByTestId(id).className;
            expect(cls).toMatch(/dark:(bg|text)-/);
        }
        expect(screen.getByTestId('take-up-sentence').className).toContain('break-words');
        expect(screen.getByText('Buy for Riverside stall').className).toContain('break-words');
    });
});

describe('an answer that never came: the stall may have paid, and Confirm sends the same sale again (r1 review finding 1)', () => {
    const LOST_LINE = 'Your community’s server didn’t answer, so Riverside stall may have paid Alice already. Press Confirm again to find out: it is never paid twice.';
    const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);
    // Every shape lib/api.ts request throws for a take-up. What the sheet does is core takeUpOutcomeOf's (its table pins the
    // outcome of each); this checks the web's sheet does exactly that: says the line or the refusal, reads the listing
    // again, and keeps the sale through Cancel (the same id on reopening) only when it may have gone through.
    const SHAPES: Array<[string, () => unknown]> = [
        ['Failed to fetch', () => new TypeError('Failed to fetch')],
        ['Load failed', () => new TypeError('Load failed')],
        ['an abort', () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })],
        ['a gateway 502, no JSON', () => err('Bad Gateway', { status: 502, unsaid: true })],
        ['a gateway 504, no JSON', () => err('Gateway Timeout', { status: 504, unsaid: true })],
        ['the busy network\'s 429', () => busyError(null)],
        ['a proxy\'s 403 page', () => err('Forbidden', { status: 403, unsaid: true })],
        ['deal_open', () => err('You already have a deal under way.', { status: 409, code: 'deal_open' })],
        ['units_gone', () => err('Only 1 left.', { status: 409, code: 'units_gone', unitsLeft: 1 })],
        ['post_gone', () => err('Post not found or not active', { status: 400, code: 'post_gone' })],
        ['TWO_PERSON_RULE', () => err('Cannot accept your own post', { status: 403, code: 'TWO_PERSON_RULE' })],
    ];
    for (const [name, thrown] of SHAPES) {
        const outcome = takeUpOutcomeOf(thrown());
        it(`${name} (${outcome}): the sheet does what core says, and Cancel then Confirm ${outcome === 'lost' ? 'sends the SAME sale' : 'is a sale of its own'}`, async () => {
            const send = vi.fn().mockRejectedValueOnce(thrown()).mockResolvedValue({ success: true, released: true, replay: true });
            const { onListingMoved, onDone } = draw({ send, unanswered: takeUpUnansweredBook() });
            await tap(`take-up-${STALL}`);
            await tap('each-more');
            await tap('take-up-confirm');
            const first = send.mock.calls[0][1];
            expect(screen.queryByTestId('take-up-lost')?.textContent ?? null).toBe(outcome === 'lost' ? LOST_LINE : null);
            expect(screen.queryByTestId('take-up-refusal')?.textContent ?? null).toBe(outcome === 'lost' ? null : takeUpRefusalText(thrown()));
            expect(onListingMoved).toHaveBeenCalledTimes(outcome === 'lost' || (outcome === 'refused' && takeUpListingMoved(thrown())) ? 1 : 0);
            expect(onDone).not.toHaveBeenCalled();
            // Cancel, then "Buy for …" again, and Confirm straight away (the picker starts at 1 again).
            await tap('take-up-cancel');
            await tap(`take-up-${STALL}`);
            expect(screen.queryByTestId('each-take-up') === null).toBe(outcome === 'lost'); // the picker waits on a kept sale
            await tap('take-up-confirm');
            const second = send.mock.calls[1][1];
            if (outcome === 'lost') expect(second).toEqual(first);
            else expect([second.requestId === first.requestId, second.hours]).toEqual([false, 1]);
            expect(onDone).toHaveBeenCalledWith(BUTTON, { released: true, held: null });
        });
    }

    it('the review\'s scenario: 2 of “Apples” lost, Cancel, the listing read again with 1 left, reopen, Confirm: the same 2, the same id', async () => {
        const book = takeUpUnansweredBook();
        const send = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({ success: true, released: true, replay: true });
        const onListingMoved = vi.fn();
        const props = { postId: 'p1', title: 'Apples', sellerName: 'Alice', buttons: [BUTTON], send, onDone: vi.fn(), onListingMoved, unanswered: book };
        const { rerender } = render(<EnterpriseTakeUp listing={APPLES} {...props} />);
        await tap(`take-up-${STALL}`);
        await tap('each-more');
        await tap('take-up-confirm');
        expect(onListingMoved).toHaveBeenCalledTimes(1);
        await tap('take-up-cancel');
        rerender(<EnterpriseTakeUp listing={{ ...APPLES, unitsLeft: 1 }} {...props} />); // the first sale went through: 1 left
        await tap(`take-up-${STALL}`);
        expect(screen.getByTestId('take-up-sentence').textContent).toContain('pays Alice 40 Beans for 2 of “Apples”');
        expect(screen.getByTestId('take-up-lost').textContent).toBe(LOST_LINE);
        await tap('take-up-confirm');
        expect(send.mock.calls[1][1]).toEqual(send.mock.calls[0][1]);
        expect(book.get(STALL, 'p1')).toBeNull(); // the node answered: forgotten
    });

    it('the listing closed and opened again (the sheet unmounted): the kept sale is still sent again, not a new one', async () => {
        const book = takeUpUnansweredBook();
        const send = vi.fn().mockRejectedValueOnce(err('Bad Gateway', { status: 502, unsaid: true })).mockResolvedValue({ success: true, released: true, replay: true });
        draw({ send, unanswered: book });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        cleanup();
        draw({ send, unanswered: book });
        await tap(`take-up-${STALL}`);
        expect(screen.getByTestId('take-up-lost').textContent).toBe(LOST_LINE);
        await tap('take-up-confirm');
        expect(send.mock.calls[1][1].requestId).toBe(send.mock.calls[0][1].requestId);
    });

    it('closed while still on its way (no answer yet): opened again, Confirm sends that same sale, never a second one', async () => {
        const book = takeUpUnansweredBook();
        const send = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue({ success: true, released: true, replay: true });
        draw({ send, unanswered: book });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        cleanup(); // a fetch with no time limit, still waiting
        draw({ send, unanswered: book });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        expect(send.mock.calls[1][1]).toEqual(send.mock.calls[0][1]);
    });

    it('the line wraps and has its warning ink (red if it can overflow at 320 px)', async () => {
        draw({ send: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), unanswered: takeUpUnansweredBook() });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        expect(screen.getByTestId('take-up-lost').className).toContain('break-words');
        expect(screen.getByTestId('take-up-lost').className).toContain('text-bp-ink-warning');
    });
});

describe('the item page and the console use core\'s rules', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');
    const page = read('../pages/MarketplacePage.tsx');
    const consoleSrc = read('../pages/TreasuryDetailPage.tsx');
    const api = read('../lib/api.ts');

    it('the item page draws core\'s buttons from the node\'s features and the keeper\'s enterprises, never on another community\'s listing', () => {
        // Another community's listing is core's rule now (takeUpButtons reads `_remoteNode` and `originNode`; its table pins it).
        expect(page).toContain('const takeUps = takeUpButtons({ features: communityInfo?.features, listing: selectedPost, me: identity?.publicKey, keeperOf, enterprises: enterpriseNames });');
        expect(page).toContain('<EnterpriseTakeUp listing={selectedPost}');
        expect(page).toContain('send={treasuryTakeUp}');
    });

    it('held, not released: the node\'s words, then the enterprise\'s page, where its keepers release it', () => {
        expect(page).toContain("onNavigate?.('enterprise', b.enterprise);");
    });

    it('lib/api.ts sends the body unchanged to the enterprise\'s door (red if a key field is added or the path changes)', () => {
        expect(api).toContain("return request('POST', `/api/treasury/${encodeURIComponent(treasury)}/take-up`, body);");
    });

    it('the console\'s Release asks no hours for a held take-up priced each (red if it opens "hours worked")', () => {
        expect(consoleSrc).toContain('if (releaseAsksHours(priceType)) {');
        expect(consoleSrc).not.toContain("if (priceType && priceType !== 'fixed') {");
    });
});
