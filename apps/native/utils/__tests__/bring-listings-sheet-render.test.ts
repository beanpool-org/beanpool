// @vitest-environment jsdom
/**
 * The Bring my listings sheet as Home draws it (components/BringListingsSheet.tsx, BringListingsSheetView.tsx), at the floor:
 * 320 dp wide with the phone's text at 1.3× (memory product-audience-small-screens), in the light and the dark set. React
 * Native is drawn as DOM with each host's style kept, and yoga-dom-layout.ts lays it out with Yoga, the engine a phone
 * runs. e2e/bring-listings-320.mjs draws the same view in Chromium, for its words and its contrast.
 *
 * The sheet itself: no answer means no sheet and the offer kept; a yes runs and says what came of it; a later run asks
 * nothing and is quiet until it has something to say; and no state leaves a member on a sheet with no way out.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { layOut } from './yoga-dom-layout';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const WIDTH = 320;
const HEIGHT = 569;

vi.mock('react-native', () => {
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, testID, accessibilityRole, style, numberOfLines, onRequestClose } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (onRequestClose) attrs['data-back'] = 'yes';
        return createElement(tag, attrs, children);
    };
    const ScrollView = ({ children, style, contentContainerStyle }: Record<string, any>) => createElement(
        'div', { 'data-style': JSON.stringify({ ...flat(style), overflow: 'scroll' }), 'data-testid': 'bring-listings-scroll' },
        createElement('div', { 'data-style': JSON.stringify({ ...flat(contentContainerStyle), flexShrink: 0 }) }, children),
    );
    const backs: Array<() => void> = [];
    (globalThis as any).__modalBack = backs;
    const Modal = ({ children, onRequestClose }: Record<string, any>) => {
        backs[0] = onRequestClose;
        return createElement('div', { 'data-style': JSON.stringify({ flex: 1 }), 'data-testid': 'modal' }, children);
    };
    return {
        Platform: { OS: 'android' }, StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
        View: el('div'), Text: el('span'), Pressable: el('div'), ActivityIndicator: el('i'), ScrollView, Modal,
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit() {} },
        useWindowDimensions: () => ({ width: WIDTH, height: HEIGHT, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) }));
const theme = vi.hoisted(() => ({ colors: null as any, scheme: 'light' }));
vi.mock('../../app/ThemeContext', () => ({ useStyles: (make: (t: unknown) => unknown) => make({ theme: theme.scheme, colors: theme.colors }) }));
const world = vi.hoisted(() => ({
    identity: { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32) } as any,
    focus: null as null | (() => void | (() => void)),
    anchor: 'https://mullum.example.org' as string | null,
    beans: true as boolean | undefined,
    sync: 0,
}));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: world.identity }) }));
vi.mock('expo-router', () => ({ useFocusEffect: (cb: () => void) => { world.focus = cb; } }));
vi.mock('../node-post', () => ({ anchorUrl: async () => world.anchor, signedGet: vi.fn(), signedPost: vi.fn() }));
vi.mock('../node-profile', () => ({ GLOBAL_NODE_URL: 'https://global.beanpool.org', beansOn: (f: { beans?: boolean } | undefined) => f?.beans !== false, getCachedNodeProfile: async () => ({ features: { beans: world.beans } }) }));
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => { world.sync++; } }));
const calls = vi.hoisted(() => ({
    pending: vi.fn(), plan: vi.fn(), run: vi.fn(), settle: vi.fn(async () => {}), close: vi.fn(async () => {}), putOff: vi.fn(async () => {}),
    accept: vi.fn(async (o: unknown) => o),
}));
vi.mock('../bring-listings', async (actual) => ({
    ...(await actual<Record<string, unknown>>()),
    pendingBringOffer: calls.pending, planBring: calls.plan, runBring: calls.run, settleBringOffer: calls.settle, closeBringOffer: calls.close,
    putOffBringOffer: calls.putOff, acceptBringOffer: calls.accept,
}));

import { BringListingsSheet } from '../../components/BringListingsSheet';
import { BringListingsSheetView, type BringStep } from '../../components/BringListingsSheetView';
import { darkColors, lightColors } from '../../constants/colors';
import { BRING_WORDS, type BringLine, type BringOffer, type BringPlan, type BringResult, type OwnListing } from '../bring-listings';

const OFFER: BringOffer = { publicKey: world.identity.publicKey, from: 'https://global.beanpool.org', to: 'https://mullum.example.org', name: 'Mullumbimby', at: 1 };
const LISTING = { id: 'a', title: 'Seedlings' } as OwnListing;
const PLAN: BringPlan = { bring: [LISTING, { ...LISTING, id: 'b' }], gone: [] };
const LONG_NAME = 'Mullumbimby and the Brunswick Valley Community Exchange';

let host: HTMLElement;
let root: Root | null = null;

async function draw(node: ReturnType<typeof createElement>): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
        root = createRoot(host);
        root.render(node);
    });
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** Home comes to the front. */
async function focus(): Promise<void> {
    await act(async () => { world.focus?.(); });
    await flush();
    await flush();
}
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const press = async (id: string) => {
    await act(async () => { byId(id)!.click(); });
    await flush();
    await flush();
};

beforeEach(() => {
    theme.colors = lightColors;
    theme.scheme = 'light';
    world.anchor = OFFER.to;
    world.beans = true;
    world.sync = 0;
    Object.values(calls).forEach((c) => c.mockClear());
    calls.pending.mockResolvedValue(OFFER);
    calls.plan.mockResolvedValue(PLAN);
    calls.run.mockResolvedValue({ brought: 2, lines: [], kept: false, held: false } satisfies BringResult);
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    host?.remove();
});

const LINES: BringLine[] = Array.from({ length: 30 }, (_, i) => ({ kind: 'photos-failed' as const, title: `A rather long listing title, number ${i}` }));
const STATES: Array<[string, BringStep]> = [
    ['the offer', { step: 'offer', name: LONG_NAME, count: 12, noPrice: true }],
    ['the run', { step: 'bringing', done: 3, total: 12 }],
    ['what came of it', { step: 'done', name: LONG_NAME, brought: 9, lines: [{ kind: 'gone', title: 'Old bike' }], kept: true }],
    ['a long list of lines', { step: 'done', name: LONG_NAME, brought: 1, lines: LINES, kept: false }],
];

describe.each([['light', lightColors], ['dark', darkColors]] as const)('the sheet at 320 dp and 1.3× text, %s', (scheme, colors) => {
    it.each(STATES)('%s stays on the screen, its way out above the system bars', async (_what, view) => {
        theme.colors = colors;
        theme.scheme = scheme;
        await draw(createElement(BringListingsSheetView, { view, onBring() {}, onNotNow() {}, onClose() {} }));
        const layout = layOut(byId('modal')!, { width: WIDTH, height: HEIGHT }, { fontScale: 1.3 });
        const sheet = byId('bring-listings-sheet')!;
        const box = layout.box(sheet);
        expect(box.width).toBeLessThanOrEqual(WIDTH);
        // 85% of the window at most, and never under the status bar.
        expect(box.height).toBeLessThanOrEqual(HEIGHT * 0.85 + 0.5);
        expect(box.top + box.height).toBeCloseTo(HEIGHT, 0);
        for (const button of host.querySelectorAll('[role="button"]')) {
            expect(layout.height(button), 'a target of at least 48 dp').toBeGreaterThanOrEqual(48);
            const at = layout.box(button);
            expect(at.left + at.width).toBeLessThanOrEqual(WIDTH);
        }
        const scroll = byId('bring-listings-scroll')!;
        // The words give way, never the buttons: what is under the words fits in the sheet.
        expect(layout.height(scroll)).toBeLessThanOrEqual(box.height);
        expect(layout.height(scroll)).toBeGreaterThan(0);
    });
});

describe('the sheet\'s words', () => {
    it('the offer says what will happen, with the two ways out', async () => {
        await draw(createElement(BringListingsSheetView, { view: STATES[0][1], onBring() {}, onNotNow() {}, onClose() {} }));
        expect(host.textContent).toContain(BRING_WORDS.title(LONG_NAME));
        expect(host.textContent).toContain('Your 12 listings on the global community will be posted there too, by you.');
        expect(host.textContent).toContain('They arrive with no price. You can set one on each listing.');
        expect(byId('bring-listings-yes')!.textContent).toBe('Bring them');
        expect(byId('bring-listings-not-now')!.textContent).toBe('Not now');
    });

    it('no line about a price where the community has no Beans', async () => {
        await draw(createElement(BringListingsSheetView, { view: { step: 'offer', name: 'X', count: 1, noPrice: false }, onBring() {}, onNotNow() {}, onClose() {} }));
        expect(host.textContent).not.toContain('no price');
        expect(byId('bring-listings-yes')!.textContent).toBe('Bring it');
    });
});

describe('Home\'s sheet', () => {
    const shown = () => byId('bring-listings-sheet') !== null;

    it('draws nothing while no offer waits', async () => {
        calls.pending.mockResolvedValue(null);
        await draw(createElement(BringListingsSheet));
        await focus();
        expect(shown()).toBe(false);
        expect(calls.plan).not.toHaveBeenCalled();
    });

    it('offline: no sheet, nothing closed, and the offer is looked at again later', async () => {
        calls.plan.mockResolvedValue('unreachable');
        await draw(createElement(BringListingsSheet));
        await focus();
        expect(shown()).toBe(false);
        expect(calls.close).not.toHaveBeenCalled();
        expect(calls.settle).not.toHaveBeenCalled();
    });

    it('nothing to bring: the offer is over, with no sheet', async () => {
        calls.plan.mockResolvedValue({ bring: [], gone: [] });
        await draw(createElement(BringListingsSheet));
        await focus();
        expect(shown()).toBe(false);
        expect(calls.close).toHaveBeenCalledWith(OFFER.publicKey);
    });

    it('nothing to bring but archived listings: says so once, and the offer is over', async () => {
        calls.plan.mockResolvedValue({ bring: [], gone: ['Old bike'] });
        await draw(createElement(BringListingsSheet));
        await focus();
        expect(host.textContent).toContain('None of your listings came across.');
        expect(host.textContent).toContain('"Old bike" is no longer up on the global community, so it stayed behind.');
        expect(calls.close).toHaveBeenCalled();
        expect(calls.run).not.toHaveBeenCalled();
    });

    it('a yes runs the plan and says what came of it', async () => {
        await draw(createElement(BringListingsSheet));
        await focus();
        expect(host.textContent).toContain('Bring my listings to Mullumbimby?');
        expect(calls.run).not.toHaveBeenCalled();
        await press('bring-listings-yes');
        expect(calls.accept).toHaveBeenCalledWith(OFFER);
        expect(calls.run.mock.calls[0][1]).toBe(PLAN);
        expect(calls.settle).toHaveBeenCalled();
        expect(world.sync).toBe(1);
        expect(host.textContent).toContain('2 listings are now in Mullumbimby.');
        await press('bring-listings-done');
        expect(shown()).toBe(false);
    });

    it('"Not now" puts the offer off, and nothing runs', async () => {
        await draw(createElement(BringListingsSheet));
        await focus();
        await press('bring-listings-not-now');
        expect(calls.putOff).toHaveBeenCalledWith(OFFER);
        expect(calls.run).not.toHaveBeenCalled();
        expect(shown()).toBe(false);
    });

    it('Back on the offer is "Not now": it can always be left', async () => {
        await draw(createElement(BringListingsSheet));
        await focus();
        await act(async () => { (globalThis as any).__modalBack[0](); });
        await flush();
        expect(calls.putOff).toHaveBeenCalledWith(OFFER);
        expect(shown()).toBe(false);
    });

    it('a run that fails outright never leaves the member on a sheet with no way out', async () => {
        calls.run.mockRejectedValue(new Error('storage full'));
        await draw(createElement(BringListingsSheet));
        await focus();
        await press('bring-listings-yes');
        expect(shown()).toBe(false);
    });

    it('the run can be left: it goes on behind the sheet, and says what came of it when it ends', async () => {
        let finish: (r: BringResult) => void = () => {};
        calls.run.mockImplementation(async (_o: unknown, _p: unknown, _i: unknown, onStep: (d: number, t: number) => void) => {
            onStep(1, 2);
            return new Promise<BringResult>((resolve) => { finish = resolve; });
        });
        await draw(createElement(BringListingsSheet));
        await focus();
        await press('bring-listings-yes');
        expect(host.textContent).toContain('Bringing 1 of 2…');
        await press('bring-listings-hide');
        expect(shown()).toBe(false);
        expect(calls.settle).not.toHaveBeenCalled();
        await act(async () => { finish({ brought: 2, lines: [], kept: false, held: false }); });
        await flush();
        expect(calls.settle).toHaveBeenCalled();
        expect(host.textContent).toContain('2 listings are now in Mullumbimby.');
    });

    it('a run that leaves something for later says so', async () => {
        calls.run.mockResolvedValue({ brought: 1, lines: [], kept: true, held: false });
        await draw(createElement(BringListingsSheet));
        await focus();
        await press('bring-listings-yes');
        expect(host.textContent).toContain('A community could not be reached. The rest will be tried again next time you open Home.');
    });

    describe('after a yes', () => {
        beforeEach(() => { calls.pending.mockResolvedValue({ ...OFFER, accepted: true, tries: 1 }); });

        it('asks nothing, and stays quiet while there is still more to do', async () => {
            calls.run.mockResolvedValue({ brought: 1, lines: [], kept: true, held: false });
            await draw(createElement(BringListingsSheet));
            await focus();
            expect(calls.run).toHaveBeenCalled();
            expect(shown()).toBe(false);
            expect(calls.settle).toHaveBeenCalled();
        });

        it('says so when it has finished', async () => {
            calls.run.mockResolvedValue({ brought: 1, lines: [], kept: false, held: false });
            await draw(createElement(BringListingsSheet));
            await focus();
            expect(host.textContent).toContain('1 listing is now in Mullumbimby.');
        });

        it('does not repeat what stayed behind, and with nothing left closes quietly', async () => {
            calls.plan.mockResolvedValue({ bring: [], gone: ['Old bike'] });
            await draw(createElement(BringListingsSheet));
            await focus();
            expect(calls.close).toHaveBeenCalled();
            expect(calls.run).not.toHaveBeenCalled();
            expect(shown()).toBe(false);
        });
    });

    it('looks at most once in five minutes: Home comes to the front at every tab change', async () => {
        calls.plan.mockResolvedValue('unreachable');
        await draw(createElement(BringListingsSheet));
        await focus();
        await focus();
        expect(calls.plan).toHaveBeenCalledTimes(1);
    });
});
