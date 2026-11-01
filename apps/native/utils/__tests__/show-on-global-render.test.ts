// @vitest-environment jsdom
/**
 * The tick and the door as the phone draws them (components/ShowOnGlobalRow.tsx, EventCopyDoor.tsx), at the floor: 320 dp
 * wide with the phone's text at 1.3× (memory product-audience-small-screens), in the light and the dark set, laid out by
 * Yoga as utils/__tests__/bring-listings-sheet-render.test.ts lays out its sheet.
 *
 * The tick: nothing is asked of the global community when the composer opens, only at the tap. Off until tapped, and a
 * phone told it is a stranger there gets the door's words, never a join. The global community itself draws none of it.
 * The door: the words and the way through, to the community's own card; by invite, no button that goes nowhere.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { layOut } from './yoga-dom-layout';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const WIDTH = 320;

vi.mock('react-native', () => {
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, testID, style, accessibilityState, accessibilityHint, disabled } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        if (accessibilityState?.busy !== undefined) attrs['aria-busy'] = String(accessibilityState.busy);
        if (accessibilityHint) attrs['data-a11y-hint'] = accessibilityHint;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' }, StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
        View: el('div'), Text: el('span'), Pressable: el('div'),
        Alert: { alert: (...args: unknown[]) => (globalThis as any).__alerts.push(args) },
    };
});
(globalThis as any).__alerts = [];
const theme = vi.hoisted(() => ({ colors: null as any, scheme: 'light' }));
vi.mock('../../app/ThemeContext', () => ({
    useStyles: (make: (t: unknown) => unknown) => make({ theme: theme.scheme, colors: theme.colors }),
}));
const world = vi.hoisted(() => ({
    identity: { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32) } as any,
    kept: 'unknown' as string,
    answer: 'member' as string,
    pushed: [] as string[],
}));
const calls = vi.hoisted(() => ({ ask: vi.fn(), show: vi.fn(), pair: vi.fn(async () => null) }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: world.identity }) }));
vi.mock('expo-router', () => ({ router: { push: (r: string) => world.pushed.push(r) } }));
vi.mock('../node-post', () => ({ anchorUrl: async () => 'https://mullum.example.org' }));
vi.mock('../global-entry', () => ({ readGlobalStanding: async () => world.kept, askGlobalStanding: calls.ask }));
vi.mock('../show-on-global', () => ({ copyResultLine: () => null, pairOf: calls.pair, showOnGlobal: calls.show, stopShowing: vi.fn() }));

import { EventCopyDoor } from '../../components/EventCopyDoor';
import { ShowOnGlobalTick, showOnGlobalHint } from '../../components/ShowOnGlobalRow';
import { darkColors, lightColors } from '../../constants/colors';

const LONG_NAME = 'Mullumbimby and the Brunswick Valley Community Exchange';
const FROM = { host: 'mullum.example.org', postId: 'p1', name: LONG_NAME, url: 'https://mullum.example.org', door: 'ask' as const };

let host: HTMLElement;
let root: Root | null = null;
const realFetch = globalThis.fetch;
const fetched = vi.fn();

async function draw(node: ReactNode): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
        root = createRoot(host);
        root.render(createElement('div', { 'data-style': JSON.stringify({ width: WIDTH }), 'data-testid': 'floor' }, node as any) as any);
    });
    await settle();
}
/** The row loads what it runs on when it shows: a dynamic import, a few turns. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const press = async (id: string) => {
    await act(async () => { byId(id)!.click(); });
    await settle();
};

beforeEach(() => {
    theme.colors = lightColors;
    theme.scheme = 'light';
    world.kept = 'unknown';
    world.answer = 'member';
    world.pushed = [];
    (globalThis as any).__alerts.length = 0;
    fetched.mockClear();
    globalThis.fetch = fetched as unknown as typeof fetch;
    calls.ask.mockReset();
    calls.ask.mockImplementation(async () => ({ standing: world.answer, closed: false, answered: true }));
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    await act(async () => { root?.unmount(); });
    root = null;
    host?.remove();
});

describe('the tick', () => {
    it('opening the composer asks the global community nothing; the tap does', async () => {
        const changes: boolean[] = [];
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: (v: boolean) => changes.push(v) }));
        expect(byId('show-on-global-tick')!.getAttribute('aria-checked')).toBe('false');
        expect(calls.ask).not.toHaveBeenCalled();
        expect(fetched).not.toHaveBeenCalled();
        await press('show-on-global-tick');
        expect(calls.ask).toHaveBeenCalledTimes(1);
        expect(changes).toEqual([true]);
    });

    it('told it is a stranger there: the door\'s words, and never a join by itself', async () => {
        world.answer = 'stranger';
        const changes: boolean[] = [];
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: (v: boolean) => changes.push(v) }));
        await press('show-on-global-tick');
        expect(changes).toEqual([]);
        expect(byId('show-on-global-tick')).toBeNull();
        expect(byId('show-on-global-join')!.textContent).toContain('Join the global community to show this there');
        expect(world.pushed).toEqual([]);
    });

    it('no answer: said, and left off', async () => {
        world.answer = 'unknown';
        const changes: boolean[] = [];
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: (v: boolean) => changes.push(v) }));
        await press('show-on-global-tick');
        expect(changes).toEqual([]);
        expect((globalThis as any).__alerts).toHaveLength(1);
    });

    it('none where the screen rules it out: the global community itself, online, a group, an enterprise', async () => {
        await draw(createElement(ShowOnGlobalTick, { enabled: false, checked: false, onChange: () => {} }));
        expect(byId('show-on-global-tick')).toBeNull();
        expect(byId('show-on-global-join')).toBeNull();
    });

    it('a tick the form has moved off clears itself: ticked, then Online, a group or another host, it does not go with the event', async () => {
        const changes: boolean[] = [];
        await draw(createElement(ShowOnGlobalTick, { enabled: false, checked: true, onChange: (next: boolean) => changes.push(next) }));
        expect(changes).toEqual([false]);
    });

    it('an online event says why there is no tick', async () => {
        await draw(createElement(ShowOnGlobalTick, { enabled: false, online: true, checked: false, onChange: () => {} }));
        expect(byId('show-on-global-tick')).toBeNull();
        expect(byId('show-on-global-online')?.textContent).toBe("Online events can't be shown on the global community yet.");
    });

    /** The tap's question, held until the test answers it: a signed call of up to 6 s, the first time slower than the form. */
    const heldAnswer = () => {
        let answer!: (standing: string) => void;
        const held = new Promise<{ standing: string; closed: boolean; answered: boolean }>((resolve) => {
            answer = (standing) => resolve({ standing, closed: false, answered: true });
        });
        calls.ask.mockImplementation(() => held);
        return answer;
    };

    it('while the tap is asking the row says so and takes no second tap, and the answer frees it', async () => {
        const answer = heldAnswer();
        const changes: boolean[] = [];
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: (v: boolean) => changes.push(v) }));
        expect(byId('show-on-global-tick')!.getAttribute('aria-busy')).toBe('false');
        await press('show-on-global-tick');
        expect(byId('show-on-global-tick')!.getAttribute('aria-busy')).toBe('true');
        expect(JSON.parse(byId('show-on-global-tick')!.getAttribute('data-style')!).opacity).toBeLessThan(1);
        await press('show-on-global-tick');
        expect(calls.ask).toHaveBeenCalledTimes(1);
        expect(changes).toEqual([]);

        await act(async () => { answer('member'); });
        await settle();
        expect(changes).toEqual([true]);
        expect(byId('show-on-global-tick')!.getAttribute('aria-busy')).toBe('false');
    });

    it.each([['member', 'ticks'], ['unknown', 'raises an alert']])('an answer of "%s" landing after the form has closed %s nothing: the next event opens off', async (standing) => {
        const answer = heldAnswer();
        const changes: boolean[] = [];
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: (v: boolean) => changes.push(v) }));
        await press('show-on-global-tick');
        // The sheet closed: the row has gone, and the form behind it, which outlives the sheet, still holds its setter.
        await act(async () => { root?.unmount(); });
        root = null;

        await act(async () => { answer(standing); });
        await settle();
        expect(changes).toEqual([]);
        expect((globalThis as any).__alerts).toHaveLength(0);
    });

    it('a screen reader hears what the tick makes public: the label replaces the row\'s words, so the consent line is the hint', async () => {
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: () => {} }));
        expect(byId('show-on-global-tick')!.getAttribute('data-a11y-hint')).toBe(showOnGlobalHint());
    });
});

describe.each([['light', lightColors], ['dark', darkColors]] as const)('at 320 dp × 1.3, %s', (scheme, colors) => {
    beforeEach(() => {
        theme.colors = colors;
        theme.scheme = scheme;
    });

    it('the tick holds in the width, a target of at least 44 dp', async () => {
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: true, onChange: () => {} }));
        const layout = layOut(byId('floor')!, { width: WIDTH, height: 568 }, { fontScale: 1.3 });
        const box = layout.box(byId('show-on-global-tick')!);
        expect(box.left + box.width).toBeLessThanOrEqual(WIDTH);
        expect(box.height).toBeGreaterThanOrEqual(44);
    });

    it('the door holds in the width, its button at least 48 dp, and it opens the community\'s own card', async () => {
        await draw(createElement(EventCopyDoor, { copy: { from: FROM } }));
        const layout = layOut(byId('floor')!, { width: WIDTH, height: 568 }, { fontScale: 1.3 });
        const button = layout.box(byId('event-copy-ask')!);
        expect(button.left + button.width).toBeLessThanOrEqual(WIDTH);
        expect(button.height).toBeGreaterThanOrEqual(48);
        expect(byId('event-copy-door')!.textContent).toContain(`To go, ask to join ${LONG_NAME}`);
        await press('event-copy-ask');
        expect(world.pushed).toEqual([`/community-card?node=${encodeURIComponent(FROM.url)}`]);
    });
});

describe('the door', () => {
    it('by invite, and with no row: the words, and no button that goes nowhere', async () => {
        await draw(createElement(EventCopyDoor, { copy: { from: { ...FROM, door: 'invite' as const } } }));
        expect(byId('event-copy-door')!.textContent).toContain('It takes new members by invite');
        expect(byId('event-copy-ask')).toBeNull();
        await draw(createElement(EventCopyDoor, { copy: { from: null } }));
        expect(byId('event-copy-ask')).toBeNull();
    });
});
