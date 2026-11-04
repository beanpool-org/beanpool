// @vitest-environment jsdom
/**
 * Copy on request (Profile S4): the card Settings opens from "Use this name and photo in another community".
 *
 * The real card, with its real copy helper and the real pending-profile-sync on a recorded AsyncStorage, rendered in jsdom with
 * React Native's host components as plain tags (styles kept as a data attribute so the 320 dp checks can read them). The
 * point of the card is that nothing moves until the tap: opening it, picking a community and ticking boxes write nothing,
 * and the tap keeps exactly what was ticked for the community that was picked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const flat = (style: unknown): Record<string, unknown> =>
    (Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean).reduce((all: Record<string, unknown>, s: any) => ({ ...all, ...s }), {});

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', checkbox: 'checkbox', radio: 'radio' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, accessibilityState, disabled, style } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState && 'checked' in accessibilityState) attrs['aria-checked'] = String(!!accessibilityState.checked);
        if (accessibilityState && 'selected' in accessibilityState) attrs['aria-selected'] = String(!!accessibilityState.selected);
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        if (style) attrs['data-style'] = JSON.stringify(flat(style));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }, '…'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        // The floor of the audience's phones: 320 dp wide, the system font at 130 % (Marty).
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});

// `gate.guestMarks`, when set, holds the read of the guest marks (nodes.ts GUEST_KEY) until the test lets it go.
const mem = vi.hoisted(() => ({ store: new Map<string, string>(), writes: [] as string[], gate: { guestMarks: null as null | Promise<void> } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => {
            if (k === 'beanpool_guest_nodes' && mem.gate.guestMarks) await mem.gate.guestMarks;
            return mem.store.get(k) ?? null;
        }),
        setItem: vi.fn(async (k: string, v: string) => { mem.writes.push(k); mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
    },
}));
const scheme = vi.hoisted(() => ({ theme: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ colors: scheme.theme === 'dark' ? darkColors : lightColors, theme: scheme.theme }),
        useStyles: (f: (t: unknown) => unknown) => f({ colors: scheme.theme === 'dark' ? darkColors : lightColors, theme: scheme.theme }),
    };
});
// Shows which picture it is given, so the summary of the member's own photo can be read.
vi.mock('../../components/MemberAvatar', () => ({
    MemberAvatar: ({ avatarUrl, size }: { avatarUrl?: string | null; size?: number }) => createElement('span', { 'data-avatar': avatarUrl ?? '', 'data-size': String(size ?? '') }),
}));
// The phone's communities, as the BeanPool sheet reads them: this one, others, a guest visit, one that does not answer.
const communities = vi.hoisted(() => ({
    active: 'https://first.example.test' as string | null,
    rows: [] as Array<{ url: string; name: string; status: 'checking' | 'online' | 'guest' | 'offline' }>,
}));
vi.mock('../use-communities', () => ({ useCommunities: () => ({ active: communities.active, rows: communities.rows }) }));
const dbRow = vi.hoisted(() => ({ row: null as null | Record<string, unknown> }));
vi.mock('../db', () => ({ getMemberProfile: vi.fn(async () => dbRow.row) }));

import { CopyProfileCard } from '../../components/CopyProfileCard';
import { lightColors, darkColors } from '../../constants/colors';
import { PENDING_PROFILE_STORE_PREFIX } from '../storage-keys';

const KEY = 'a'.repeat(64);
const FIRST = 'https://first.example.test';
const SECOND = 'https://second.example.test';
const THIRD = 'https://third.example.test';
const GUEST = 'https://guest.example.test';
const DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const NODE_THUMB = `/api/avatar/${KEY}?size=thumb&v=e3733e23&k=abc123`;

let host: HTMLElement | null = null;
let root: Root | null = null;
let fetched: string[] = [];

beforeEach(() => {
    mem.store.clear();
    mem.writes = [];
    mem.gate.guestMarks = null;
    mem.store.set('beanpool_anchor_url', FIRST);
    communities.active = FIRST;
    communities.rows = [
        { url: FIRST, name: 'First Beans', status: 'online' },
        { url: SECOND, name: 'Second Beans', status: 'online' },
        { url: THIRD, name: 'Third Beans', status: 'offline' },
        { url: GUEST, name: 'Guest Beans', status: 'guest' },
    ];
    dbRow.row = { public_key: KEY, callsign: 'Rosa', avatar_url: DATA };
    scheme.theme = 'light';
    fetched = [];
    (globalThis as any).fetch = vi.fn(async (url: string) => {
        fetched.push(url);
        return {
            ok: true, status: 200, headers: { get: () => 'image/jpeg' },
            blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }),
        };
    });
});
afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    host = null;
    root = null;
});

async function settle(rounds = 6) {
    for (let i = 0; i < rounds; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
async function render() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(CopyProfileCard as any, { publicKey: KEY }) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}
const text = () => document.body.textContent ?? '';
const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function press(el: HTMLElement | null) {
    if (!el) throw new Error('nothing to press');
    await act(async () => { el.click(); });
    await settle();
}
const go = () => byId('copy-profile-go')!;
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}') as Record<string, any>;
const entryOf = (community: string) => {
    const raw = mem.store.get(`${PENDING_PROFILE_STORE_PREFIX}${community}`);
    return raw ? JSON.parse(raw) : undefined;
};

describe('nothing moves until the tap', () => {
    it('opening the card shows the member\'s own name and photo here, with both boxes ticked, and writes and fetches nothing', async () => {
        await render();
        expect(text()).toContain('This is your name and photo in First Beans.');
        expect(document.querySelector('[data-size="48"]')!.getAttribute('data-avatar')).toBe(DATA);
        expect(byId('copy-profile-name')!.getAttribute('aria-checked')).toBe('true');
        expect(byId('copy-profile-photo')!.getAttribute('aria-checked')).toBe('true');
        expect(byId('copy-profile-name')!.textContent).toContain('Name: Rosa');
        expect(mem.writes).toEqual([]);
        expect(fetched).toEqual([]);
    });

    it('the button waits for a community: nothing is picked for the member', async () => {
        await render();
        expect(go().getAttribute('aria-disabled')).toBe('true');
        expect(go().getAttribute('aria-label')).toBe('Pick a community to copy to');
        await press(go());
        expect(mem.writes).toEqual([]);
    });

    it('lists the communities that hold the member, not the one it is made from and not a guest visit', async () => {
        await render();
        expect(byId(`copy-profile-to-${SECOND}`)).not.toBeNull();
        expect(byId(`copy-profile-to-${THIRD}`)).not.toBeNull();
        expect(byId(`copy-profile-to-${FIRST}`)).toBeNull();
        expect(byId(`copy-profile-to-${GUEST}`)).toBeNull();
        // One that does not answer is still a place a copy can wait for, and says so.
        expect(byId(`copy-profile-to-${THIRD}`)!.textContent).toContain('Not reachable right now. The copy waits until you open it.');
    });

    it('picking a community and ticking or unticking boxes write nothing and fetch nothing', async () => {
        dbRow.row = { public_key: KEY, callsign: 'Rosa', avatar_url: NODE_THUMB };
        await render();
        await press(byId(`copy-profile-to-${SECOND}`));
        await press(byId('copy-profile-photo'));
        await press(byId('copy-profile-photo'));
        await press(byId('copy-profile-name'));
        await press(byId('copy-profile-name'));
        await press(byId(`copy-profile-to-${THIRD}`));
        expect(byId(`copy-profile-to-${THIRD}`)!.getAttribute('aria-checked')).toBe('true');
        expect(mem.writes).toEqual([]);
        expect(fetched).toEqual([]);
    });

    it('the button names exactly what goes and where, as the boxes change', async () => {
        await render();
        await press(byId(`copy-profile-to-${SECOND}`));
        expect(go().getAttribute('aria-label')).toBe('Copy name and photo to Second Beans');
        await press(byId('copy-profile-photo'));
        expect(go().getAttribute('aria-label')).toBe('Copy name to Second Beans');
        await press(byId('copy-profile-photo'));
        await press(byId('copy-profile-name'));
        expect(go().getAttribute('aria-label')).toBe('Copy photo to Second Beans');
        await press(byId('copy-profile-photo'));
        expect(go().getAttribute('aria-label')).toBe('Tick the name or the photo');
        expect(go().getAttribute('aria-disabled')).toBe('true');
        await press(go());
        expect(mem.writes).toEqual([]);
    });
});

describe('the tap keeps exactly what was ticked, for the community that was picked', () => {
    it('name and photo to the second community: kept there as a copy, and the card says it waits', async () => {
        await render();
        await press(byId(`copy-profile-to-${SECOND}`));
        await press(go());
        expect(entryOf(SECOND)).toEqual({ publicKey: KEY, callsign: 'Rosa', avatar: DATA, chosenOnly: true });
        expect(mem.writes).toEqual([`${PENDING_PROFILE_STORE_PREFIX}${SECOND}`]);
        expect(byId('copy-profile-said')!.textContent).toBe('Your name and photo will go to Second Beans the next time you open it.');
        // Kept, not sent: no request left the phone for it.
        expect(fetched).toEqual([]);
    });

    it('only the name ticked: the name alone is kept', async () => {
        await render();
        await press(byId(`copy-profile-to-${THIRD}`));
        await press(byId('copy-profile-photo'));
        await press(go());
        expect(entryOf(THIRD)).toEqual({ publicKey: KEY, callsign: 'Rosa', chosenOnly: true });
        expect(entryOf(SECOND)).toBeUndefined();
        expect(byId('copy-profile-said')!.textContent).toBe('Your name will go to Third Beans the next time you open it.');
    });

    it('only the photo ticked: the photo alone is kept', async () => {
        await render();
        await press(byId(`copy-profile-to-${SECOND}`));
        await press(byId('copy-profile-name'));
        await press(go());
        expect(entryOf(SECOND)).toEqual({ publicKey: KEY, avatar: DATA, chosenOnly: true });
        expect(byId('copy-profile-said')!.textContent).toBe('Your photo will go to Second Beans the next time you open it.');
    });

    it('the community\'s own picture is fetched, from the community it is here, only at the tap', async () => {
        dbRow.row = { public_key: KEY, callsign: 'Rosa', avatar_url: NODE_THUMB };
        await render();
        await press(byId(`copy-profile-to-${SECOND}`));
        expect(fetched).toEqual([]);
        await press(go());
        expect(fetched).toEqual([`${FIRST}/api/avatar/${KEY}?v=e3733e23&k=abc123`]);
        expect(entryOf(SECOND)!.avatar).toBe('data:image/jpeg;base64,AQIDBA==');
    });

    it('a photo that cannot be had keeps nothing, not even the name, and says so', async () => {
        dbRow.row = { public_key: KEY, callsign: 'Rosa', avatar_url: NODE_THUMB };
        (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); });
        await render();
        await press(byId(`copy-profile-to-${SECOND}`));
        await press(go());
        expect(mem.writes).toEqual([]);
        expect(byId('copy-profile-said')!.textContent).toContain("The photo couldn't be read just now, so nothing was copied.");
        // Unticking the photo lets the name through.
        await press(byId('copy-profile-photo'));
        await press(go());
        expect(entryOf(SECOND)).toEqual({ publicKey: KEY, callsign: 'Rosa', chosenOnly: true });
    });

    it('with no photo of its own here, the photo box is off and says why; the name still copies', async () => {
        dbRow.row = { public_key: KEY, callsign: 'Rosa', avatar_url: null };
        await render();
        const photo = byId('copy-profile-photo')!;
        expect(photo.getAttribute('aria-disabled')).toBe('true');
        expect(photo.getAttribute('aria-checked')).toBe('false');
        expect(text()).toContain('The ready-made picture is not a photo you chose, so it is not copied.');
        await press(byId(`copy-profile-to-${SECOND}`));
        expect(go().getAttribute('aria-label')).toBe('Copy name to Second Beans');
        await press(go());
        expect(entryOf(SECOND)).toEqual({ publicKey: KEY, callsign: 'Rosa', chosenOnly: true });
    });

    it('copies to the next community when asked again, and each tap keeps only for its own', async () => {
        await render();
        await press(byId(`copy-profile-to-${SECOND}`));
        await press(byId('copy-profile-photo'));
        await press(go());
        await press(byId(`copy-profile-to-${THIRD}`));
        expect(byId('copy-profile-said')).toBeNull();
        await press(byId('copy-profile-photo'));
        await press(byId('copy-profile-name'));
        await press(go());
        expect(entryOf(SECOND)).toEqual({ publicKey: KEY, callsign: 'Rosa', chosenOnly: true });
        expect(entryOf(THIRD)).toEqual({ publicKey: KEY, avatar: DATA, chosenOnly: true });
    });

    it('with no other community on the phone it says so, and offers nothing to tap', async () => {
        communities.rows = [{ url: FIRST, name: 'First Beans', status: 'online' }, { url: GUEST, name: 'Guest Beans', status: 'guest' }];
        await render();
        expect(text()).toContain('You have not joined another community on this phone yet.');
        expect(go().getAttribute('aria-disabled')).toBe('true');
    });
});

describe('a community visited only as a guest is never offered, whatever its status says', () => {
    // utils/nodes.ts markGuestNode: the mark a member leaves by choosing to look around a community they are not in.
    const markAsGuest = (...urls: string[]) => mem.store.set('beanpool_guest_nodes', JSON.stringify(urls));
    const GUEST_DOWN = 'https://guest-down.example.test';
    const GUEST_CHECKING = 'https://guest-checking.example.test';

    it('a guest community that does not answer (offline) is not a place to copy to: nothing would ever arrive there', async () => {
        markAsGuest(GUEST_DOWN);
        communities.rows = [
            { url: FIRST, name: 'First Beans', status: 'online' },
            { url: SECOND, name: 'Second Beans', status: 'online' },
            { url: GUEST_DOWN, name: 'Guest Down Beans', status: 'offline' },
        ];
        await render();
        expect(byId(`copy-profile-to-${SECOND}`)).not.toBeNull();
        expect(byId(`copy-profile-to-${GUEST_DOWN}`)).toBeNull();
        expect(text()).not.toContain('Guest Down Beans');
    });

    it('a guest community still being checked is not offered either', async () => {
        markAsGuest(GUEST_CHECKING);
        communities.rows = [
            { url: FIRST, name: 'First Beans', status: 'online' },
            { url: GUEST_CHECKING, name: 'Guest Checking Beans', status: 'checking' },
        ];
        await render();
        expect(byId(`copy-profile-to-${GUEST_CHECKING}`)).toBeNull();
        expect(text()).toContain('You have not joined another community on this phone yet.');
    });

    it('a guest community the check has called a member of nowhere (status guest) is still left out', async () => {
        markAsGuest(GUEST);
        await render();
        expect(byId(`copy-profile-to-${GUEST}`)).toBeNull();
    });

    it('a saved community with no guest mark that does not answer is still offered, with its waiting line', async () => {
        markAsGuest(GUEST_DOWN);
        await render();
        expect(byId(`copy-profile-to-${THIRD}`)).not.toBeNull();
        expect(byId(`copy-profile-to-${THIRD}`)!.textContent).toContain('Not reachable right now. The copy waits until you open it.');
    });

    it('while the guest marks are still being read nothing is offered, so a guest community cannot be picked in that moment; then the rest appear', async () => {
        markAsGuest(GUEST_DOWN);
        communities.rows = [
            { url: FIRST, name: 'First Beans', status: 'online' },
            { url: SECOND, name: 'Second Beans', status: 'online' },
            { url: GUEST_DOWN, name: 'Guest Down Beans', status: 'offline' },
        ];
        let release!: () => void;
        mem.gate.guestMarks = new Promise<void>((r) => { release = r; });
        await render();
        expect(byId(`copy-profile-to-${GUEST_DOWN}`)).toBeNull();
        expect(byId(`copy-profile-to-${SECOND}`)).toBeNull();
        // Not "you have not joined another community": the answer is not in yet.
        expect(text()).not.toContain('You have not joined another community on this phone yet.');
        await act(async () => { release(); });
        await settle();
        expect(byId(`copy-profile-to-${SECOND}`)).not.toBeNull();
        expect(byId(`copy-profile-to-${GUEST_DOWN}`)).toBeNull();
    });

    it('a tap on the one community left keeps its copy; nothing is kept for the guest one', async () => {
        markAsGuest(GUEST_DOWN);
        communities.rows = [
            { url: FIRST, name: 'First Beans', status: 'online' },
            { url: SECOND, name: 'Second Beans', status: 'online' },
            { url: GUEST_DOWN, name: 'Guest Down Beans', status: 'offline' },
        ];
        await render();
        await press(byId(`copy-profile-to-${SECOND}`));
        await press(go());
        expect(entryOf(SECOND)).toEqual({ publicKey: KEY, callsign: 'Rosa', avatar: DATA, chosenOnly: true });
        expect(entryOf(GUEST_DOWN)).toBeUndefined();
    });
});

describe('the card at 320 dp with the system font at 130 %, in light and in dark', () => {
    const lum = (hex: string) => {
        const h = hex.replace('#', '');
        const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
    };

    for (const theme of ['light', 'dark'] as const) {
        it(`${theme}: words wrap beside boxes that keep their size, every row is a full touch target, and every colour is a token that reads`, async () => {
            scheme.theme = theme;
            const colors = theme === 'dark' ? darkColors : lightColors;
            // The longest names a community and a member have: they must wrap inside the card, not push a box off the edge.
            communities.rows = [
                { url: FIRST, name: 'First Beans', status: 'online' },
                { url: SECOND, name: 'The Mullumbimby Neighbours Bean Exchange', status: 'offline' },
            ];
            dbRow.row = { public_key: KEY, callsign: 'Rosalind-Maria-Fernanda', avatar_url: DATA };
            await render();
            await press(byId(`copy-profile-to-${SECOND}`));

            // The tick rows: a full touch target, the words flexing beside a 24 dp box that never shrinks.
            for (const id of ['copy-profile-name', 'copy-profile-photo']) {
                const row = byId(id)!;
                expect(styleOf(row).flexDirection).toBe('row');
                expect(styleOf(row).minHeight).toBeGreaterThanOrEqual(48);
                const words = Array.from(row.querySelectorAll('span')).find(s => (s.textContent ?? '').length > 2)!;
                expect(styleOf(words).flex).toBe(1);
                expect(styleOf(words).flexShrink).toBe(1);
                expect(styleOf(words).color).toBe(colors.text.body);
                const box = Array.from(row.querySelectorAll('div')).find(d => styleOf(d).width === 24)!;
                expect(styleOf(box).height).toBe(24);
                expect(styleOf(box).flexShrink).toBe(0);
                expect(styleOf(box).backgroundColor).toBe(colors.brand.fill);
                expect(styleOf(box).borderColor).toBe(colors.brand.primary);
                const mark = Array.from(box.querySelectorAll('span')).find(s => s.textContent === '✓')!;
                expect(styleOf(mark).color).toBe(colors.text.onBrand);
            }

            // The community rows: a full touch target, the name wrapping beside a radio that keeps its size.
            const row = byId(`copy-profile-to-${SECOND}`)!;
            expect(styleOf(row).minHeight).toBeGreaterThanOrEqual(48);
            expect(row.getAttribute('aria-checked')).toBe('true');
            const rowName = Array.from(row.querySelectorAll('span')).find(s => s.textContent === 'The Mullumbimby Neighbours Bean Exchange')!;
            expect(styleOf(rowName).flex).toBe(1);
            expect(styleOf(rowName).flexShrink).toBe(1);
            const radio = Array.from(row.querySelectorAll('div')).find(d => styleOf(d).width === 22)!;
            expect(styleOf(radio).flexShrink).toBe(0);
            // 320 - 2 x 20 (screen padding) - 2 x 20 (card padding) = 240 dp; the row's padding (12 + 12), the radio (22) and its gap (10)
            // leave the name 184 dp, and a tick row's box (24) and gap (10) leave its words 206 dp: each wraps inside.
            expect(240 - 24 - 22 - 10).toBe(184);
            expect(240 - 24 - 10).toBe(206);

            // The member's own name wraps beside its picture, which keeps its size.
            const mine = document.querySelector('[data-size="48"]')!.parentElement!;
            expect(styleOf(mine).flexDirection).toBe('row');
            const mineName = Array.from(mine.querySelectorAll('span')).find(s => s.textContent === 'Rosalind-Maria-Fernanda')!;
            expect(styleOf(mineName).flexShrink).toBe(1);

            // The action: full width, a full touch target, the inverse ink on the brand fill.
            const action = styleOf(go());
            expect(action.minHeight).toBeGreaterThanOrEqual(48);
            expect(action.backgroundColor).toBe(colors.brand.fill);
            expect(action.alignSelf).toBeUndefined();
            expect(styleOf(go().querySelector('span'))).toMatchObject({ color: colors.text.onBrand, textAlign: 'center' });

            // Readable from the tokens, against the card the card draws them on (4.5:1 for words, 3:1 for a control's outline).
            expect(ratio(colors.text.body, colors.surface.card)).toBeGreaterThanOrEqual(4.5);
            expect(ratio(colors.text.heading, colors.surface.card)).toBeGreaterThanOrEqual(4.5);
            expect(ratio(colors.text.secondary, colors.surface.card)).toBeGreaterThanOrEqual(4.5);
            expect(ratio(colors.text.secondary, colors.surface.card)).toBeGreaterThanOrEqual(3); // an unticked box and an unpicked radio
            expect(ratio(colors.text.onBrand, colors.brand.fill)).toBeGreaterThanOrEqual(4.5);
            expect(ratio(colors.brand.primary, colors.surface.card)).toBeGreaterThanOrEqual(3); // a ticked box's outline
            expect(ratio(colors.brand.primary, colors.surface.subtle)).toBeGreaterThanOrEqual(3); // the picked row's border and dot
            expect(styleOf(row).borderColor).toBe(colors.brand.primary);
            expect(styleOf(radio.firstElementChild).backgroundColor).toBe(colors.brand.primary);
            expect(ratio(colors.text.heading, colors.surface.subtle)).toBeGreaterThanOrEqual(4.5); // the picked row's name
            expect(ratio(colors.text.secondary, colors.surface.subtle)).toBeGreaterThanOrEqual(4.5); // the disabled button's words
            expect(ratio(colors.feedback.danger.fg, colors.surface.card)).toBeGreaterThanOrEqual(4.5);
        });
    }
});
