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
import { enterpriseTakeUpOffered, feeOf, formatHundredths, takeUpButtons, type TakeUpButton } from '@beanpool/core';
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

    it('a lost answer, then Confirm again on the same sale: the same id (red if a retry could sell twice); another count: a new id', async () => {
        const send = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('Network request failed. You must be connected to a node.'), { status: 0 }))
            .mockRejectedValueOnce(Object.assign(new Error('Network request failed. You must be connected to a node.'), { status: 0 }))
            .mockResolvedValue({ success: true, released: true, replay: true });
        draw({ send });
        await tap(`take-up-${STALL}`);
        await tap('take-up-confirm');
        expect(q('take-up-refusal')!.textContent).toBe('Network request failed. You must be connected to a node.');
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
