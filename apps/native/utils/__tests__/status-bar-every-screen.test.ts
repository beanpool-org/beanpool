// @vitest-environment jsdom
/**
 * Every screen's status bar, Light and Dark: one table over every route under app/ (read from the file tree) x theme ->
 * the bar the phone shows on it, held to the page under it: dark icons on a light page, light icons on a dark one.
 *
 * WALK 3 phone (API 26, 320 dp, 17 Nov 2026): in Light the guest chat's clock, status icons and navigation buttons were white
 * on its light page. React Native keeps every mounted StatusBar in one stack, in mount order, the newest winning, and a
 * screen under another stays mounted: the tabs' light bar, made for their dark header, stayed on every screen opened from
 * them that set no bar of its own (44 screens). The tabs now set it with components/ScreenStatusBar.tsx, which counts only
 * while the tabs can be seen (utils/screen-showing.ts), so such a screen reads the root layout's bar, by theme. The four
 * whose camera fills the screen, black under the bar in every theme, had the right bar only by that accident: each now
 * sets a light one while its camera shows.
 *
 * How a row is resolved, as the phone does it:
 * - each route's own bars are read from its file and from the app's own files it imports (a screen whose bar is drawn by a
 *   component it renders, chat/[id] -> GroupChatView), and the root layout's and each group layout's bars from theirs;
 * - those bars are then mounted in the phone's order, the root layout's first, then the tabs (the app opens on them), then
 *   the screen opened over them (a tab is drawn inside the tabs), the bar components the files name: React Native's own
 *   stack rules (below) for a plain StatusBar, the real ScreenStatusBar, under the real StackRouter's state, for that;
 * - the bar on top is the row's answer; then the screen is closed and the tabs' own light bar must be back on top.
 * A screen is taken as opened from the tabs, as nearly every one is. One opened from a screen with its own bar keeps that
 * screen's bar when it sets none (a door screen's light one: not modelled; the door screens are in the exceptions below).
 * What a row can't see: the colour actually drawn under the bar (a page's own colours are tested elsewhere), and an iOS
 * sheet's look. Web has no status bar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StackActions, StackRouter } from '@react-navigation/routers';
import { SEE_THROUGH_SCREENS } from '../screen-showing';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * React Native 0.83's status bar stack (Libraries/Components/StatusBar/StatusBar.js): an entry pushed when a StatusBar
 * mounts (pushStackEntry), replaced where it stands when it updates (replaceStackEntry), taken out when it unmounts
 * (popStackEntry); the props are merged oldest to newest, so the newest entry's barStyle is the phone's (mergePropsStack).
 * expo-status-bar's StatusBar is that component with its style as a barStyle (styleToBarStyle): 'light' -> light icons,
 * 'dark' -> dark icons; 'auto' follows the PHONE's scheme, not the drawn theme, so a row gets no answer from it.
 */
const bars = vi.hoisted(() => {
    const b = {
        stack: [] as Array<{ barStyle: string }>,
        /** The bar the phone shows: the stack's top as last sent to it. StatusBar._updatePropsStack sends it on a setImmediate,
         *  a microtask in bridgeless React Native, after the change that asked for it. */
        native: 'none',
        /** The bar each Modal's dialog copied from the phone as it opened (ReactModalHostView.updateSystemAppearance). */
        copied: [] as string[],
        changed() { queueMicrotask(() => { b.native = b.stack.at(-1)?.barStyle ?? 'none'; }); },
    };
    return b;
});
vi.mock('expo-status-bar', async () => {
    const React = await import('react');
    const barStyleOf = (style: string | undefined) => (style === 'light' ? 'light-content' : style === 'dark' ? 'dark-content' : `no answer (${style ?? 'auto'})`);
    class StatusBar extends React.Component<{ style?: string }> {
        entry = { barStyle: '' };
        componentDidMount() { this.entry = { barStyle: barStyleOf(this.props.style) }; bars.stack.push(this.entry); bars.changed(); }
        componentDidUpdate() {
            const at = bars.stack.indexOf(this.entry);
            this.entry = { barStyle: barStyleOf(this.props.style) };
            if (at >= 0) bars.stack[at] = this.entry;
            bars.changed();
        }
        componentWillUnmount() { const at = bars.stack.indexOf(this.entry); if (at >= 0) bars.stack.splice(at, 1); bars.changed(); }
        render() { return null; }
    }
    return { StatusBar };
});

/** A screen's route, as the navigator that holds it provides it; and that navigator's state (the root stack's here). */
const nav = vi.hoisted(() => ({ state: null as any, RouteCtx: null as any }));
vi.mock('@react-navigation/native', async () => {
    const React = await import('react');
    nav.RouteCtx = React.createContext<{ key: string; name: string } | null>(null);
    return {
        useRoute: () => React.useContext(nav.RouteCtx),
        useNavigationState: (select: (state: unknown) => unknown) => select(nav.state),
    };
});

/**
 * React Native's own StatusBar stack calls (pushStackEntry / popStackEntry, the same stack as above), and its Modal on Android
 * with edge-to-edge: a dialog window of its own, drawn under the status bar, that copies the phone's light/dark bar once,
 * as it opens (ReactModalHostView.showOrUpdate -> updateSystemAppearance, React Native 0.83), and never reads it again.
 */
vi.mock('react-native', async () => {
    const React = await import('react');
    const StatusBar = {
        pushStackEntry(props: { barStyle: string }) { const entry = { barStyle: props.barStyle }; bars.stack.push(entry); bars.changed(); return entry; },
        popStackEntry(entry: { barStyle: string }) { const at = bars.stack.indexOf(entry); if (at >= 0) bars.stack.splice(at, 1); bars.changed(); },
    };
    function Modal({ visible = true, children }: { visible?: boolean; children?: React.ReactNode }) {
        const open = React.useRef(false);
        // The dialog is shown as the commit that makes it visible is mounted; its window copies the bar the phone has then.
        React.useLayoutEffect(() => {
            if (visible && !open.current) bars.copied.push(bars.native);
            open.current = visible;
        });
        return visible ? React.createElement('section', null, children) : null;
    }
    return { Modal, StatusBar };
});

import { StatusBar } from 'expo-status-bar';
import { Modal as NativeModal } from 'react-native';
import { ScreenStatusBar } from '../../components/ScreenStatusBar';
import { LightBarModal } from '../../components/LightBarModal';

const NATIVE = path.resolve(__dirname, '../..');
const APP = path.join(NATIVE, 'app');
const read = (file: string) => fs.readFileSync(file, 'utf8');

type Theme = 'light' | 'dark';
type Style = 'light' | 'dark';
/** A bar as a file names it: the component, and its style per theme ('themed': dark icons on Light, light on dark). */
type Bar = { component: 'StatusBar' | 'ScreenStatusBar'; kind: 'light' | 'dark' | 'themed' | string; file: string };

// ---------------------------------------------------------------------------------------------------------------------------
// The routes, from the file tree: every file under app/ that draws a screen (a default export, its own or another route's),
// not a layout (_layout) and not a special file (+native-intent).
// ---------------------------------------------------------------------------------------------------------------------------
function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) return d.name === '__tests__' ? [] : walk(full);
        return /\.tsx?$/.test(d.name) ? [full] : [];
    });
}
const drawsAScreen = (src: string) => /export default\b|export\s*\{\s*default\b/.test(src);
const ROUTE_FILES = walk(APP).filter((f) => {
    const base = path.basename(f).replace(/\.tsx?$/, '');
    return !base.startsWith('_') && !base.startsWith('+') && drawsAScreen(read(f));
});
const routeId = (file: string) => path.relative(APP, file).replace(/\.tsx?$/, '').split(path.sep).join('/');
/** The root stack's route a file is drawn under: a group's routes are drawn inside the group's own layout ('(tabs)'). */
const GROUP_LAYOUTS = walk(APP).filter((f) => /\/_layout\.tsx$/.test(f) && path.dirname(f) !== APP);
const groupOf = (file: string) => GROUP_LAYOUTS.find((l) => file.startsWith(path.dirname(l) + path.sep));

// ---------------------------------------------------------------------------------------------------------------------------
// The bars a file names, its own and those of the app's files it imports (app/ and components/, followed through).
// ---------------------------------------------------------------------------------------------------------------------------
function styleKind(attrs: string, src: string): string {
    const style = /style=(\{[^}]*\}|"[^"]*"|'[^']*')/.exec(attrs)?.[1];
    if (!style) return 'auto';
    if (style === '"light"' || style === "'light'") return 'light';
    if (style === '"dark"' || style === "'dark'") return 'dark';
    const flat = style.replace(/\s+/g, ' ');
    if (/^\{ ?theme === 'dark' \? 'light' : 'dark' ?\}$/.test(flat)) return 'themed';
    // The onboarding screens' `dark` is the drawn theme's (ThemeContext useOnboardingColors).
    if (/^\{ ?dark \? 'light' : 'dark' ?\}$/.test(flat) && /\{[^}]*\bdark\b[^}]*\} = useOnboardingColors\(\)/.test(src)) return 'themed';
    return `unread: ${flat}`;
}
function barsNamedIn(file: string): Bar[] {
    const src = read(file);
    return [...src.matchAll(/<(ScreenStatusBar|StatusBar)\b([^>]*?)\/>/g)].map((m) => ({
        component: m[1] as Bar['component'], kind: styleKind(m[2], src), file: path.relative(NATIVE, file),
    }));
}
function resolveImport(from: string, spec: string): string | null {
    const base = path.resolve(path.dirname(from), spec);
    for (const f of [base, `${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
        if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    }
    return null;
}
function barsOf(file: string, seen = new Set<string>()): Bar[] {
    if (seen.has(file)) return [];
    seen.add(file);
    const found = barsNamedIn(file);
    for (const m of read(file).matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
        const next = resolveImport(file, m[1]);
        const inApp = next && (next.startsWith(APP + path.sep) || next.startsWith(path.join(NATIVE, 'components') + path.sep));
        // A layout's bars are its own rows' (below); ScreenStatusBar's own StatusBar is the bar the importing file names.
        if (next && inApp && !/\/_layout\.tsx$/.test(next) && path.basename(next) !== 'ScreenStatusBar.tsx') found.push(...barsOf(next, seen));
    }
    return found;
}
/** One bar per distinct component + kind: a screen that names its bar in several branches (Welcome's steps) shows one. */
function distinct(list: Bar[]): Bar[] {
    const out = new Map<string, Bar>();
    for (const b of list) out.set(`${b.component}:${b.kind}`, out.get(`${b.component}:${b.kind}`) ?? b);
    return [...out.values()];
}
const styleFor = (kind: string, theme: Theme): Style | undefined =>
    kind === 'light' || kind === 'dark' ? kind : kind === 'themed' ? (theme === 'dark' ? 'light' : 'dark') : undefined;

// ---------------------------------------------------------------------------------------------------------------------------
// What each row must read. Every screen: dark icons on Light, light icons on the dark themes, as its page is drawn. The
// deliberate exceptions, light in both themes, each with why.
// ---------------------------------------------------------------------------------------------------------------------------
const DOOR = "a door screen: it sets its own light bar, on purpose, for its charcoal header (not this class, which is screens that set none: the screens it opens set their own, and peek's post takes peek's place; how it reads in Light is an owed-walk row)";
const CAMERA = "a camera screen: its scanner fills the screen under the bar, black in every theme, and it sets a light bar only while the camera (or its black wait) shows; its asks before the camera read the root layout's, by theme (this row is the camera's)";
const LIGHT_IN_BOTH_THEMES: Record<string, string> = {
    '(tabs)': "every tab sits under GlobalHeader's dark green band, in both themes ((tabs)/_layout.tsx)",
    'new-listing': "see-through (utils/screen-showing.ts SEE_THROUGH_SCREENS): its sheet sits low over the screen that opened it, and from the tabs the bar is over their dark band",
    'confirm-new-phone': CAMERA,
    'pair-device': CAMERA,
    'settings-signin': CAMERA,
    'unlock-keys': CAMERA,
    'community-card': DOOR,
    'find-community': DOOR,
    'join-global': DOOR,
    'join-open-door': DOOR,
    'peek': DOOR,
    'shared-outside': DOOR,
    'start-community': DOOR,
    'ways-back': DOOR,
    'your-area': DOOR,
};
const exceptionFor = (id: string) => (id.startsWith('(tabs)/') ? '(tabs)' : id in LIGHT_IN_BOTH_THEMES ? id : null);
const wanted = (id: string, theme: Theme) => (exceptionFor(id) || theme === 'dark' ? 'light-content' : 'dark-content');

// ---------------------------------------------------------------------------------------------------------------------------
// Mounting a row: the root layout's bar, the tabs' (under the root stack's '(tabs)' route), the screen's.
// ---------------------------------------------------------------------------------------------------------------------------
const ROOT_BARS = distinct(barsNamedIn(path.join(APP, '_layout.tsx')));
const TABS_LAYOUT = path.join(APP, '(tabs)', '_layout.tsx');
const layoutBars = (layout: string) => distinct(barsNamedIn(layout));
const ROUTES = ROUTE_FILES.map((file) => ({ id: routeId(file), file, group: groupOf(file), own: distinct(barsOf(file)) }));

const rootNames = ['(tabs)', ...ROUTES.filter((r) => !r.group).map((r) => r.id)];
const router = StackRouter({});
const config = { routeNames: rootNames, routeParamList: {}, routeGetIdList: {} } as any;
const opened = () => router.getInitialState(config);
/** The real StackRouter's next state; a push or pop it refuses is a broken row, never a silent pass. */
function stepped(state: any, action: ReturnType<typeof StackActions.push> | ReturnType<typeof StackActions.pop>): any {
    const next = router.getStateForAction(state, action as any, config);
    if (!next) throw new Error(`the stack refused ${action.type}`);
    return next;
}
const push = (state: any, name: string) => stepped(state, StackActions.push(name));
const pop = (state: any) => stepped(state, StackActions.pop());

function drawBars(list: Bar[], theme: Theme, route: { key: string; name: string }, keyPrefix: string): ReactElement {
    return h(nav.RouteCtx.Provider, { key: keyPrefix, value: route }, ...list.map((b, i) => {
        const style = styleFor(b.kind, theme) as Style;
        return b.component === 'ScreenStatusBar' ? h(ScreenStatusBar, { key: i, style }) : h(StatusBar, { key: i, style });
    }));
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    host = null;
    root = null;
    bars.stack = [];
    bars.native = 'none';
    bars.copied = [];
});
const top = () => bars.stack.at(-1)?.barStyle ?? 'none';

/** The bar the phone shows on `route` in `theme`, opened from the tabs; and the bar back on the tabs once it is closed. */
function resolve(route: (typeof ROUTES)[number], theme: Theme): { on: string; back: string } {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const start = opened();
    const tabsRoute = start.routes[0];
    const tree = (state: any, screen: ReactElement | null) => {
        nav.state = state;
        return h('div', {},
            drawBars(ROOT_BARS, theme, { key: 'root', name: 'root' }, 'root'),
            drawBars(layoutBars(TABS_LAYOUT), theme, tabsRoute, 'tabs'),
            screen);
    };
    if (route.group) {
        // A tab: drawn inside the tabs, under its own route in their navigator.
        act(() => root!.render(tree(start, drawBars(route.own, theme, { key: `tab-${route.id}`, name: route.id }, 'screen'))));
        const on = top();
        return { on, back: on };
    }
    act(() => root!.render(tree(start, null)));
    const over = push(start, route.id);
    const screenRoute = over.routes[over.index];
    act(() => root!.render(tree(over, drawBars(route.own, theme, screenRoute, 'screen'))));
    const on = top();
    act(() => root!.render(tree(pop(over), null)));
    return { on, back: top() };
}

describe('the routes, from the file tree', () => {
    it('finds the app\'s screens (a guard on the walk itself, not the list): the ones the walk named among them', () => {
        const ids = ROUTES.map((r) => r.id);
        expect(ids.length).toBeGreaterThan(70);
        for (const named of ['guest-chat/[id]', 'outside-chat/[id]', 'new-message', 'contacts', 'forum/[id]', 'forum/new', 'forum/first-looks', 'chat/[id]', 'group/[id]', '(tabs)/chats']) {
            expect(ids).toContain(named);
        }
    });

    it('the one group layout is the tabs\': a new one needs this table taught where its screens sit', () => {
        expect(GROUP_LAYOUTS.map((l) => path.relative(APP, l))).toEqual([path.relative(APP, TABS_LAYOUT)]);
    });

    it('every bar in the app is one a row can read: a fixed light or dark, or by the drawn theme', () => {
        const unread = [...ROOT_BARS, ...GROUP_LAYOUTS.flatMap(layoutBars), ...ROUTES.flatMap((r) => r.own)]
            .filter((b) => !['light', 'dark', 'themed'].includes(b.kind))
            .map((b) => `${b.file}: <${b.component} style ${b.kind}>`);
        expect(unread).toEqual([]);
    });

    it('the root layout sets one bar by the drawn theme, under every screen', () => {
        expect(ROOT_BARS.map((b) => `${b.component}:${b.kind}`)).toEqual(['StatusBar:themed']);
    });

    it('every exception names a route that exists, and every see-through screen in the root stack is one', () => {
        const ids = ROUTES.map((r) => r.id);
        for (const key of Object.keys(LIGHT_IN_BOTH_THEMES)) {
            expect({ key, found: key === '(tabs)' ? ids.some((i) => i.startsWith('(tabs)/')) : ids.includes(key) }).toEqual({ key, found: true });
        }
        const layout = read(path.join(APP, '_layout.tsx'));
        const seeThrough = [...layout.matchAll(/<Stack\.Screen\s+name="([^"]+)"\s+options=\{\{[^]*?\}\}\s*\/>/g)]
            .filter((m) => /presentation: '(transparentModal|containedTransparentModal)'/.test(m[0]))
            .map((m) => m[1]);
        expect(seeThrough.sort()).toEqual([...SEE_THROUGH_SCREENS].sort());
        for (const name of SEE_THROUGH_SCREENS) expect(LIGHT_IN_BOTH_THEMES[name]).toBeTruthy();
    });
});

describe.each(['light', 'dark'] as const)('every screen\'s status bar in %s', (theme) => {
    it.each(ROUTES.map((r) => [r.id, r] as const))('%s', (id, route) => {
        const { on, back } = resolve(route, theme);
        const want = wanted(id, theme);
        expect({ screen: id, theme, bar: on }).toEqual({ screen: id, theme, bar: want });
        // Closed again: the tabs' own light bar is back on top, over the root layout's.
        expect({ screen: id, theme, backOnTheTabs: back }).toEqual({ screen: id, theme, backOnTheTabs: 'light-content' });
    });
});

// ---------------------------------------------------------------------------------------------------------------------------
// A Modal whose content is dark in every theme: a camera scanner, a full-size photo on near-black. On Android its dialog
// copies the phone's bar as it opens, so the screen's bar (by theme: dark icons on Light) would show dark icons on black,
// and a StatusBar mounted inside it comes too late (its flush follows the copy). components/LightBarModal.tsx puts a light
// entry on first and opens the dialog after it has reached the phone. (Review of #3274: rekey-code, claim-community, and
// ScanCodeModal's "known consequence"; the class, found from the files below.)
// ---------------------------------------------------------------------------------------------------------------------------
const SCANNER = 'a camera scanner, full screen: black around and under the camera in every theme';
const PHOTO = "a full-size photo on the image viewer's near-black, in every theme";
const DARK_MODALS: Record<string, string> = {
    'app/rekey-code.tsx': `${SCANNER} (Scan the admin's code)`,
    'app/claim-community.tsx': `${SCANNER} (Scan the claim code)`,
    'app/names-list.tsx': `${SCANNER} (check another admin's key in person)`,
    'components/ScanCodeModal.tsx': `${SCANNER} (Find a community, address card, pair-in, Welcome, a group's guests)`,
    'components/chat/ChatPhoto.tsx': `${PHOTO} (a DM's or the guest chat's photo)`,
    'app/chat/[id].tsx': `${PHOTO} (a group chat's photo)`,
    'components/MemberAvatar.tsx': `${PHOTO} (a member's own photo, tapped)`,
    'components/PhotoFocusAdjust.tsx': `${PHOTO}, under the scrim (a post's photo, choosing what its card shows: the post form and edit)`,
};

/** Every RN-style Modal block in the app's files: its tag (Modal, or LightBarModal), its opening tag and what it holds. */
type ModalBlock = { file: string; tag: 'Modal' | 'LightBarModal'; line: number; opening: string; body: string; src: string };
function modalBlocks(): ModalBlock[] {
    const files = [...walk(APP), ...walk(path.join(NATIVE, 'components'))].filter((f) => f.endsWith('.tsx'));
    return files.flatMap((full) => {
        const src = read(full);
        const file = path.relative(NATIVE, full).split(path.sep).join('/');
        return [...src.matchAll(/<(Modal|LightBarModal)\b/g)].flatMap((m): ModalBlock[] => {
            const tag = m[1] as ModalBlock['tag'];
            const close = src.indexOf(`</${tag}>`, m.index!);
            if (close < 0) return []; // self-closing: nothing drawn in it
            const body = src.slice(m.index!, close);
            const opening = body.slice(0, body.search(/>\s*\n/) + 1);
            return [{ file, tag, line: src.slice(0, m.index!).split('\n').length, opening, body, src }];
        });
    });
}
/** A ground dark in every theme: black, a near-black (85% or more), or the image viewer's token. A dim behind a sheet is less. */
const DARK_GROUND = /backgroundColor:\s*(?:'(?:#000|#000000|black)'|'rgba\(0,\s*0,\s*0,\s*0?\.(?:8[5-9]|9)\d*\)'|colors\.overlay\.imageViewerBg)/;
function holdsDark(block: ModalBlock): boolean {
    if (/<CameraView\b/.test(block.body) || DARK_GROUND.test(block.body)) return true;
    return [...block.body.matchAll(/\bstyles\.(\w+)/g)].some((m) => {
        const def = new RegExp(`\\b${m[1]}:\\s*\\{([^{}]*)\\}`).exec(block.src);
        return !!def && DARK_GROUND.test(def[1]);
    });
}
const BLOCKS = modalBlocks();
const DARK_BLOCKS = BLOCKS.filter(holdsDark);

/** Microtasks (the stack's flush) and a timer tick (LightBarModal's open) run out, as the phone's next frame would. */
const settle = () => act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
});

/**
 * A dark Modal opened over a screen that reads the root layout's bar (by theme), then closed: the bar its dialog copied as it
 * opened, and the phone's bar once it has closed. A Modal drawn with `visible` alone opens as its opener mounts it (ScanCodeModal,
 * the photo viewers); one with `visible={…}` opens and closes on that.
 */
async function openAndClose(block: Pick<ModalBlock, 'tag' | 'opening'>, theme: Theme, inside?: ReactElement) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const Drawn: any = block.tag === 'LightBarModal' ? LightBarModal : NativeModal;
    const byMount = /\bvisible(?=[\s>])/.test(block.opening) && !/\bvisible=/.test(block.opening);
    const modal = (open: boolean) => (byMount
        ? (open ? h(Drawn, { key: 'modal', visible: true }, h('p', null, 'camera'), inside) : null)
        : h(Drawn, { key: 'modal', visible: open }, h('p', null, 'camera'), inside));
    const tree = (open: boolean) => h('div', {}, drawBars(ROOT_BARS, theme, { key: 'root', name: 'root' }, 'root'), modal(open));
    await act(async () => root!.render(tree(false)));
    await settle();
    const before = bars.native;
    await act(async () => root!.render(tree(true)));
    await settle();
    const atOpen = bars.copied.length ? bars.copied.at(-1)! : 'never opened';
    await act(async () => root!.render(tree(false)));
    await settle();
    return { before, atOpen, afterClose: bars.native, entries: bars.stack.length };
}

describe('a Modal dark in every theme shows light icons, and gives the screen\'s bar back', () => {
    it('finds the app\'s dark Modals from the files (a guard on the search): exactly the listed ones, each once', () => {
        expect(BLOCKS.length).toBeGreaterThan(60);
        expect(DARK_BLOCKS.map((b) => b.file).sort()).toEqual(Object.keys(DARK_MODALS).sort());
    });

    it('each one is drawn with LightBarModal; no other Modal is', () => {
        expect(DARK_BLOCKS.filter((b) => b.tag !== 'LightBarModal').map((b) => `${b.file}:${b.line} <${b.tag}>`)).toEqual([]);
        expect(BLOCKS.filter((b) => b.tag === 'LightBarModal' && !holdsDark(b)).map((b) => `${b.file}:${b.line}`)).toEqual([]);
    });

    it('the model can fail: a StatusBar mounted inside a plain Modal is too late, the dialog has copied the screen\'s bar', async () => {
        const { atOpen } = await openAndClose({ tag: 'Modal', opening: '<Modal visible={open}>' }, 'light', h(StatusBar, { key: 'own', style: 'light' }));
        expect(atOpen).toBe('dark-content');
    });

    describe.each(['light', 'dark'] as const)('in %s', (theme) => {
        it.each(Object.keys(DARK_MODALS).map((file) => [file] as const))('%s', async (file) => {
            const block = DARK_BLOCKS.find((b) => b.file === file);
            expect({ file, found: !!block }).toEqual({ file, found: true });
            const themed = theme === 'dark' ? 'light-content' : 'dark-content';
            const { before, atOpen, afterClose, entries } = await openAndClose(block!, theme);
            expect({ file, theme, before }).toEqual({ file, theme, before: themed });
            // Open: light icons over the dark content, in both themes.
            expect({ file, theme, atOpen }).toEqual({ file, theme, atOpen: 'light-content' });
            // Closed: the screen's own bar again, and nothing left on the stack.
            expect({ file, theme, afterClose, entries }).toEqual({ file, theme, afterClose: themed, entries: ROOT_BARS.length });
        });
    });
});
