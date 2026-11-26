// @vitest-environment jsdom
/**
 * "Buy for {enterprise}" on the phone (DESIGN-stall-consignment-fable.md §5.6, §6 slice 2): the phone hears the node's
 * `enterpriseTakeUp`, components/EnterpriseTakeUp.tsx draws core's buttons, count picker and sheet and sends exactly what the
 * sheet showed with a retry id (the same id on a retry, a new one for another sale), the refusals show core's words, and
 * the item page and the console are wired to core's rules. Who sees the button, the sheet's figures and every refusal's
 * words are core's (packages/beanpool-core/src/__tests__/enterprise-take-up.test.ts); this file checks what the phone adds.
 * Each check names the change that turns it red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, testID, value, onChangeText, disabled, accessibilityRole, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(style ?? null) };
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (disabled) attrs['data-disabled'] = 'true';
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        return h(tag, attrs, children);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'),
        StyleSheet: { create: (s: unknown) => s },
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: theme.dark ? darkColors : lightColors }) };
});
vi.mock('../../components/signed-request-lines', () => ({ signedRequestWords: (s: string) => s }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));

import { EnterpriseTakeUp } from '../../components/EnterpriseTakeUp';
import { readNodeProfile } from '../node-profile';
import {
    busyError, enterpriseTakeUpOffered, feeOf, formatHundredths, takeUpButtons, takeUpListingMoved, takeUpOutcomeOf, takeUpRefusalText,
    takeUpUnansweredBook, type TakeUpButton,
} from '@beanpool/core';
import { lightColors, darkColors } from '../../constants/colors';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');
const STALL = 'stall-key';
const BUTTON: TakeUpButton = { enterprise: STALL, name: 'Riverside stall', label: 'Buy for Riverside stall' };
// The phone's row of a member's Offer: 20 Beans each, 3 left.
const APPLES = { id: 'p1', type: 'offer', price_type: 'each', price_c: 2000, units_left: 3, status: 'active', author_pubkey: 'alice-key', title: 'Apples' };

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; theme.dark = false; });

function draw(props: Partial<Parameters<typeof EnterpriseTakeUp>[0]> = {}) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const send = props.send ?? vi.fn(async () => ({ success: true, released: true }));
    const onDone = props.onDone ?? vi.fn();
    const onListingMoved = props.onListingMoved ?? vi.fn();
    act(() => root!.render(createElement(EnterpriseTakeUp, {
        listing: APPLES, postId: 'p1', title: 'Apples', sellerName: 'Alice', buttons: [BUTTON], send, onDone, onListingMoved, ...props,
    } as Parameters<typeof EnterpriseTakeUp>[0]) as any));
    return { send, onDone, onListingMoved };
}
const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const tap = async (id: string) => { await act(async () => { q(id)!.click(); }); };

describe('the phone hears the node say it has the door', () => {
    it('`enterpriseTakeUp: true` is kept (red if the key leaves the phone\'s FEATURE_KEYS)', () => {
        expect(enterpriseTakeUpOffered(readNodeProfile({ profile: 'local', features: { beans: true, escrow: true, enterpriseTakeUp: true } })!.features)).toBe(true);
    });
    it('a node that says nothing, false or a string: no door, no button (red if an older node shows it)', () => {
        for (const features of [{ beans: true }, { beans: true, enterpriseTakeUp: false }, { beans: true, enterpriseTakeUp: 'true' }]) {
            const p = readNodeProfile({ profile: 'local', features })!;
            expect(enterpriseTakeUpOffered(p.features)).toBe(false);
            expect(takeUpButtons({ features: p.features, listing: APPLES, me: 'kim-key', keeperOf: [STALL], enterprises: [{ publicKey: STALL, name: 'Riverside stall' }] })).toEqual([]);
        }
    });
    it('another community\'s pulled listing (the row\'s origin_node): no button, as on the web (r1 review finding 2; the door always refuses it)', () => {
        const args = { features: { enterpriseTakeUp: true }, me: 'kim-key', keeperOf: [STALL], enterprises: [{ publicKey: STALL, name: 'Riverside stall' }] };
        expect(takeUpButtons({ ...args, listing: APPLES }).map((b) => b.label)).toEqual(['Buy for Riverside stall']);
        expect(takeUpButtons({ ...args, listing: { ...APPLES, origin_node: 'riverside.example' } })).toEqual([]);
    });
});

describe('components/EnterpriseTakeUp.tsx: the button, the count picker, the sheet', () => {
    it('no buttons: nothing drawn (red if an empty box shows for a member who keeps nothing)', () => {
        draw({ buttons: [] });
        expect(host!.textContent).toBe('');
    });

    it('a button per enterprise; a tap opens the count picker and the §5.6 sentence, whose figures are the fee function\'s', async () => {
        draw({ buttons: [BUTTON, { enterprise: 'cafe-key', name: 'Hill Cafe', label: 'Buy for Hill Cafe' }] });
        expect(Array.from(host!.querySelectorAll('[data-testid="take-up-buttons"] [data-role="button"]')).map((b) => b.textContent)).toEqual(['Buy for Riverside stall', 'Buy for Hill Cafe']);
        await tap(`take-up-${STALL}`);
        expect(q('each-take-up')).not.toBeNull();
        expect(q('each-trust')).toBeNull(); // the member's own "into trust … when you release" is not this sale's
        expect(q('take-up-sentence')!.textContent).toBe('Riverside stall pays Alice 20 Beans for 1 of “Apples”. Alice gets 19.70 Beans; 0.30 Beans go to the Commons. BeanPool moves Beans only. Any cash is between you and the buyer.');
        await tap('each-more');
        const total = 4000, fee = feeOf(total);
        expect(q('take-up-sentence')!.textContent).toContain(`pays Alice ${formatHundredths(total)} Beans for 2 of “Apples”. Alice gets ${formatHundredths(total - fee)} Beans; ${formatHundredths(fee)} Beans go to the Commons.`);
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
        expect(q('take-up-sheet')).toBeNull();
    });

    it('the node\'s own refusal, then Confirm again on the same sale: the same id; another count: a new id', async () => {
        const refused = () => Object.assign(new Error('You are not a keeper of this enterprise'), { status: 403, nodeAnswered: true });
        const send = vi.fn().mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused()).mockResolvedValue({ success: true, released: true });
        draw({ send, unanswered: takeUpUnansweredBook() });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        expect(q('take-up-refusal')!.textContent).toBe('You are not a keeper of this enterprise');
        await tap('take-up-confirm');
        const ids = send.mock.calls.map((c: any[]) => c[1].requestId);
        expect(ids[1]).toBe(ids[0]);
        await tap('each-more');
        await tap('take-up-confirm');
        expect(send.mock.calls[2][1].requestId).not.toBe(ids[0]);
    });

    it('a refusal with a code shows core\'s line, nothing is paid, and a moved listing is read again', async () => {
        const send = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('You already have a deal under way.'), { status: 409, code: 'deal_open' }))
            .mockRejectedValueOnce(Object.assign(new Error('Only 1 left.'), { status: 409, code: 'units_gone', unitsLeft: 1 }));
        const { onDone, onListingMoved } = draw({ send });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        expect(q('take-up-refusal')!.textContent).toBe('The enterprise already has a deal under way on this Offer. A keeper can release it from the enterprise’s deals.');
        expect(onListingMoved).not.toHaveBeenCalled();
        await tap('take-up-confirm');
        expect(q('take-up-refusal')!.textContent).toBe('Only 1 left now. Choose 1 or fewer.');
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

    it('light and dark: the sheet and its words are drawn in the theme\'s own roles (red if a colour is hard-coded)', async () => {
        for (const dark of [false, true]) {
            theme.dark = dark;
            draw();
            await tap(`take-up-${STALL}`);
            const colors = dark ? darkColors : lightColors;
            const style = JSON.parse(q('take-up-sentence')!.getAttribute('data-style')!);
            expect(style.color).toBe(colors.text.body);
            expect(JSON.parse(q('take-up-sheet')!.getAttribute('data-style')!).backgroundColor).toBe(colors.surface.app);
            act(() => root?.unmount()); host?.remove(); root = null; host = null;
        }
    });
});

describe('an answer that never came: the stall may have paid, and Confirm sends the same sale again (r1 review finding 1)', () => {
    const LOST_LINE = 'Your community’s server didn’t answer, so Riverside stall may have paid Alice already. Press Confirm again to find out: it is never paid twice.';
    const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);
    const unmount = () => { act(() => root?.unmount()); host?.remove(); root = null; host = null; };
    // Every shape utils/db.ts _signedRequest throws for a take-up. What the sheet does is core takeUpOutcomeOf's (its table
    // pins the outcome of each); this checks the phone's sheet does exactly that: says the line or the refusal, reads the
    // listing again, and keeps the sale through Cancel (the same id on reopening) only when it may have gone through.
    const SHAPES: Array<[string, () => unknown]> = [
        ['the 12-second abort', () => err('Aborted')],
        ['a dropped signal', () => err('Network request failed')],
        ['a gateway 502', () => err('Server returned 502', { status: 502, nodeAnswered: false })],
        ['a gateway 504', () => err('Server returned 504', { status: 504, nodeAnswered: false })],
        ['the busy network\'s 429', () => busyError(null)],
        ['a proxy\'s 403 page', () => err('Server returned 403', { status: 403, nodeAnswered: false })],
        ['deal_open', () => err('You already have a deal under way.', { status: 409, code: 'deal_open', nodeAnswered: true })],
        ['units_gone', () => err('Only 1 left.', { status: 409, code: 'units_gone', unitsLeft: 1, nodeAnswered: true })],
        ['post_gone', () => err('Post not found or not active', { status: 400, code: 'post_gone', nodeAnswered: true })],
        ['TWO_PERSON_RULE', () => err('Cannot accept your own post', { status: 403, code: 'TWO_PERSON_RULE', nodeAnswered: true })],
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
            expect(q('take-up-lost')?.textContent ?? null).toBe(outcome === 'lost' ? LOST_LINE : null);
            expect(q('take-up-refusal')?.textContent ?? null).toBe(outcome === 'lost' ? null : takeUpRefusalText(thrown()));
            expect(onListingMoved).toHaveBeenCalledTimes(outcome === 'lost' || (outcome === 'refused' && takeUpListingMoved(thrown())) ? 1 : 0);
            expect(onDone).not.toHaveBeenCalled();
            // Cancel, then "Buy for …" again, and Confirm straight away (the picker starts at 1 again).
            await tap('take-up-cancel');
            await tap(`take-up-${STALL}`);
            expect(q('each-take-up') === null).toBe(outcome === 'lost'); // the picker waits on a kept sale
            await tap('take-up-confirm');
            const second = send.mock.calls[1][1];
            if (outcome === 'lost') expect(second).toEqual(first);
            else expect([second.requestId === first.requestId, second.hours]).toEqual([false, 1]);
            expect(onDone).toHaveBeenCalledWith(BUTTON, { released: true, held: null });
        });
    }

    it('the review\'s scenario: 2 of “Apples” lost, Cancel, the listing read again with 1 left, reopen, Confirm: the same 2, the same id', async () => {
        const book = takeUpUnansweredBook();
        const send = vi.fn().mockRejectedValueOnce(err('Aborted')).mockResolvedValue({ success: true, released: true, replay: true });
        const { onListingMoved, onDone } = draw({ send, unanswered: book });
        await tap(`take-up-${STALL}`);
        await tap('each-more');
        await tap('take-up-confirm');
        expect(onListingMoved).toHaveBeenCalledTimes(1);
        await tap('take-up-cancel');
        // The first sale went through: the page reads the listing again, 1 left.
        act(() => root!.render(createElement(EnterpriseTakeUp, {
            listing: { ...APPLES, units_left: 1 }, postId: 'p1', title: 'Apples', sellerName: 'Alice', buttons: [BUTTON], send, onDone, onListingMoved, unanswered: book,
        } as Parameters<typeof EnterpriseTakeUp>[0]) as any));
        await tap(`take-up-${STALL}`);
        expect(q('take-up-sentence')!.textContent).toContain('pays Alice 40 Beans for 2 of “Apples”');
        expect(q('take-up-lost')!.textContent).toBe(LOST_LINE);
        await tap('take-up-confirm');
        expect(send.mock.calls[1][1]).toEqual(send.mock.calls[0][1]);
        expect(book.get(STALL, 'p1')).toBeNull(); // the node answered: forgotten
    });

    it('the page left and opened again (the sheet unmounted): the kept sale is still sent again, not a new one', async () => {
        const book = takeUpUnansweredBook();
        const send = vi.fn().mockRejectedValueOnce(err('Network request failed')).mockResolvedValue({ success: true, released: true, replay: true });
        draw({ send, unanswered: book });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        unmount();
        draw({ send, unanswered: book });
        await tap(`take-up-${STALL}`);
        expect(q('take-up-lost')!.textContent).toBe(LOST_LINE);
        await tap('take-up-confirm');
        expect(send.mock.calls[1][1].requestId).toBe(send.mock.calls[0][1].requestId);
    });

    it('left while still on its way (no answer yet): opened again, Confirm sends that same sale, never a second one', async () => {
        const book = takeUpUnansweredBook();
        const send = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue({ success: true, released: true, replay: true });
        draw({ send, unanswered: book });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        unmount();
        draw({ send, unanswered: book });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        expect(send.mock.calls[1][1]).toEqual(send.mock.calls[0][1]);
    });

    it('light and dark: the line is drawn in the theme\'s warning ink (an answer that never came is not a refusal)', async () => {
        for (const dark of [false, true]) {
            theme.dark = dark;
            draw({ send: vi.fn().mockRejectedValue(err('Aborted')), unanswered: takeUpUnansweredBook() });
            await tap(`take-up-${STALL}`);
            await tap('take-up-confirm');
            expect(JSON.parse(q('take-up-lost')!.getAttribute('data-style')!).color).toBe((dark ? darkColors : lightColors).feedback.warning.fg);
            unmount();
        }
    });
});

describe('a kept sale ages: sent again for a day from its first sending, never after (r2 review: the node forgets the id after 7 days)', () => {
    // The node forgets a take-up's request id after REQUEST_ID_KEPT_DAYS; core's book sends a kept sale again for
    // TAKE_UP_RESEND_HOURS only (pinned inside the node's days by apps/server/src/test-enterprise-take-up.ts). This checks the
    // phone's sheet: past the day the picker shows the listing, the aged line says the stall may have paid, and Confirm sends
    // a NEW sale with a new id, whether the page was left between or the app sat open on the sheet all week.
    const H = 3_600_000;
    const T0 = Date.UTC(2026, 10, 21, 9, 0);
    const AGED_LINE = 'An earlier sale from here got no answer, so Riverside stall may have paid Alice for it already: the enterprise’s deals show whether it did. Confirm makes a new sale.';
    const clocked = () => { const clock = { now: T0 }; return { clock, book: takeUpUnansweredBook(() => clock.now) }; };
    const unmount = () => { act(() => root?.unmount()); host?.remove(); root = null; host = null; };

    it('23 hours on: still the same sale again (red if the day is cut short)', async () => {
        const { clock, book } = clocked();
        const send = vi.fn().mockRejectedValueOnce(new Error('Aborted')).mockResolvedValue({ success: true, released: true, replay: true });
        draw({ send, unanswered: book });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        await tap('take-up-cancel');
        clock.now = T0 + 23 * H;
        await tap(`take-up-${STALL}`);
        expect(q('take-up-aged')).toBeNull();
        expect(q('take-up-lost')).not.toBeNull();
        await tap('take-up-confirm');
        expect(send.mock.calls[1][1]).toEqual(send.mock.calls[0][1]);
    });

    it('a week on, the page left between: the picker, the aged line, and Confirm sends a new sale with a new id (red if last week\'s is sent)', async () => {
        const { clock, book } = clocked();
        const send = vi.fn().mockRejectedValueOnce(new Error('Network request failed')).mockResolvedValue({ success: true, released: true });
        const onDone = vi.fn();
        draw({ send, onDone, unanswered: book });
        await tap(`take-up-${STALL}`);
        await tap('each-more');
        await tap('take-up-confirm');
        unmount();
        clock.now = T0 + 7 * 24 * H;
        draw({ send, onDone, unanswered: book });
        await tap(`take-up-${STALL}`);
        expect(q('take-up-lost')).toBeNull();
        expect(q('take-up-aged')!.textContent).toBe(AGED_LINE);
        expect(q('each-take-up')).not.toBeNull(); // never in the way of this week's buy
        await tap('each-more');
        await tap('take-up-confirm');
        const [lastWeek, thisWeek] = send.mock.calls.map((c: any[]) => c[1]);
        expect(thisWeek).toMatchObject({ postId: 'p1', hours: 2, itemOption: 'each', expect_c: 4000 });
        expect(thisWeek.requestId).not.toBe(lastWeek.requestId);
        expect(onDone).toHaveBeenCalledWith(BUTTON, { released: true, held: null });
        expect([book.get(STALL, 'p1'), book.aged(STALL, 'p1')]).toEqual([null, null]);
    });

    it('a day on, the app left open on the sheet: Confirm finds it aged, shows the picker, then sends the same count under a NEW id', async () => {
        const { clock, book } = clocked();
        const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Server returned 502'), { status: 502, nodeAnswered: false }))
            .mockResolvedValue({ success: true, released: true });
        draw({ send, unanswered: book });
        await tap(`take-up-${STALL}`);
        await tap('each-more');
        await tap('take-up-confirm');
        expect(q('take-up-lost')).not.toBeNull();
        clock.now = T0 + 24 * H;
        await tap('take-up-confirm'); // drawn when it was young: this tap finds it aged and sends nothing
        expect(send).toHaveBeenCalledTimes(1);
        expect(q('take-up-aged')!.textContent).toBe(AGED_LINE);
        expect(q('take-up-sentence')!.textContent).toContain('pays Alice 40 Beans for 2 of “Apples”'); // the picker kept its 2
        await tap('take-up-confirm');
        const [first, second] = send.mock.calls.map((c: any[]) => c[1]);
        expect({ ...second, requestId: 'x' }).toEqual({ ...first, requestId: 'x' });
        expect(second.requestId).not.toBe(first.requestId);
    });

    it('light and dark: the aged line is drawn in the theme\'s warning ink, and the app\'s own book is core\'s, made once', async () => {
        for (const dark of [false, true]) {
            theme.dark = dark;
            const { clock, book } = clocked();
            draw({ send: vi.fn().mockRejectedValue(new Error('Aborted')), unanswered: book });
            await tap(`take-up-${STALL}`);
            await tap('take-up-confirm');
            await tap('take-up-cancel');
            clock.now = T0 + 2 * 24 * H;
            await tap(`take-up-${STALL}`);
            expect(JSON.parse(q('take-up-aged')!.getAttribute('data-style')!).color).toBe((dark ? darkColors : lightColors).feedback.warning.fg);
            unmount();
        }
        const src = read('../../components/EnterpriseTakeUp.tsx');
        expect(src).toContain('const UNANSWERED = takeUpUnansweredBook();');
        expect(src).toContain('const aged = kept ? null : unanswered.aged(open.enterprise, postId);');
        expect(src).not.toMatch(/new Map|AsyncStorage|SecureStore/);
    });
});

describe('the item page and the console use core\'s rules', () => {
    const page = read('../../app/post/[id].tsx');
    const db = read('../db.ts');
    const consoleSrc = read('../../app/treasury-manage.tsx');

    it('the item page draws core\'s buttons from the node\'s features, the keeper\'s enterprises and their names (red if the screen keeps its own rule)', () => {
        expect(page).toContain('takeUpButtons({ features: nodeProfile?.features, listing: post, me, keeperOf: operatedTreasuries, enterprises: takeUpEnterprises })');
        expect(page).toContain('<EnterpriseTakeUp listing={post}');
        expect(page).toContain('send={treasuryTakeUp}');
        // The names are read only for a keeper on an Offer priced each where the node has the door.
        expect(page).toMatch(/const takeUpCould = operatedTreasuries\.length > 0 && enterpriseTakeUpOffered\(nodeProfile\?\.features\)/);
    });

    it('held, not released: the page says the node\'s words and offers the enterprise\'s console, where Release is', () => {
        expect(page).toContain("router.push({ pathname: '/treasury-manage', params: { publicKey: b.enterprise, name: b.name } })");
    });

    it('db.ts sends the body unchanged to the enterprise\'s door (red if a key field is added or the path changes)', () => {
        expect(db).toContain("return _signedRequest(`/api/treasury/${encodeURIComponent(treasury)}/take-up`, body);");
        expect(db).toContain("signedGet('/api/enterprises/statuses')");
    });

    it('the console\'s Release asks no hours for a held take-up priced each (red if it opens "hours worked")', () => {
        expect(consoleSrc).toContain('if (releaseAsksHours(d.price_type)) {');
        expect(consoleSrc).not.toContain("if (d.price_type && d.price_type !== 'fixed') {");
    });
});
