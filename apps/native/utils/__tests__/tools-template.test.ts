// @vitest-environment jsdom
/**
 * The tool template's generic tests on the phone (scratch/tools/DESIGN-tool-template-fable.md §1.5 (c), (e) and §6 row
 * T0.2), run for every tool the phone registers and, while it registers none, for two tools registered here only: the
 * scaffold scripts/tools/new-tool.mjs writes (its core and phone halves, under a new id), and a fixture tool that uses
 * every primitive of tools/ui.tsx and the doors, the reminders and the List sheet.
 *
 * Each is drawn for real through the one host route (app/tool/[id].tsx) and the frame, with its document in a real SQLite
 * table (node:sqlite behind the expo-sqlite calls tools/store.ts makes) and its photos in a real folder, at 320 dp with
 * 1.3× text in the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed): no letters outside a
 * bracket but what members wrote, and every fixed word under the 258 dp inside of a card (home-layout-320.test.ts's width
 * model). And: the host a tool is given has no function its manifest didn't declare (absent at runtime; a type error at
 * build, held by @ts-expect-error below); a tool, a screen or a permission this build doesn't have shows "This tool isn't
 * in this version of the app" with Update, never a crash; due() becomes date-trigger notifications and nothing else; the
 * composer's draft is the map's own shape; and the account leaving the phone leaves no row and no file.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SCREEN = 320;
const FONT_SCALE = 1.3;
const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => void }> }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', radiogroup: 'radiogroup' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, numberOfLines, horizontal, value, onChangeText, disabled, onValueChange } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onValueChange) attrs.onClick = () => onValueChange(!value);
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (horizontal) attrs['data-horizontal'] = 'true';
        const s = flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        if (typeof s.width === 'number') attrs['data-width'] = String(s.width);
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), Switch: el('button'), ActivityIndicator: el('div'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => void }>) => { alerts.said.push(title); if (body) alerts.said.push(body); alerts.buttons = buttons ?? []; } },
        Linking: { openURL: async () => {} },
        AccessibilityInfo: { announceForAccessibility: () => {} },
        useWindowDimensions: () => ({ width: SCREEN, height: 569, scale: 1.5, fontScale: FONT_SCALE }),
        Dimensions: { get: () => ({ width: SCREEN, height: 569, scale: 1.5, fontScale: FONT_SCALE }) },
    };
});
// Each drawn route keeps the params it opened with (as a stack screen does); setParams changes the last one drawn.
const nav = vi.hoisted(() => ({
    params: {} as Record<string, string>, pushed: [] as unknown[], navigated: [] as unknown[], replaced: [] as unknown[], backs: 0, canGoBack: true,
    setTop: null as null | ((next: Record<string, string | undefined>) => void),
}));
vi.mock('expo-router', async () => {
    const { useEffect: effect, useState: state } = await import('react');
    return {
        router: {
            push: (r: unknown) => { nav.pushed.push(r); }, navigate: (r: unknown) => { nav.navigated.push(r); }, replace: (r: unknown) => { nav.replaced.push(r); },
            back: () => { nav.backs++; }, canGoBack: () => nav.canGoBack, setParams: (p: Record<string, string | undefined>) => { nav.setTop?.(p); },
        },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useLocalSearchParams: () => {
            const [p, set] = state<Record<string, string | undefined>>(() => ({ ...nav.params }));
            nav.setTop = (next) => set((was) => ({ ...was, ...next }));
            return p;
        },
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.map.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.map.set(k, v); },
        removeItem: async (k: string) => { store.map.delete(k); },
        getAllKeys: async () => [...store.map.keys()],
        multiRemove: async (keys: string[]) => { keys.forEach((k) => store.map.delete(k)); },
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
    // The keyboard is the device's: the stand-in draws its rows and says how it was asked to keep them above it.
    KeyboardAwareScrollView: ({ children, testID, bottomOffset, keyboardShouldPersistTaps }: Record<string, any>) => createElement('div',
        { 'data-testid': testID, 'data-keyboard-aware': 'true', 'data-bottom-offset': String(bottomOffset ?? 0), 'data-persist-taps': keyboardShouldPersistTaps }, children),
}));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: vi.fn(), launchCameraAsync: vi.fn(), requestCameraPermissionsAsync: vi.fn() }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: vi.fn(), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'photo-ref' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: 'light', colors: lightColors }), useStyles: (make: (t: unknown) => unknown) => make({ theme: 'light', colors: lightColors }) };
});
const ME = { publicKey: 'me-key', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
const node = vi.hoisted(() => ({ profile: { profile: 'local', features: { beans: true } } as { profile: string; features: Record<string, unknown> } }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => node.profile }));
vi.mock('../market-global', () => ({ composerNeedsProfilePhoto: async () => true }));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: async () => null }));

// The one store, for real: tool_docs in SQLite (node:sqlite behind expo-sqlite's calls) and photos in a real folder.
const disk = vi.hoisted(() => ({ dir: '', db: null as any }));
const posts = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), paused: [] as string[], resumed: [] as string[], deals: [] as Array<Record<string, unknown>> }));
/**
 * The community's server, for a tool that asks for node-copy (slice T0.4): its tool store as engine/tool-state.ts keeps
 * it, the member's own copies only (the signer is ME). Today's node (S2) unless `sendsDeletedAt` (S2.1) or `refusesOff`
 * (S2.2: a DELETE leaves a tombstone with no copy too, and an ordinary PUT over a removed copy is 410, nothing written);
 * 404 when `older`, no answer when `down`. `seen` is what the phone holds as each request arrives; `before` runs as
 * a request arrives, before the server reads it (another phone's landing first).
 */
const server = vi.hoisted(() => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const s = {
        rows: new Map<string, { doc: unknown; updatedAt: string }>(),
        tombs: new Map<string, string>(),
        log: [] as Array<{ method: string; path: string; body?: unknown; held?: number }>,
        mode: 'up' as 'up' | 'down' | 'older',
        sendsDeletedAt: false,
        refusesOff: false,
        clock: Date.parse('2026-10-21T08:00:00.000Z'),
        seen: null as null | (() => number),
        before: null as null | ((method: string) => void),
        /** The `max` its answers say it keeps of a tool's document; none: today's fake, which says none. */
        max: undefined as number | undefined,
        reset() {
            s.rows.clear(); s.tombs.clear(); s.log.length = 0; s.mode = 'up'; s.sendsDeletedAt = false; s.refusesOff = false; s.seen = null; s.before = null;
            s.clock = Date.parse('2026-10-21T08:00:00.000Z');
            s.max = undefined;
        },
        answer(method: string, path: string, body?: unknown): { status: number; json: unknown } | null {
            s.before?.(method);
            s.log.push({ method, path, body, held: s.seen?.() });
            if (s.mode === 'down') return null;
            const m = /^\/api\/tools\/([a-z0-9-]+)$/.exec(path);
            if (s.mode === 'older' || !m) return { status: 404, json: null };
            const tool = m[1];
            const row = s.rows.get(tool);
            const now = (s.clock += 1000);
            if (method === 'GET') return { status: 200, json: { tool, doc: row?.doc ?? null, updatedAt: row?.updatedAt ?? null, ...(s.sendsDeletedAt || s.refusesOff ? { deletedAt: row ? null : s.tombs.get(tool) ?? null } : {}), ...(s.max ? { max: s.max } : {}) } };
            if (method === 'PUT') {
                if (s.refusesOff && (body as { turnOn?: unknown }).turnOn !== true && !row && s.tombs.has(tool)) {
                    return { status: 410, json: { error: "This tool's copy was switched off, so nothing was kept. Switch it on again in Settings to keep one.", code: 'tool_copy_off', deletedAt: s.tombs.get(tool) } };
                }
                const updatedAt = iso(Math.max(now, ...[row?.updatedAt, s.tombs.get(tool)].filter(Boolean).map((t) => Date.parse(t as string) + 1)));
                s.rows.set(tool, { doc: (body as { doc: unknown }).doc, updatedAt });
                return { status: 200, json: { success: true, tool, updatedAt } };
            }
            if (row || s.refusesOff) { s.rows.delete(tool); s.tombs.set(tool, iso(now)); }
            return { status: 200, json: { success: true, tool, removed: !!row } };
        },
    };
    return s;
});
vi.mock('../db', () => ({
    getDb: async () => disk.db,
    getMemberProfile: async () => ({ avatar_url: null }),
    getPost: async (id: string) => posts.rows.get(id) ?? null,
    getMyPosts: async (pubkey: string) => [...posts.rows.values()].filter((p) => p.author_pubkey === pubkey),
    getMarketplaceTransactions: async (pubkey: string) => posts.deals.filter((d) => d.sellerPublicKey === pubkey || d.buyerPublicKey === pubkey),
    pausePost: async (id: string) => { posts.paused.push(id); },
    resumePost: async (id: string) => { posts.resumed.push(id); },
    // The app's signed helpers, as the node copy calls them (tools/node-copy.ts), the member's deals as the node answers
    // the phone's `deals` (tools/builder.ts): theirs, `limit` rows from `offset`; and one listing by its id, as the node
    // answers the phone's `posts` (its author's paused one too).
    signedGet: async (path: string) => {
        const url = new URL(path, 'https://mullum.example');
        if (url.pathname === '/api/marketplace/posts') {
            const row = posts.rows.get(url.searchParams.get('id') ?? '');
            return { ok: true, status: 200, json: async () => (row ? [{ ...row, authorPublicKey: row.author_pubkey }] : []) };
        }
        if (url.pathname === '/api/marketplace/transactions') {
            const who = url.searchParams.get('publicKey');
            const offset = Number(url.searchParams.get('offset') ?? 0);
            const rows = posts.deals.filter((d) => d.sellerPublicKey === who || d.buyerPublicKey === who).slice(offset, offset + Number(url.searchParams.get('limit') ?? 50));
            return { ok: true, status: 200, json: async () => rows };
        }
        const a = server.answer('GET', path);
        if (!a) throw new TypeError('Network request failed');
        return { status: a.status, json: async () => a.json };
    },
    signedRequestWithMethod: async (method: string, path: string, payload?: unknown, opts?: { withStatus?: boolean }) => {
        const a = server.answer(method, path, payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)));
        if (!a) throw new TypeError('Network request failed');
        if (a.status >= 300) throw Object.assign(new Error(`Request failed: ${a.status}`), opts?.withStatus ? { status: a.status, unsaid: true } : {});
        return a.json;
    },
}));
vi.mock('expo-file-system/legacy', async () => {
    const nfs = await import('node:fs');
    const p = (uri: string) => decodeURI(uri.replace(/^file:\/\//, ''));
    return {
        get documentDirectory() { return `file://${disk.dir}/`; },
        makeDirectoryAsync: async (uri: string) => { nfs.mkdirSync(p(uri), { recursive: true }); },
        copyAsync: async ({ from, to }: { from: string; to: string }) => { nfs.copyFileSync(p(from), p(to)); },
        deleteAsync: async (uri: string) => { nfs.rmSync(p(uri), { recursive: true, force: true }); },
        readAsStringAsync: async (uri: string) => nfs.readFileSync(p(uri)).toString('base64'),
    };
});

// The registry: this build's own tools, and the two registered here (test-only: nothing ships them).
const reg = vi.hoisted(() => ({ extra: [] as Array<{ manifest: any; app: any }> }));
vi.mock('../../tools/index', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../tools/index')>();
    // A registered tool's screens thunk is require('./screens'): Metro bundles it, and vitest can't load a .tsx through
    // Node's own require. Here each one's screens module is imported instead, the same module its thunk names.
    const nodePath = await import('node:path');
    const nodeFs = await import('node:fs');
    const { pathToFileURL: fileUrl } = await import('node:url');
    const apps: Record<string, any> = {};
    for (const [id, app] of Object.entries(real.TOOL_APPS)) {
        const file = ['screens.tsx', 'screens.ts'].map((f) => nodePath.resolve(__dirname, '../../tools', id, f)).find((f) => nodeFs.existsSync(f));
        const mod = file ? await import(/* @vite-ignore */ fileUrl(file).href) : null;
        apps[id] = mod ? { ...app, screens: () => mod.SCREENS } : app;
    }
    const all = () => [...real.phoneTools(apps), ...reg.extra];
    return {
        ...real,
        TOOL_APPS: apps,
        phoneTools: () => all(),
        phoneTool: (id: string) => all().find((t) => t.manifest.id === id) ?? null,
        toolHomeCardIds: () => real.toolHomeCardIds(all()),
        toolOfHomeCard: (type: string) => real.toolOfHomeCard(type, all()),
    };
});

const nodeCopyQueues = vi.hoisted(() => [] as Array<{ pending: () => string[]; cancelAll: () => void }>);
vi.mock('@beanpool/core', async (importOriginal) => {
    const real = await importOriginal<typeof import('@beanpool/core')>();
    return {
        ...real,
        createToolCopyQueue: (delayMs?: number, alone?: any) => {
            const q = real.createToolCopyQueue(delayMs, alone);
            const pendingKeys = new Set<string>();
            const origLater = q.later.bind(q);
            const origCancel = q.cancel.bind(q);
            q.later = (key: string, job: () => Promise<unknown>) => {
                pendingKeys.add(key);
                origLater(key, async () => {
                    pendingKeys.delete(key);
                    return job();
                });
            };
            q.cancel = (key: string) => {
                pendingKeys.delete(key);
                origCancel(key);
            };
            nodeCopyQueues.push({
                pending: () => [...pendingKeys].filter((k) => q.waiting(k)),
                cancelAll: () => {
                    for (const k of [...pendingKeys]) q.cancel(k);
                    pendingKeys.clear();
                },
            });
            return q;
        },
    };
});

import { DatabaseSync } from 'node:sqlite';
import {
    TOOLS, pseudoLocalise, setLanguage, toolFixtureProblems, toolHomeCardType, toolManifestProblems, word,
    type ToolFixtures, type ToolManifest, type ToolScreenProps,
} from '@beanpool/core';
import { TOOL_APPS, phoneTools, type PhoneTool } from '../../tools/index';
import { TOOL_DOCS_TABLE, TOOL_SETTINGS_PREFIX } from '../../tools/schema';
import {
    readToolDoc, wipeToolDataOnThisPhone, writeToolDoc, writeToolSettings, ToolDocTooBigError,
    removeToolDataHere, removeCommunityToolData, readToolSettings, reminderOn, settingsKey, type ToolSettings,
} from '../../tools/store';
import { communityKey } from '../../tools/community';
import { keepToolPhoto, toolPhotoUri } from '../../tools/photos';
import { hostFor, phoneHost, ungrantedPermissions, type PhoneHostContext } from '../../tools/builder';
import { composerDraft, openNeedComposer, OFFER_DRAFT_KEY } from '../../tools/doors';
import { decideDraftOpen } from '../compose-options';
import { remindersToSchedule, scheduleToolReminders, toolReminderRoute, cancelToolReminders, TOOL_REMINDER_CHANNEL } from '../../tools/reminders';
import { ToolButton, ToolButtons, ToolChips, ToolEmpty, ToolField, ToolNote, ToolRow, ToolScreen, ToolSection } from '../../tools/ui';
import { ToolHomeBody, afterModal, backupLine } from '../../tools/frame';
import { keepsNodeCopy } from '../../tools/node-copy';
import { lightColors } from '../../constants/colors';
import { HOME_DRAWN } from '../home-cards';
import ToolRoute from '../../app/tool/[id]';
import ToolsScreen from '../../app/tools';

const NATIVE = path.resolve(__dirname, '../..');
const REPO = path.resolve(NATIVE, '../..');
const CORE_TOOLS = path.join(REPO, 'packages/beanpool-core/src/tools');
// Inside the package (vite loads sources only from under its root), in a dot folder no include pattern reaches; removed
// after the file's tests.
const tmp = fs.mkdtempSync(path.join(NATIVE, '.tools-template-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** expo-sqlite's calls, answered by a real SQLite database in memory. */
function sqliteDb() {
    const d = new DatabaseSync(':memory:');
    const bind = (params?: unknown[]) => (params ?? []) as any[];
    return {
        execAsync: async (sql: string) => { d.exec(sql); },
        runAsync: async (sql: string, params?: unknown[]) => { const r = d.prepare(sql).run(...bind(params)); return { changes: Number(r.changes) }; },
        getFirstAsync: async (sql: string, params?: unknown[]) => d.prepare(sql).get(...bind(params)) ?? null,
        getAllAsync: async (sql: string, params?: unknown[]) => d.prepare(sql).all(...bind(params)),
        count: (sql: string) => Number((d.prepare(sql).get() as { n: number }).n),
    };
}

// ── The two tools registered here ────────────────────────────────────────────────────────────────────────────────

/**
 * The scaffold as new-tool.mjs writes it, under `id`: its core half (manifest, document, fixtures) and its phone half
 * (screens), written outside the tree with their imports of core pointed at core's sources (core's own
 * tools-template.test.ts does the same).
 */
async function scaffoldTool(id: string): Promise<{ tool: PhoneTool; fixtures: ToolFixtures<any> }> {
    const { scaffoldFiles } = await import(/* @vite-ignore */ pathToFileURL(path.join(REPO, 'scripts/tools/registry.mjs')).href);
    const files = scaffoldFiles(id) as Array<{ part: string; rel: string; text: string }>;
    const root = path.join(tmp, 'scaffold');
    for (const f of files.filter((x) => (x.part === 'core' || x.part === 'native') && !x.rel.includes('__tests__'))) {
        const dest = path.join(root, f.part, f.rel);
        const fromDir = path.dirname(path.join(CORE_TOOLS, f.rel));
        const virtual = path.join(CORE_TOOLS, id);
        const text = f.part !== 'core' ? f.text : f.text.replace(/(from\s+)(['"])(\.[^'"]+)\2/g, (whole, from, q, spec) => {
            const target = path.resolve(fromDir, spec);
            if (!path.relative(virtual, target).startsWith('..')) return whole;
            return `${from}${q}${target.replace(/\.js$/, '.ts')}${q}`;
        });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, text);
    }
    const core: Record<string, unknown> = await import(pathToFileURL(path.join(root, 'core', id, 'index.ts')).href);
    const { FIXTURES } = await import(pathToFileURL(path.join(root, 'core', id, 'fixtures.ts')).href);
    const screens = await import(pathToFileURL(path.join(root, 'native', id, 'screens.tsx')).href);
    const manifest = Object.values(core).find((v: any) => v && typeof v === 'object' && v.id === id && v.doc) as ToolManifest;
    return { tool: { manifest, app: { id, screens: () => screens.SCREENS } }, fixtures: FIXTURES };
}

/** A tool made for these tests: every primitive, both doors, a Home card, a reminder, a photo and the List sheet. */
type KitDoc = { v: number; items: Array<{ id: string; name: string; at: number }> };
const KIT_PERMISSIONS = ['photos', 'offer-door', 'reminders', 'node-copy'] as const;
type KitProps = ToolScreenProps<KitDoc, (typeof KIT_PERMISSIONS)[number]>;
const readKit = (raw: unknown): KitDoc => {
    const r = raw as Partial<KitDoc> | null;
    if (!r || typeof r !== 'object' || typeof r.v !== 'number') return { v: 1, items: [] };
    return { ...r, v: r.v, items: Array.isArray(r.items) ? r.items.filter((i) => i && typeof i.name === 'string') : [] } as KitDoc;
};
const NOW = Date.parse('2026-10-20T09:00:00.000Z');
const DAY = 86_400_000;
const KIT: ToolManifest<KitDoc> = {
    id: 'fixture-kit', name: word('Fixture kit'), line: word('Everything a tool can draw, for the tests.'), icon: '🧪',
    shelf: 'stock', categories: 'all', owner: 'member', permissions: KIT_PERMISSIONS,
    doc: { version: 1, empty: () => ({ v: 1, items: [] }), read: readKit, maxBytes: 2_000 },
    screens: ['main', 'item'],
    row: (d) => ({ key: word('{count} kept here'), values: { count: d.items.length } }),
    examples: [word('a drill'), word('a ladder'), word('a tent')], guide: 'lending-and-borrowing',
    homeCard: { line: word('What your kit keeps.'), lines: (d) => d.items.slice(0, 2).map((i) => ({ key: word('Kept: {name}'), values: { name: i.name }, screen: 'item' })) },
    reminders: {
        list: [{ id: 'back', name: word('When something is due back'), defaultOn: true }, { id: 'weekly', name: word('A weekly note'), defaultOn: false }],
        due: (d, now) => d.items.flatMap((i) => [
            { reminder: 'back', at: i.at, key: word('{name} is due back today'), values: { name: i.name }, screen: 'item' },
            { reminder: 'weekly', at: now + 7 * DAY, key: word('Your weekly note'), values: {} as Record<string, string> },
        ]).slice(0, 10),
    },
};
function KitMain({ host }: KitProps) {
    const doc = host.doc.get();
    return createElement(ToolScreen, { testID: 'kit-main' } as any,
        createElement(ToolSection, { title: 'Things you keep', testID: 'kit-section' } as any,
            doc.items.length === 0
                ? createElement(ToolEmpty, { icon: '🧰', text: 'Nothing here yet. Add the first thing you would lend.' } as any)
                : doc.items.map((i) => createElement(ToolRow, { key: i.id, icon: '🔧', title: i.name, state: 'On the shelf', onPress: () => host.navigate('item', { key: i.id }) } as any))),
        createElement(ToolSection, { title: 'Details' } as any,
            createElement(ToolField, { label: 'Condition', value: 'Good' } as any),
            createElement(ToolChips, { label: 'Show', value: 'all', onPick: () => {}, options: [{ value: 'all', label: 'All' }, { value: 'shelf', label: 'On the shelf' }, { value: 'out', label: 'Out' }] } as any),
            createElement(ToolNote, { text: 'Only you see this list.' } as any),
            createElement(ToolButtons, null,
                createElement(ToolButton, { text: 'Add a thing', primary: true, onPress: () => {}, testID: 'kit-add' } as any),
                createElement(ToolButton, { text: 'List it', onPress: () => host.offerDoor({ title: doc.items[0]?.name ?? 'Thing', description: 'Back within a week.', photos: ['p1'] }), testID: 'kit-list' } as any))));
}
function KitItem({ params }: KitProps) {
    return createElement(ToolScreen, null as any, createElement(ToolRow, { title: 'One thing', state: params.key ?? '' } as any));
}
const kitScreens: Record<string, unknown> = { main: KitMain, item: KitItem };
const kitApp = { id: 'fixture-kit', screens: () => kitScreens };
const kitItems = (n: number, name: (i: number) => string) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: name(i), at: NOW + (i + 1) * DAY }));
const KIT_FIXTURES: ToolFixtures<KitDoc> = {
    stored: [{ name: 'version 1', raw: { v: 1, items: kitItems(1, () => 'Ladder') }, reads: { v: 1, items: kitItems(1, () => 'Ladder') } }],
    docs: { empty: { v: 1, items: [] }, small: { v: 1, items: kitItems(2, (i) => ['Ladder', 'Tent'][i]) }, full: { v: 1, items: kitItems(12, (i) => `Cordless drill ${i}`) } },
    now: NOW,
};

// ── Drawing, and what it checks ──────────────────────────────────────────────────────────────────────────────────

let host: HTMLDivElement;
let root: Root;
/** What members wrote (names in the documents, the draft's words): shown as written, so taken out before the checks. */
let OTHERS: string[] = [];

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://mullum.example');
    disk.dir = fs.mkdtempSync(path.join(tmp, 'disk-'));
    disk.db = sqliteDb();
    disk.db.execAsync(TOOL_DOCS_TABLE);
    nav.params = {};
    nav.pushed.length = 0;
    nav.navigated.length = 0;
    nav.replaced.length = 0;
    nav.backs = 0;
    nav.canGoBack = true;
    alerts.said.length = 0;
    posts.rows.clear();
    posts.paused.length = 0;
    posts.resumed.length = 0;
    posts.deals.length = 0;
    node.profile = { profile: 'local', features: { beans: true } };
    server.reset();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setLanguage('en');
    const pending = nodeCopyQueues.flatMap((q) => q.pending());
    if (pending.length) {
        for (const q of nodeCopyQueues) q.cancelAll();
        expect(pending, 'node-copy queue has pending sync timer at end of test').toEqual([]);
    }
});

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function drawTool(id: string, extra: Record<string, string> = {}, lang: 'xx' | 'en' = 'xx') {
    setLanguage(lang);
    nav.params = { id, ...extra };
    await act(async () => { root.render(createElement(ToolRoute) as any); });
    await settle();
}
const click = async (el: Element | null, what: string) => {
    expect(el, what).not.toBeNull();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

function outsideBrackets(text: string | null | undefined): boolean {
    if (!text) return false;
    let rest = text;
    for (const o of [...OTHERS].sort((a, b) => b.length - a.length)) rest = rest.split(o).join('');
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    return /\p{L}/u.test(rest);
}
/** Every drawn text, label, placeholder and alert that bypassed t(). The test tool's own words are its, so skipped. */
function bypassing(skipTestToolWords = false): string[] {
    const out = new Set<string>();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (skipTestToolWords && n.parentElement?.closest('[data-testid="kit-main"]')) continue;
        const whole = n.parentElement?.textContent ?? n.nodeValue;
        if (outsideBrackets(whole)) out.add(`text: ${JSON.stringify(whole)}`);
    }
    for (const e of Array.from(host.querySelectorAll('[aria-label],[placeholder]'))) {
        if (skipTestToolWords && e.closest('[data-testid="kit-main"]')) continue;
        for (const v of [e.getAttribute('aria-label'), e.getAttribute('placeholder')]) if (outsideBrackets(v)) out.add(`label: ${JSON.stringify(v)}`);
    }
    for (const said of alerts.said) if (outsideBrackets(said)) out.add(`alert: ${JSON.stringify(said)}`);
    return [...out];
}
const bracketed = () => Array.from(host.querySelectorAll('span')).filter((s) => /^\[.*\]$/su.test(s.textContent ?? '')).length;

/** home-layout-320.test.ts's width model: 0.62 em a letter, 1.25 em an emoji, at 1.3× text. */
function textWidth(text: string, fontSize: number): number {
    const px = fontSize * FONT_SCALE;
    return [...text].reduce((w, ch) => w + (/\p{Extended_Pictographic}/u.test(ch) ? 1.25 : 0.62) * px, 0);
}
/** A card's inside at 320 dp: 16 dp gutters, 14 dp padding, its border (home-layout-320.test.ts CARD_INNER). */
const CARD_INNER = SCREEN - 2 * 16 - 2 * 14 - 2 * 1;
/** Each fixed word drawn (members' words taken out) that is wider than a card's inside at 320 dp × 1.3. */
function tooWide(): string[] {
    const out: string[] = [];
    for (const span of Array.from(host.querySelectorAll('span'))) {
        let text = Array.from(span.childNodes).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('');
        for (const o of OTHERS) text = text.split(o).join(' ');
        const font = Number(span.getAttribute('data-font') ?? 15);
        for (const w of text.split(/[\s\u200b]+/u).filter(Boolean)) if (textWidth(w, font) >= CARD_INNER) out.push(`${w} (${Math.round(textWidth(w, font))} dp)`);
    }
    return out;
}

// ── The tests ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the phone's registry", () => {
    it("every phone half is a tool in core's TOOLS, and every screen its manifest names is one its half exports", () => {
        reg.extra = [];
        for (const [id, app] of Object.entries(TOOL_APPS)) {
            expect(app.id, id).toBe(id);
            const manifest = TOOLS.find((t) => t.id === id);
            expect(manifest, `${id} is in core's TOOLS`).toBeTruthy();
            expect(Object.keys(app.screens()).sort(), id).toEqual([...manifest!.screens].sort());
        }
        expect(phoneTools().map((t) => t.manifest.id).sort()).toEqual(Object.keys(TOOL_APPS).sort());
    });

    it("every tool's guide is a page of the members' guide: \"I'm starting out\" never opens one that isn't there", async () => {
        const { loadGuide } = await import(/* @vite-ignore */ pathToFileURL(path.join(REPO, 'packages/beanpool-guide/src/guide.mjs')).href);
        const guide = loadGuide(path.join(REPO, 'packages/beanpool-guide/content'), { version: 1 }) as { sections: Array<{ slugs: string[] }>; guides: Array<{ slug: string }> };
        const slugs = new Set(guide.sections.flatMap((s) => s.slugs));
        expect(slugs.size).toBeGreaterThan(10);
        expect(guide.guides.map((g) => g.slug)).toEqual(expect.arrayContaining([...slugs]));
        for (const m of TOOLS) if (m.guide) expect(slugs.has(m.guide), `${m.id}'s guide page ${m.guide}`).toBe(true);
    });
});

describe('every tool, drawn through the host route at 320 dp × 1.3 in xx', async () => {
    const scaffold = await scaffoldTool('scaffold-check');
    const registered: Array<{ tool: PhoneTool; fixtures: ToolFixtures<any> }> = [
        scaffold,
        { tool: { manifest: KIT, app: kitApp } as PhoneTool, fixtures: KIT_FIXTURES },
    ];
    // This build's own tools, with their fixtures from core (none while the registry is empty).
    for (const t of phoneTools()) {
        const { FIXTURES } = await import(pathToFileURL(path.join(CORE_TOOLS, t.manifest.id, 'fixtures.ts')).href);
        registered.push({ tool: t, fixtures: FIXTURES });
    }
    beforeEach(() => { reg.extra = registered.filter((r) => !TOOL_APPS[r.tool.manifest.id]).map((r) => r.tool); });

    for (const { tool, fixtures } of registered) {
        const id = tool.manifest.id;
        const names = (d: any) => JSON.stringify(d).match(/"name":"([^"]+)"/g)?.map((m) => m.slice(8, -1)) ?? [];

        it(`${id}: its manifest and fixtures pass core's checks`, () => {
            expect(toolManifestProblems(tool.manifest)).toEqual([]);
            expect(toolFixtureProblems(tool.manifest, fixtures)).toEqual([]);
        });

        it(`${id}: with nothing stored, the frame and the two doors; then each door`, async () => {
            OTHERS = [];
            await drawTool(id);
            expect(byTestId('tool-frame')).not.toBeNull();
            expect(byTestId('tool-doors')).not.toBeNull();
            // A tool that asks for node-copy, on a server that keeps copies and has none of it yet: on, by default.
            expect(byTestId('tool-backup-line')?.textContent).toBe(pseudoLocalise(keepsNodeCopy(tool.manifest)
                ? "Kept on this phone, with a private copy on your community's server that only you can read through the app. Like everything on that server, its operator could."
                : 'Kept on this phone only. Nothing in it leaves this phone.'));
            expect(server.log.map((r) => r.method)).toEqual(keepsNodeCopy(tool.manifest) ? ['GET'] : []);
            expect(bracketed()).toBeGreaterThan(4);
            expect(bypassing()).toEqual([]);
            expect(tooWide()).toEqual([]);
            await click(byTestId('tool-door-starting'), "I'm starting out");
            expect(byTestId('tool-examples')).not.toBeNull();
            expect(bypassing(true)).toEqual([]);
            expect(tooWide()).toEqual([]);
            const comm = communityKey(store.map.get('beanpool_anchor_url'));
            expect(JSON.parse(store.map.get(settingsKey(comm, ME.publicKey, id)) ?? '{}').door).toBe('starting');
        });

        for (const which of ['small', 'full'] as const) {
            it(`${id}: its ${which} document — the screen, the row's state line, the menu and Settings`, async () => {
                const doc = fixtures.docs[which];
                OTHERS = names(doc);
                await writeToolDoc(ME.publicKey, tool.manifest, doc, fixtures.now);
                await drawTool(id);
                expect(byTestId('tool-doors')).toBeNull();
                const row = tool.manifest.row(doc, Date.now());
                if (row) expect(byTestId('tool-state')?.getAttribute('data-lines')).toBe('1');
                expect(bypassing(true)).toEqual([]);
                expect(tooWide()).toEqual([]);
                await click(byTestId('tool-menu'), 'the "…"');
                expect(byTestId('tool-menu-sheet')).not.toBeNull();
                await click(byTestId('tool-menu-settings'), 'Settings');
                expect(byTestId('tool-settings-sheet')).not.toBeNull();
                // The toggle and its line only for a tool that asks for node-copy: nothing of any other leaves the phone.
                expect(byTestId('tool-settings-node-copy') !== null, 'the toggle').toBe(keepsNodeCopy(tool.manifest));
                expect(byTestId('tool-settings-node-copy-note') !== null, 'its line').toBe(keepsNodeCopy(tool.manifest));
                expect(bypassing(true)).toEqual([]);
                expect(tooWide()).toEqual([]);
            });
        }

        for (const screen of tool.manifest.screens.slice(1)) {
            it(`${id}: its "${screen}" screen opens by name`, async () => {
                await writeToolDoc(ME.publicKey, tool.manifest, fixtures.docs.small, fixtures.now);
                OTHERS = names(fixtures.docs.small);
                await drawTool(id, { screen, key: 'k1' });
                expect(byTestId('tool-frame')).not.toBeNull();
                expect(byTestId('tool-not-in-version')).toBeNull();
            });
        }
    }

    it('the fixture tool: the List sheet asks the fee, says what happens, and posts nothing; its button writes the map\'s draft', async () => {
        await writeToolDoc(ME.publicKey, KIT, KIT_FIXTURES.docs.small, NOW);
        OTHERS = ['Ladder', 'Tent'];
        await drawTool('fixture-kit');
        await click(byTestId('kit-list'), 'List it');
        expect(byTestId('tool-list-sheet')).not.toBeNull();
        expect(byTestId('tool-list-fee')).not.toBeNull();
        // This community asks for a profile photo, and the member has none: said before going on, and the button waits.
        expect(byTestId('tool-list-photo')).not.toBeNull();
        expect(bypassing(true)).toEqual([]);
        expect(tooWide()).toEqual([]);
        expect(store.map.has(OFFER_DRAFT_KEY)).toBe(false);
        expect(nav.pushed).toEqual([]);
    });

    it('the fixture tool: where Beans are off the fee is not asked', async () => {
        node.profile = { profile: 'global', features: { beans: false } };
        await writeToolDoc(ME.publicKey, KIT, KIT_FIXTURES.docs.small, NOW);
        OTHERS = ['Ladder', 'Tent'];
        await drawTool('fixture-kit');
        await click(byTestId('kit-list'), 'List it');
        expect(byTestId('tool-list-sheet')).not.toBeNull();
        expect(byTestId('tool-list-fee')).toBeNull();
    });

    it('the fixture tool: its Home card is offered once from inside it, and Add sends Home the card to add', async () => {
        await drawTool('fixture-kit');
        await click(byTestId('tool-door-doing'), 'I already do this');
        expect(byTestId('tool-home-offer')).not.toBeNull();
        await click(byTestId('tool-home-add'), 'Add to Home');
        expect(nav.navigated).toEqual([{ pathname: '/(tabs)', params: { addTool: 'fixture-kit' } }]);
        expect(byTestId('tool-home-offer')).toBeNull();
    });

    it("Home draws a tool's card: HOME_DRAWN gains every registered tool with a Home card, and nothing else", async () => {
        // HOME_DRAWN is worked out as utils/home-cards.ts loads: loaded again with the fixture tool registered.
        expect(HOME_DRAWN.has(toolHomeCardType('fixture-kit'))).toBe(false);
        vi.resetModules();
        const again = await import('../home-cards');
        expect(again.HOME_DRAWN.has(toolHomeCardType('fixture-kit'))).toBe(true);
        expect(again.isToolHomeCard('tool-fixture-kit')).toBe(true);
        expect(again.isToolHomeCard('tool-not-here')).toBe(false);
        expect(again.HOME_DRAWN.has(toolHomeCardType('scaffold-check'))).toBe(true);
    });

    it('in English nothing is bracketed', async () => {
        await drawTool('fixture-kit', {}, 'en');
        expect(bracketed()).toBe(0);
        expect(host.textContent).toContain('I already do this');
        expect(host.textContent).toContain("Kept on this phone, with a private copy on your community's server that only you can read through the app.");
    });
});

describe("a tool, a screen or a permission this build doesn't have", () => {
    beforeEach(() => { reg.extra = [{ manifest: KIT, app: kitApp }]; });

    it('an unknown tool id: the update page, never a crash', async () => {
        await drawTool('no-such-tool');
        expect(byTestId('tool-not-in-version')).not.toBeNull();
        expect(host.textContent).toContain(pseudoLocalise("This tool isn't in this version of the app"));
        expect(byTestId('tool-update')).not.toBeNull();
        expect(byTestId('tool-open-settings')).not.toBeNull();
        expect(bypassing()).toEqual([]);
        expect(tooWide()).toEqual([]);
    });

    it('an unknown screen of a tool this build has: the same page', async () => {
        await drawTool('fixture-kit', { screen: 'not-a-screen' });
        expect(byTestId('tool-not-in-version')).not.toBeNull();
    });

    it("a tool that declares a permission this build's host can't grant yet: the same page, not a function missing when called", async () => {
        // `place` (the phone grants `deals` since the Tool shed, T1.2).
        reg.extra = [{ manifest: { ...KIT, id: 'needs-place', permissions: [...KIT.permissions, 'place'] }, app: { ...kitApp, id: 'needs-place' } }];
        await drawTool('needs-place');
        expect(byTestId('tool-not-in-version')).not.toBeNull();
    });

    it('a screen that throws: the frame stays and says what is safe', async () => {
        reg.extra = [{ manifest: { ...KIT, id: 'throws' }, app: { id: 'throws', screens: () => ({ main: () => { throw new Error('boom'); }, item: KitItem }) } }];
        await writeToolDoc(ME.publicKey, { ...KIT, id: 'throws' }, KIT_FIXTURES.docs.small, NOW);
        const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
        await drawTool('throws');
        warn.mockRestore();
        expect(byTestId('tool-frame')).not.toBeNull();
        expect(byTestId('tool-screen-failed')).not.toBeNull();
    });
});

describe('the route around a tool', () => {
    beforeEach(() => { reg.extra = [{ manifest: KIT, app: kitApp }]; });

    it('← Back is the stack\'s, and Home when the tool is the first screen there is (a link or a reminder started the app)', async () => {
        await writeToolDoc(ME.publicKey, KIT, KIT_FIXTURES.docs.small, NOW);
        await drawTool('fixture-kit', {}, 'en');
        await click(byTestId('tool-back'), 'Back');
        expect([nav.backs, nav.replaced]).toEqual([1, []]);
        nav.canGoBack = false;
        await click(byTestId('tool-back'), 'Back');
        expect([nav.backs, nav.replaced]).toEqual([1, ['/(tabs)']]);
    });

    it('the Tools screen\'s ← Back is the same: the stack\'s, and Home when beanpool://tools started the app', async () => {
        setLanguage('en');
        await act(async () => { root.render(createElement(ToolsScreen) as any); });
        await settle();
        await click(byTestId('tools-back'), 'Back');
        expect([nav.backs, nav.replaced]).toEqual([1, []]);
        nav.canGoBack = false;
        await click(byTestId('tools-back'), 'Back');
        expect([nav.backs, nav.replaced]).toEqual([1, ['/(tabs)']]);
    });

    it("a tool's screen keeps the keyboard off what is typed, as the app's other forms do; no tool adds a KeyboardProvider", async () => {
        await writeToolDoc(ME.publicKey, KIT, KIT_FIXTURES.docs.small, NOW);
        await drawTool('fixture-kit', {}, 'en');
        // ToolScreen is react-native-keyboard-controller's KeyboardAwareScrollView (edge-to-edge: the window no longer
        // shrinks for the keyboard), a tap on a button reaches it while the keyboard is up, and a box is scrolled to a
        // gap above the keyboard that fits the first note line under it at 1.3× (ToolInput's: 4 dp over an 18 dp line).
        const screen = byTestId('kit-main')!;
        expect(screen.getAttribute('data-keyboard-aware')).toBe('true');
        expect(screen.getAttribute('data-persist-taps')).toBe('handled');
        expect(Number(screen.getAttribute('data-bottom-offset'))).toBeGreaterThanOrEqual(4 + 18 * FONT_SCALE);
        expect(screen.contains(byTestId('kit-add'))).toBe(true);
        // The root provider (app/_layout.tsx) is the one: a second inside a tool's Modal breaks keyboards app-wide.
        const tools = path.resolve(__dirname, '../../tools');
        const files = (fs.readdirSync(tools, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !f.includes('__tests__'));
        expect(files).toContain('ui.tsx');
        for (const f of files) expect(fs.readFileSync(path.join(tools, f), 'utf8'), f).not.toMatch(/<KeyboardProvider\b/);
    });

    it('the Tools screen opens Your shop (slice S4′), above the shelves, in xx at 320 dp × 1.3', async () => {
        setLanguage('xx');
        OTHERS = [];
        await act(async () => { root.render(createElement(ToolsScreen) as any); });
        await settle();
        expect(byTestId('tools-shop-card')).not.toBeNull();
        expect(bypassing()).toEqual([]);
        expect(tooWide()).toEqual([]);
        await click(byTestId('tools-shop'), 'Your shop');
        expect(nav.pushed).toEqual(['/shop/mine']);
    });

    it('"Remove my data from this phone" on a later screen goes back to the first, where the doors are', async () => {
        await writeToolDoc(ME.publicKey, KIT, KIT_FIXTURES.docs.small, NOW);
        await drawTool('fixture-kit', { screen: 'item', key: 't0' }, 'en');
        expect(host.textContent).toContain('One thing');
        expect(byTestId('tool-doors')).toBeNull();
        await click(byTestId('tool-menu'), 'the "…"');
        await click(byTestId('tool-menu-remove'), 'Remove my data');
        await act(async () => { alerts.buttons.find((b) => b.text === 'Remove')!.onPress!(); });
        await settle();
        expect((await readToolDoc(ME.publicKey, KIT)).stored).toBe(false);
        expect(host.textContent).not.toContain('One thing');
        expect(byTestId('tool-doors')).not.toBeNull();
    });

    it('two open screens of one tool share its document and its settings: neither writes back what the other changed', async () => {
        // A record's screen pushed over the list: each writes, and Settings changes on the pushed one.
        const add = (name: string) => ({ host: h }: KitProps) => createElement(ToolButton, {
            text: 'Add', testID: `add-${name}`, onPress: () => { const d = h.doc.get(); void h.doc.set({ ...d, items: [...d.items, { id: name, name, at: NOW + DAY }] }); },
        } as any);
        const Main = (p: KitProps) => createElement(ToolScreen, null as any, createElement(add('Rake'), p), ...p.host.doc.get().items.map((i) => createElement(ToolRow, { key: i.id, title: i.name } as any)));
        const tool = { ...KIT, id: 'two-screens', permissions: KIT.permissions.filter((p) => p !== 'node-copy') };
        reg.extra = [{ manifest: tool, app: { id: 'two-screens', screens: () => ({ main: Main, item: add('Saw') }) } }];
        await writeToolDoc(ME.publicKey, tool, KIT_FIXTURES.docs.small, NOW);
        await drawTool('two-screens', {}, 'en');
        const over = document.createElement('div');
        document.body.appendChild(over);
        const overRoot = createRoot(over);
        try {
            nav.params = { id: 'two-screens', screen: 'item', key: 't0' };
            await act(async () => { overRoot.render(createElement(ToolRoute) as any); });
            await settle();
            const inOver = (id: string) => over.querySelector(`[data-testid="${id}"]`);
            await click(inOver('add-Saw'), 'Add on the pushed screen');
            expect(host.textContent).toContain('Saw');
            await click(inOver('tool-menu'), 'the "…"');
            await click(inOver('tool-menu-settings'), 'Settings');
            await click(inOver('tool-settings-reminder-back'), 'the reminder\'s switch');
            // Back on the list: its write keeps the pushed screen's, and its Settings the pushed screen's switch.
            await click(byTestId('add-Rake'), 'Add on the list');
            expect((await readToolDoc(ME.publicKey, tool)).doc.items.map((i) => i.name)).toEqual(['Ladder', 'Tent', 'Saw', 'Rake']);
            await click(byTestId('tool-menu'), 'the "…"');
            await click(byTestId('tool-menu-settings'), 'Settings');
            await click(byTestId('tool-settings-reminder-weekly'), 'the other reminder\'s switch');
            const comm = communityKey(store.map.get('beanpool_anchor_url'));
            expect(JSON.parse(store.map.get(settingsKey(comm, ME.publicKey, 'two-screens')) ?? '{}').reminders).toEqual({ back: false, weekly: true });
        } finally {
            act(() => overRoot.unmount());
            over.remove();
        }
    });
});

describe('the host given to a tool has only what its manifest declared', () => {
    const ctx = (manifest: ToolManifest<any>): PhoneHostContext<any> => ({
        manifest, owner: { kind: 'member', publicKey: ME.publicKey, name: ME.callsign }, node: { url: null, profile: 'local', features: null },
        doc: { get: () => manifest.doc.empty(), set: async () => {}, maxBytes: () => 65_536 }, navigate: () => {}, back: () => {}, now: () => NOW, openListSheet: () => {},
    });

    it('a tool with no permissions: the base and nothing else; an undeclared call is undefined', () => {
        const bare: ToolManifest<KitDoc> = { ...KIT, permissions: [] };
        const h = hostFor(bare, ctx(bare)) as unknown as Record<string, unknown>;
        expect(Object.keys(h).sort()).toEqual(['back', 'doc', 'navigate', 'node', 'now', 'owner']);
        expect('offerDoor' in h).toBe(false);
        expect(h.offerDoor).toBeUndefined();
        expect(h.photos).toBeUndefined();
    });

    it('an undeclared call is a type error at build: a screen is typed by its own permissions (tsc runs over this file)', () => {
        const bareScreen = ({ host: h }: ToolScreenProps<KitDoc, never>) => {
            // @ts-expect-error -- `offer-door` not declared, so `offerDoor` is not in the host's type.
            return h.offerDoor;
        };
        const kitScreen = ({ host: h }: KitProps) => {
            // @ts-expect-error -- `posts` not declared by the fixture tool.
            void h.posts;
            return [h.offerDoor, h.photos, h.nodeCopy];
        };
        expect([bareScreen, kitScreen]).toHaveLength(2);
    });

    it('the fixture tool: exactly its grants (reminders grants none)', () => {
        const h = hostFor(KIT, ctx(KIT)) as unknown as Record<string, unknown>;
        expect(Object.keys(h).sort()).toEqual(['back', 'doc', 'navigate', 'node', 'nodeCopy', 'now', 'offerDoor', 'owner', 'photos']);
        expect(h.nodeCopy).toEqual({ on: false });
        expect(h.posts).toBeUndefined();
    });

    it("what this build can't grant yet is named, so its route refuses the tool", () => {
        // `deals` and `pricing-guide` came with the Tool shed (T1.2), the first tool to ask for them.
        expect(ungrantedPermissions({ permissions: ['photos', 'place', 'deals', 'event-door', 'pricing-guide', 'reminders'] }, phoneHost(ctx(KIT)))).toEqual(['place', 'event-door']);
    });

    it("`posts` reaches only the member's own Offers: anyone else's post, or a Need, is 'gone' and can't be paused", async () => {
        posts.rows.set('mine', { id: 'mine', author_pubkey: ME.publicKey, type: 'offer', status: 'active' });
        posts.rows.set('theirs', { id: 'theirs', author_pubkey: 'someone-else', type: 'offer', status: 'paused' });
        posts.rows.set('my-need', { id: 'my-need', author_pubkey: ME.publicKey, type: 'need', status: 'active' });
        const p = phoneHost(ctx(KIT)).posts!;
        expect(await Promise.all(['mine', 'theirs', 'my-need', 'not-here'].map((id) => p.status(id)))).toEqual(['active', 'gone', 'gone', 'gone']);
        await expect(p.pause('theirs')).rejects.toThrow();
        await expect(p.resume('my-need')).rejects.toThrow();
        expect([posts.paused, posts.resumed]).toEqual([[], []]);
        await p.pause('mine');
        await p.resume('mine');
        expect([posts.paused, posts.resumed]).toEqual([['mine'], ['mine']]);
    });

    it("`posts.mine` lists the member's own Offers, live, in a deal or paused: never a Need, a done one, or anyone else's", async () => {
        posts.rows.set('live', { id: 'live', author_pubkey: ME.publicKey, type: 'offer', status: 'active', title: 'Ladder' });
        posts.rows.set('paused', { id: 'paused', author_pubkey: ME.publicKey, type: 'offer', status: 'paused', title: 'Tent' });
        posts.rows.set('done', { id: 'done', author_pubkey: ME.publicKey, type: 'offer', status: 'completed', title: 'Saw' });
        posts.rows.set('need', { id: 'need', author_pubkey: ME.publicKey, type: 'need', status: 'active', title: 'A drill' });
        posts.rows.set('theirs', { id: 'theirs', author_pubkey: 'someone-else', type: 'offer', status: 'active', title: 'Pram' });
        expect(await phoneHost(ctx(KIT)).posts!.mine()).toEqual([{ id: 'live', title: 'Ladder', status: 'active' }, { id: 'paused', title: 'Tent', status: 'paused' }]);
    });

    it("`deals`: the member's deals as seller or lender only; a loan that is out says when it is due back, from its Offer's hand-over", async () => {
        posts.rows.set('p-out', { id: 'p-out', author_pubkey: ME.publicKey, type: 'offer', status: 'pending', lendable: 1, price_type: 'fixed', accepted_at: '2026-10-18T09:00:00.000Z' });
        posts.deals.push(
            { id: 'tx-out', postId: 'p-out', sellerPublicKey: ME.publicKey, buyerPublicKey: 'b', status: 'pending', hours: 5, createdAt: '2026-10-17T09:00:00.000Z' },
            { id: 'tx-asked', postId: 'p-asked', sellerPublicKey: ME.publicKey, buyerPublicKey: 'b', status: 'requested', hours: 2, createdAt: '2026-10-19T09:00:00.000Z' },
            { id: 'tx-done', postId: 'p-done', sellerPublicKey: ME.publicKey, buyerPublicKey: 'b', status: 'completed', createdAt: '2026-10-01T09:00:00.000Z', completedAt: '2026-10-05T09:00:00.000Z' },
            { id: 'tx-bought', postId: 'p-theirs', sellerPublicKey: 'someone-else', buyerPublicKey: ME.publicKey, status: 'pending', createdAt: '2026-10-19T09:00:00.000Z' },
        );
        expect(await phoneHost(ctx(KIT)).deals!()).toEqual([
            { postId: 'p-out', transactionId: 'tx-out', status: 'pending', updatedAt: '2026-10-18T09:00:00.000Z', backAround: '2026-10-23T09:00:00.000Z' },
            { postId: 'p-asked', transactionId: 'tx-asked', status: 'requested', updatedAt: '2026-10-19T09:00:00.000Z' },
            { postId: 'p-done', transactionId: 'tx-done', status: 'completed', updatedAt: '2026-10-05T09:00:00.000Z' },
        ]);
    });

    it("`pricingGuide`: the community's guide on one thing, a hint only; null with no match, no answer or no community", async () => {
        const guide = { items: [{ id: 'th-002', category: 'tools', emoji: '🪜', name: 'Extension Ladder Hire (6m / Day)', description: '', priceBeans: 12, unit: 'day' }] };
        const fetchSpy = vi.fn(async (_url: string) => new Response(JSON.stringify(guide), { status: 200 }));
        vi.stubGlobal('fetch', fetchSpy);
        try {
            const host = phoneHost({ ...ctx(KIT), node: { url: 'https://mullum.example/', profile: 'local', features: null } });
            expect(await host.pricingGuide!('tools', 'Step ladder')).toEqual({ credits: 12, priceType: 'daily' });
            expect(fetchSpy.mock.calls.map(([u]) => String(u))).toEqual(['https://mullum.example/api/pricing-guide']);
            expect(await host.pricingGuide!('tools', 'Cordless drill')).toBeNull();
            fetchSpy.mockImplementationOnce(async () => { throw new TypeError('Network request failed'); });
            expect(await host.pricingGuide!('tools', 'Step ladder')).toBeNull();
            store.map.delete('beanpool_anchor_url');
            expect(await phoneHost(ctx(KIT)).pricingGuide!('tools', 'Step ladder')).toBeNull();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('the one store', () => {
    it('reads through doc.read, writes whole, and refuses a document over its bound', async () => {
        expect((await readToolDoc(ME.publicKey, KIT)).stored).toBe(false);
        await writeToolDoc(ME.publicKey, KIT, KIT_FIXTURES.docs.small, NOW);
        expect(await readToolDoc(ME.publicKey, KIT)).toEqual({ doc: KIT_FIXTURES.docs.small, stored: true });
        await expect(writeToolDoc(ME.publicKey, KIT, { v: 1, items: kitItems(40, () => 'y'.repeat(60)) }, NOW)).rejects.toBeInstanceOf(ToolDocTooBigError);
        expect(await readToolDoc(ME.publicKey, KIT)).toEqual({ doc: KIT_FIXTURES.docs.small, stored: true });
    });

    it('Sign Out leaves no row and no file: every document, photo, reminder and setting goes', async () => {
        const n = fakeNotifications();
        n.scheduled.push({ identifier: 'bp-tool:fixture-kit:back:1' }, { identifier: 'bp-tool:other-tool:weekly:2' }, { identifier: 'someone-elses' });
        await writeToolDoc(ME.publicKey, KIT, KIT_FIXTURES.docs.small, NOW);
        await writeToolDoc('enterprise-key', { ...KIT, id: 'other-tool' }, KIT_FIXTURES.docs.full, NOW);
        const picked = path.join(disk.dir, 'picked.jpg');
        fs.writeFileSync(picked, 'jpeg bytes');
        const photo = await keepToolPhoto('local', ME.publicKey, 'fixture-kit', { uri: `file://${picked}`, width: 800, height: 600 }, 'p1');
        const photoFile = toolPhotoUri('local', ME.publicKey, 'fixture-kit', photo.ref).replace(/^file:\/\//, '');
        expect(fs.existsSync(photoFile)).toBe(true);
        await writeToolSettings(ME.publicKey, 'fixture-kit', { door: 'doing' });
        store.map.set('beanpool_anchor_url', 'https://mullum.example');
        expect(disk.db.count('SELECT COUNT(*) AS n FROM tool_docs')).toBe(2);

        await wipeToolDataOnThisPhone(n);

        expect(disk.db.count('SELECT COUNT(*) AS n FROM tool_docs')).toBe(0);
        expect(fs.existsSync(path.join(disk.dir, 'tools'))).toBe(false);
        expect([...store.map.keys()].filter((k) => k.startsWith(TOOL_SETTINGS_PREFIX))).toEqual([]);
        expect(n.scheduled.map((x) => x.identifier)).toEqual(['someone-elses']);
        expect(store.map.get('beanpool_anchor_url')).toBe('https://mullum.example');
    });

    it("Sign Out's own path calls it, and the open file's table goes as the account leaves (and stays on a re-sync)", () => {
        const identity = fs.readFileSync(path.join(NATIVE, 'utils/identity.ts'), 'utf8');
        const wipe = identity.slice(identity.indexOf('export async function wipeIdentity('));
        expect(wipe).toMatch(/await import\('\.\.\/tools\/store'\)[\s\S]*await wipeToolDataOnThisPhone\(\)/);
        expect(identity).toMatch(/k\.startsWith\(TOOL_SETTINGS_PREFIX\)/);
        const db = fs.readFileSync(path.join(NATIVE, 'utils/db.ts'), 'utf8');
        const clear = db.slice(db.indexOf('export async function clearDB('), db.indexOf('export async function clearDB(') + 2500);
        expect(clear).toMatch(/opts\.identityLeaves \? '[^']*DROP TABLE IF EXISTS tool_docs;/);
        expect(clear.replace(/opts\.identityLeaves \? '[^']*'/, '')).not.toMatch(/tool_docs/);
        expect(db).toContain('${TOOL_DOCS_TABLE}');
    });

    it("Remove my data in community A removes only that community's document, photos and reminders", async () => {
        const n = fakeNotifications();
        const urlA = 'https://community-a.example';
        const urlB = 'https://community-b.example';
        const commA = communityKey(urlA);
        const commB = communityKey(urlB);

        // Community A
        await writeToolDoc(ME.publicKey, KIT, KIT_FIXTURES.docs.small, NOW);
        const pickedA = path.join(disk.dir, 'picked-a.jpg');
        fs.writeFileSync(pickedA, 'jpeg a');
        const photoA = await keepToolPhoto(commA, ME.publicKey, 'fixture-kit', { uri: `file://${pickedA}`, width: 800, height: 600 }, 'pA');
        const fileA = toolPhotoUri(commA, ME.publicKey, 'fixture-kit', photoA.ref).replace(/^file:\/\//, '');
        expect(fs.existsSync(fileA)).toBe(true);

        // Community B
        const pickedB = path.join(disk.dir, 'picked-b.jpg');
        fs.writeFileSync(pickedB, 'jpeg b');
        const photoB = await keepToolPhoto(commB, ME.publicKey, 'fixture-kit', { uri: `file://${pickedB}`, width: 800, height: 600 }, 'pB');
        const fileB = toolPhotoUri(commB, ME.publicKey, 'fixture-kit', photoB.ref).replace(/^file:\/\//, '');
        expect(fs.existsSync(fileB)).toBe(true);

        n.scheduled.push(
            { identifier: `bp-tool:${commA}:fixture-kit:back:100` },
            { identifier: `bp-tool:${commB}:fixture-kit:back:200` },
        );

        // Settings per community: turn a reminder off at B, write A's settings
        await writeToolSettings(ME.publicKey, 'fixture-kit', { reminders: { back: false } }, urlB);
        await writeToolSettings(ME.publicKey, 'fixture-kit', { reminders: { back: true } }, urlA);

        await removeToolDataHere(ME.publicKey, 'fixture-kit', urlA, n);

        expect(fs.existsSync(fileA)).toBe(false);
        expect(n.scheduled.some((s) => s.identifier.includes(commA))).toBe(false);
        expect(fs.existsSync(fileB)).toBe(true);
        expect(n.scheduled.some((s) => s.identifier === `bp-tool:${commB}:fixture-kit:back:200`)).toBe(true);
        const settingsB = await readToolSettings(ME.publicKey, 'fixture-kit', urlB);
        expect(reminderOn(settingsB, { id: 'back', defaultOn: true })).toBe(false);
    });

    it("leaving a community removes that community's photos and reminders", async () => {
        const n = fakeNotifications();
        const urlLeave = 'https://community-leave.example';
        const urlStay = 'https://community-stay.example';
        const commLeave = communityKey(urlLeave);
        const commStay = communityKey(urlStay);

        const pickedA = path.join(disk.dir, 'leave-a.jpg');
        fs.writeFileSync(pickedA, 'bytes a');
        await keepToolPhoto(commLeave, ME.publicKey, 'fixture-kit', { uri: `file://${pickedA}`, width: 800, height: 600 }, 'pL');
        const fileA = toolPhotoUri(commLeave, ME.publicKey, 'fixture-kit', 'pL').replace(/^file:\/\//, '');
        expect(fs.existsSync(fileA)).toBe(true);

        const pickedB = path.join(disk.dir, 'stay-b.jpg');
        fs.writeFileSync(pickedB, 'bytes b');
        await keepToolPhoto(commStay, ME.publicKey, 'fixture-kit', { uri: `file://${pickedB}`, width: 800, height: 600 }, 'pS');
        const fileB = toolPhotoUri(commStay, ME.publicKey, 'fixture-kit', 'pS').replace(/^file:\/\//, '');
        expect(fs.existsSync(fileB)).toBe(true);

        n.scheduled.push(
            { identifier: `bp-tool:${commLeave}:fixture-kit:back:100` },
            { identifier: `bp-tool:${commStay}:fixture-kit:back:200` },
        );

        await writeToolSettings(ME.publicKey, 'fixture-kit', { reminders: { back: false } }, urlStay);
        await writeToolSettings(ME.publicKey, 'fixture-kit', { door: 'starting' }, urlLeave);

        await removeCommunityToolData(urlLeave, n);

        expect(fs.existsSync(fileA)).toBe(false);
        expect(fs.existsSync(fileB)).toBe(true);
        const settingsStay = await readToolSettings(ME.publicKey, 'fixture-kit', urlStay);
        expect(reminderOn(settingsStay, { id: 'back', defaultOn: true })).toBe(false);
        const settingsLeave = await readToolSettings(ME.publicKey, 'fixture-kit', urlLeave);
        expect(settingsLeave).toEqual({});
        expect(n.scheduled.map((s) => s.identifier)).toEqual([`bp-tool:${commStay}:fixture-kit:back:200`]);
    });

    it("phone Home card subscribes to tool store writes and updates without a remount", async () => {
        await writeToolDoc(ME.publicKey, KIT, { v: 1, items: [] }, NOW);

        await act(async () => {
            root.render(createElement(ToolHomeBody, { tool: { manifest: KIT, app: kitApp as any }, owner: ME.publicKey, colors: lightColors, now: NOW }) as any);
        });
        await settle(5);
        expect(byTestId('tool-home-fixture-kit-open')).not.toBeNull();

        await act(async () => {
            await writeToolDoc(ME.publicKey, KIT, KIT_FIXTURES.docs.small, NOW);
        });
        await settle(5);

        expect(host.textContent).toContain('Tent');
    });
});

describe('the node copy, through the host route (slice T0.4; tool-node-copy.test.ts runs the rule on two phones)', () => {
    const PRIVATE = "Kept on this phone, with a private copy on your community's server that only you can read through the app. Like everything on that server, its operator could.";
    const PHONE_ONLY = 'Kept on this phone only. Nothing in it leaves this phone.';
    const REMOVED = "Your community's server no longer keeps a copy of this tool, so it is kept on this phone only. You can switch the copy on again in Settings.";
    const KEEPER = 'A keeper switched off the server copy of this tool, so it is kept on this phone only. You can switch it on again in Settings.';
    const OLDER = "Your community's server can't keep a copy yet, so for now it stays on this phone only.";
    const FAILED = "Couldn't reach your community's server, so nothing changed. Try again when you're online.";
    const TOO_BIG = "This is more than your community's server keeps for now, so nothing changed and it stays on this phone only. Make it smaller, then switch the copy on again.";
    const ONE_PHONE = 'One phone at a time: the copy you changed last is the one kept.';
    const REMOVE_ON = "Removes your data for this tool from this phone, and its copy on your community's server. Another phone signed in as you keeps what it has and stops sending it. The same tool in another community keeps its own. This can't be undone.";
    const SYNCED_AT = '2026-10-21T07:00:00.000Z';
    const comm = () => communityKey(store.map.get('beanpool_anchor_url'));
    const stored = () => JSON.parse(store.map.get(settingsKey(comm(), ME.publicKey, 'fixture-kit')) ?? 'null');
    /** The phone holds `d`, synced with the server's copy of it. */
    async function keptAndSynced(d: KitDoc) {
        await writeToolDoc(ME.publicKey, KIT, d, Date.parse(SYNCED_AT));
        await disk.db.runAsync('UPDATE tool_docs SET synced_at = updated_at WHERE owner = ? AND tool = ?', [ME.publicKey, 'fixture-kit']);
        server.rows.set('fixture-kit', { doc: d, updatedAt: SYNCED_AT });
    }
    /** The tool opened again, as a new visit (a fresh route, not the one already drawn). */
    async function reopen(lang: 'xx' | 'en' = 'en') {
        act(() => root.unmount());
        root = createRoot(host);
        await drawTool('fixture-kit', {}, lang);
    }
    async function openSettings() {
        await click(byTestId('tool-menu'), 'the "…"');
        await click(byTestId('tool-menu-settings'), 'Settings');
    }
    beforeEach(() => { reg.extra = [{ manifest: KIT, app: kitApp }]; OTHERS = ['Ladder', 'Tent']; });

    it("the open takes the server's copy (a first open on this phone) and draws it; the tool is told the copy is on", async () => {
        server.rows.set('fixture-kit', { doc: KIT_FIXTURES.docs.small, updatedAt: SYNCED_AT });
        const seen: boolean[] = [];
        const Spy = (p: KitProps) => { seen.push(p.host.nodeCopy.on); return createElement(KitMain, p); };
        reg.extra = [{ manifest: KIT, app: { ...kitApp, screens: () => ({ ...kitScreens, main: Spy }) } }];
        await drawTool('fixture-kit', {}, 'en');
        expect(host.textContent).toContain('Tent');
        expect(byTestId('tool-doors')).toBeNull();
        expect((await readToolDoc(ME.publicKey, KIT)).doc).toEqual(KIT_FIXTURES.docs.small);
        expect(byTestId('tool-backup-line')?.textContent).toBe(PRIVATE);
        expect(seen.at(-1)).toBe(true);
        expect(server.log.map((r) => r.method)).toEqual(['GET']);
    });

    for (const [name, deletedAt] of [['S2.1 says when', true], ["today's node says none", false]] as const) {
        it(`switched off on another phone (${name}): the line once, in xx at 320 dp × 1.3; nothing sent; this phone's copy kept`, async () => {
            await keptAndSynced(KIT_FIXTURES.docs.small);
            server.rows.clear();
            server.tombs.set('fixture-kit', '2026-10-21T07:30:00.000Z');
            server.sendsDeletedAt = deletedAt;
            await drawTool('fixture-kit', {}, 'xx');
            expect(byTestId('tool-backup-line')?.textContent).toBe(pseudoLocalise(REMOVED));
            expect(bypassing(true)).toEqual([]);
            expect(tooWide()).toEqual([]);
            await openSettings();
            expect(byTestId('tool-settings-kept')?.textContent).toBe(pseudoLocalise(REMOVED));
            expect(byTestId('tool-settings-node-copy')?.textContent ?? '').toBe('');
            expect(bypassing(true)).toEqual([]);
            expect(tooWide()).toEqual([]);
            expect(server.log.map((r) => r.method)).toEqual(['GET']);
            expect(stored()).toMatchObject({ nodeCopy: false });
            expect((await readToolDoc(ME.publicKey, KIT)).doc).toEqual(KIT_FIXTURES.docs.small);
            // Once: the next open asks the server nothing and says this phone only.
            await reopen();
            expect(byTestId('tool-backup-line')?.textContent).toBe(PHONE_ONLY);
            expect(server.log.map((r) => r.method)).toEqual(['GET']);
        });
    }

    it("an enterprise's copy switched off by a keeper says so in the keeper's line", () => {
        setLanguage('en');
        expect(backupLine(KIT, { nodeCopy: false }, 'removed', 'enterprise')).toBe(KEEPER);
        expect(backupLine(KIT, { nodeCopy: false }, 'removed', 'member')).toBe(REMOVED);
        expect(backupLine({ permissions: [] }, {}, 'removed', 'enterprise')).toBe(PHONE_ONLY);
    });

    it('an older server: its line at the foot and under the toggle, the tool told the copy is off, and a write sends nothing', async () => {
        server.mode = 'older';
        const seen: boolean[] = [];
        const Writes = (p: KitProps) => {
            seen.push(p.host.nodeCopy.on);
            return createElement(ToolButton, { text: 'Add', testID: 'add', onPress: () => { void p.host.doc.set({ v: 1, items: [{ id: 'x', name: 'Rake', at: NOW }] }); } } as any);
        };
        reg.extra = [{ manifest: KIT, app: { ...kitApp, screens: () => ({ ...kitScreens, main: Writes }) } }];
        await writeToolDoc(ME.publicKey, KIT, KIT_FIXTURES.docs.small, NOW);
        OTHERS = ['Ladder', 'Tent', 'Add'];
        await drawTool('fixture-kit', {}, 'xx');
        expect(byTestId('tool-backup-line')?.textContent).toBe(pseudoLocalise(OLDER));
        expect(seen.at(-1)).toBe(false);
        await openSettings();
        expect(byTestId('tool-settings-node-copy-note')?.textContent).toBe(pseudoLocalise(OLDER));
        expect(bypassing(true)).toEqual([]);
        expect(tooWide()).toEqual([]);
        await click(byTestId('tool-settings-done'), 'Done');
        await click(byTestId('add'), 'a write');
        await new Promise((r) => setTimeout(r, 50));
        expect(server.log.map((r) => r.method)).toEqual(['GET']);
    });

    it("the toggle: while the server can't be reached the switch stays and says so; then off is one DELETE, and on a GET and a PUT", async () => {
        await keptAndSynced(KIT_FIXTURES.docs.small);
        await drawTool('fixture-kit', {}, 'xx');
        await openSettings();
        expect(byTestId('tool-settings-node-copy-note')?.textContent).toBe(pseudoLocalise(ONE_PHONE));
        server.mode = 'down';
        await click(byTestId('tool-settings-node-copy'), 'the toggle, off');
        expect(byTestId('tool-settings-node-copy-failed')?.textContent).toBe(pseudoLocalise(FAILED));
        expect(bypassing(true)).toEqual([]);
        expect(tooWide()).toEqual([]);
        expect(stored()?.nodeCopy).toBeUndefined();
        expect(byTestId('tool-backup-line')?.textContent).toBe(pseudoLocalise(PRIVATE));
        expect(server.rows.has('fixture-kit')).toBe(true);

        server.mode = 'up';
        server.log.length = 0;
        await click(byTestId('tool-settings-node-copy'), 'the toggle, off');
        expect(server.log.map((r) => r.method)).toEqual(['DELETE']);
        expect(byTestId('tool-settings-node-copy-failed')).toBeNull();
        expect(stored()).toMatchObject({ nodeCopy: false });
        expect(server.rows.has('fixture-kit')).toBe(false);
        expect(byTestId('tool-backup-line')?.textContent).toBe(pseudoLocalise(PHONE_ONLY));

        server.log.length = 0;
        await click(byTestId('tool-settings-node-copy'), 'the toggle, on');
        expect(server.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
        // The member's switch-on, and only it, says so (an ordinary PUT never writes over a removed copy: S2.2).
        expect(server.log[1].body).toEqual({ doc: KIT_FIXTURES.docs.small, turnOn: true });
        expect(stored()).toMatchObject({ nodeCopy: true });
        expect(byTestId('tool-backup-line')?.textContent).toBe(pseudoLocalise(PRIVATE));
        // A whole-settings save (a reminder's switch) never writes the copy's setting back over the server's answer.
        await click(byTestId('tool-settings-reminder-weekly'), "a reminder's switch");
        expect(stored()).toMatchObject({ nodeCopy: true, reminders: { weekly: true } });
    });

    it("switching on with more than the server keeps: the template's own sentence, never the offline one, and the switch stays off", async () => {
        await writeToolSettings(ME.publicKey, 'fixture-kit', { nodeCopy: false });
        await writeToolDoc(ME.publicKey, KIT, KIT_FIXTURES.docs.small, NOW);
        // A server that keeps less than this tool's document (an older one keeps 64 KB; the fixture is smaller than that).
        server.max = 16;
        await drawTool('fixture-kit', {}, 'xx');
        await openSettings();
        server.log.length = 0;
        await click(byTestId('tool-settings-node-copy'), 'the toggle, on');
        expect(server.log.map((r) => r.method)).toEqual(['GET']);
        expect(byTestId('tool-settings-node-copy-too-big')?.textContent).toBe(pseudoLocalise(TOO_BIG));
        expect(byTestId('tool-settings-node-copy-failed')).toBeNull();
        expect(bypassing(true)).toEqual([]);
        expect(tooWide()).toEqual([]);
        expect(stored()).toMatchObject({ nodeCopy: false, nodeMax: 16 });
        expect(byTestId('tool-backup-line')?.textContent).toBe(pseudoLocalise(PHONE_ONLY));
        // Tried again with the server unreachable: the offline line, and not this one.
        server.mode = 'down';
        await click(byTestId('tool-settings-node-copy'), 'the toggle, on');
        expect(byTestId('tool-settings-node-copy-too-big')).toBeNull();
        expect(byTestId('tool-settings-node-copy-failed')?.textContent).toBe(pseudoLocalise(FAILED));
    });

    it('Remove my data with the copy on: the question says the server copy goes too; the server first, or nothing', async () => {
        await keptAndSynced(KIT_FIXTURES.docs.small);
        const picked = path.join(disk.dir, 'picked.jpg');
        fs.writeFileSync(picked, 'jpeg bytes');
        const photo = await keepToolPhoto(comm(), ME.publicKey, 'fixture-kit', { uri: `file://${picked}`, width: 800, height: 600 }, 'p1');
        const photoFile = toolPhotoUri(comm(), ME.publicKey, 'fixture-kit', photo.ref).replace(/^file:\/\//, '');
        await writeToolSettings(ME.publicKey, 'fixture-kit', { door: 'doing', reminders: { weekly: true } });
        server.seen = () => disk.db.count('SELECT COUNT(*) AS n FROM tool_docs');
        await drawTool('fixture-kit', {}, 'xx');
        const remove = async () => {
            alerts.said.length = 0;
            await click(byTestId('tool-menu'), 'the "…"');
            await click(byTestId('tool-menu-remove'), 'Remove my data');
            expect(alerts.said).toEqual([pseudoLocalise('Remove my data from this phone'), pseudoLocalise(REMOVE_ON)]);
            await act(async () => { alerts.buttons.find((b) => b.text === pseudoLocalise('Remove'))!.onPress!(); });
            await settle();
        };
        server.mode = 'down';
        await remove();
        expect(alerts.said.slice(2)).toEqual([pseudoLocalise('Remove my data from this phone'), pseudoLocalise(FAILED)]);
        expect(bypassing(true)).toEqual([]);
        expect(disk.db.count('SELECT COUNT(*) AS n FROM tool_docs')).toBe(1);
        expect(fs.existsSync(photoFile)).toBe(true);
        expect(stored()).toEqual({ door: 'doing', reminders: { weekly: true } });
        expect(host.textContent).toContain('Tent');

        server.mode = 'up';
        server.log.length = 0;
        await remove();
        expect(server.log.map((r) => [r.method, r.held])).toEqual([['DELETE', 1]]);
        expect(server.rows.has('fixture-kit')).toBe(false);
        expect(disk.db.count('SELECT COUNT(*) AS n FROM tool_docs')).toBe(0);
        expect(fs.existsSync(photoFile)).toBe(false);
        expect(stored()).toEqual({ nodeCopy: false });
        expect(byTestId('tool-doors')).not.toBeNull();
        expect(byTestId('tool-backup-line')?.textContent).toBe(pseudoLocalise(PHONE_ONLY));
        // With the copy off, Remove says today's words and asks the server nothing.
        await writeToolDoc(ME.publicKey, KIT, KIT_FIXTURES.docs.small, NOW);
        await reopen('en');
        server.log.length = 0;
        alerts.said.length = 0;
        await click(byTestId('tool-menu'), 'the "…"');
        await click(byTestId('tool-menu-remove'), 'Remove my data');
        expect(alerts.said[1]).toBe("Removes this community's list, photos and reminders for this tool on this phone. The same tool in another community keeps its own. This can't be undone.");
        await act(async () => { alerts.buttons.find((b) => b.text === 'Remove')!.onPress!(); });
        await settle();
        expect(server.log).toEqual([]);
        expect(disk.db.count('SELECT COUNT(*) AS n FROM tool_docs')).toBe(0);
    });

    it("a settings record that still holds the old marks (nodeCopyMarks, before fix round 3) opens without error and is left alone; Remove my data leaves { nodeCopy: false } only", async () => {
        await keptAndSynced(KIT_FIXTURES.docs.small);
        const OLD = { unsure: 'check', digests: ['0123456789abcdef'] };
        await writeToolSettings(ME.publicKey, 'fixture-kit', { nodeCopyMarks: OLD } as unknown as ToolSettings);
        await drawTool('fixture-kit', {}, 'xx');
        expect(host.textContent).toContain('Tent');
        expect(server.log.map((r) => r.method)).toEqual(['GET']);
        await openSettings();
        await click(byTestId('tool-settings-reminder-weekly'), "a reminder's switch");
        expect(stored()).toEqual({ nodeCopyMarks: OLD, reminders: { weekly: true } });
        await click(byTestId('tool-settings-done'), 'Done');
        await click(byTestId('tool-menu'), 'the "…"');
        await click(byTestId('tool-menu-remove'), 'Remove my data');
        await act(async () => { alerts.buttons.find((b) => b.text === pseudoLocalise('Remove'))!.onPress!(); });
        await settle();
        expect(server.log.map((r) => r.method)).toEqual(['GET', 'DELETE']);
        expect(server.rows.has('fixture-kit')).toBe(false);
        expect(stored()).toEqual({ nodeCopy: false });
    });

    it("a write's PUT refused 410 (switched off on another phone after this phone's GET): the line once, in xx at 320 dp × 1.3; the setting off; the write kept here", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        try {
            server.refusesOff = true;
            const Writes = (p: KitProps) => createElement(ToolButton, {
                text: 'Add', testID: 'add', onPress: () => { const d = p.host.doc.get(); void p.host.doc.set({ ...d, items: [...d.items, { id: 'rake', name: 'Rake', at: NOW }] }); },
            } as any);
            reg.extra = [{ manifest: KIT, app: { ...kitApp, screens: () => ({ ...kitScreens, main: Writes }) } }];
            OTHERS = ['Ladder', 'Tent', 'Add'];
            await keptAndSynced(KIT_FIXTURES.docs.small);
            await drawTool('fixture-kit', {}, 'xx');
            server.log.length = 0;
            // The other phone's off reaches the server between this phone's GET and its PUT.
            server.before = (method) => {
                if (method !== 'PUT') return;
                server.before = null;
                server.rows.delete('fixture-kit');
                server.tombs.set('fixture-kit', '2026-10-21T09:00:00.000Z');
            };
            await click(byTestId('add'), 'a write');
            await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
            await settle();
            expect(server.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
            expect(server.log[1].body).toEqual({ doc: { ...KIT_FIXTURES.docs.small, items: [...KIT_FIXTURES.docs.small.items, { id: 'rake', name: 'Rake', at: NOW }] } });
            expect(server.rows.has('fixture-kit')).toBe(false);
            expect(byTestId('tool-backup-line')?.textContent).toBe(pseudoLocalise(REMOVED));
            expect(bypassing(true)).toEqual([]);
            expect(tooWide()).toEqual([]);
            expect(stored()).toMatchObject({ nodeCopy: false });
            expect((await readToolDoc(ME.publicKey, KIT)).doc.items.map((i) => i.name)).toEqual(['Ladder', 'Tent', 'Rake']);
        } finally {
            vi.useRealTimers();
        }
        // Once: the next open asks the server nothing and says this phone only.
        await reopen();
        expect(byTestId('tool-backup-line')?.textContent).toBe(PHONE_ONLY);
        expect(server.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
    });

    it("a write through the tool's host: one sync five seconds after the last, not one a write", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        try {
            let n = 0;
            const Writes = (p: KitProps) => createElement(ToolButton, {
                text: 'Add', testID: 'add', onPress: () => { const d = p.host.doc.get(); void p.host.doc.set({ ...d, items: [...d.items, { id: `i${++n}`, name: `Thing ${n}`, at: NOW }] }); },
            } as any);
            reg.extra = [{ manifest: KIT, app: { ...kitApp, screens: () => ({ ...kitScreens, main: Writes }) } }];
            await keptAndSynced(KIT_FIXTURES.docs.small);
            await drawTool('fixture-kit', {}, 'en');
            server.log.length = 0;
            for (let i = 0; i < 4; i++) await click(byTestId('add'), 'a write');
            expect(server.log).toEqual([]);
            await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
            await settle();
            expect(server.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
            // A sync after a write is no switch-on: its body is the document alone.
            expect(Object.keys(server.log[1].body as object)).toEqual(['doc']);
            expect((server.rows.get('fixture-kit')!.doc as KitDoc).items.map((i) => i.name)).toEqual(['Ladder', 'Tent', 'Thing 1', 'Thing 2', 'Thing 3', 'Thing 4']);
        } finally {
            vi.useRealTimers();
        }
    });
});

/** expo-notifications as tools/reminders.ts uses it, keeping what is scheduled. */
function fakeNotifications() {
    const scheduled: Array<{ identifier: string; content?: any; trigger?: any }> = [];
    return {
        scheduled,
        getAllScheduledNotificationsAsync: async () => [...scheduled],
        cancelScheduledNotificationAsync: async (id: string) => { const i = scheduled.findIndex((s) => s.identifier === id); if (i >= 0) scheduled.splice(i, 1); },
        scheduleNotificationAsync: async (r: { identifier: string; content: any; trigger: any }) => { scheduled.push(r); return r.identifier; },
        setNotificationChannelAsync: vi.fn(async () => null),
        AndroidImportance: { DEFAULT: 3 },
    };
}

describe("reminders: due() becomes the phone's own date-trigger notifications", () => {
    const doc: KitDoc = { v: 1, items: [{ id: 'a', name: 'Ladder', at: NOW + DAY }, { id: 'b', name: 'Tent', at: NOW - DAY }] };
    const on = (id: string) => id === 'back';

    it('only the reminders that are on, only in the future, soonest first, at most ten', () => {
        expect(remindersToSchedule(KIT, doc, on, NOW).map((d) => [d.reminder, d.at])).toEqual([['back', NOW + DAY]]);
        const many: KitDoc = { v: 1, items: kitItems(15, (i) => `n${i}`) };
        const allDue = { ...KIT, reminders: { ...KIT.reminders!, due: (d: KitDoc) => d.items.map((i) => ({ reminder: 'back', at: i.at, key: word('{name} is due back today'), values: { name: i.name } })) } };
        expect(remindersToSchedule(allDue, many, on, NOW)).toHaveLength(10);
        expect(remindersToSchedule({ ...KIT, reminders: { ...KIT.reminders!, due: () => { throw new Error('x'); } } }, doc, on, NOW)).toEqual([]);
        expect(remindersToSchedule({ ...KIT, permissions: ['photos'] }, doc, on, NOW)).toEqual([]);
    });

    it("schedules each with a date trigger in the tools' channel, after cancelling the tool's own earlier ones and no one else's", async () => {
        setLanguage('en');
        const n = fakeNotifications();
        n.scheduled.push({ identifier: 'bp-tool:fixture-kit:back:1' }, { identifier: 'bp-tool:other:back:1' }, { identifier: 'a-community-notice' });
        const due = await scheduleToolReminders(KIT, doc, on, NOW, n, 'android');
        expect(due).toHaveLength(1);
        expect(n.scheduled.map((s) => s.identifier)).toEqual(['bp-tool:other:back:1', 'a-community-notice', `bp-tool:local:fixture-kit:back:${NOW + DAY}`]);
        const mine = n.scheduled[2];
        expect(mine.trigger).toEqual({ type: 'date', date: new Date(NOW + DAY), channelId: TOOL_REMINDER_CHANNEL });
        expect(mine.content).toEqual({ title: 'Fixture kit', body: 'Ladder is due back today', data: { bpLocal: 1, bpCommunity: 'local', bpTool: 'fixture-kit', screen: 'item' } });
        expect(n.setNotificationChannelAsync).toHaveBeenCalledWith(TOOL_REMINDER_CHANNEL, expect.objectContaining({ importance: 3 }));
        await cancelToolReminders(undefined, n);
        expect(n.scheduled.map((s) => s.identifier)).toEqual(['a-community-notice']);
    });

    it('a tap on one opens the tool at its screen; anything from outside opens nothing', () => {
        reg.extra = [{ manifest: KIT, app: kitApp }];
        expect(toolReminderRoute({ remote: false, data: { bpLocal: 1, bpTool: 'fixture-kit', screen: 'item' } })).toBe('/tool/fixture-kit?screen=item');
        expect(toolReminderRoute({ remote: false, data: { bpLocal: 1, bpTool: 'fixture-kit', screen: 'nope' } })).toBe('/tool/fixture-kit');
        expect(toolReminderRoute({ remote: true, data: { bpTool: 'fixture-kit' } })).toBeNull();
        expect(toolReminderRoute({ remote: false, data: { bpTool: 'not-here' } })).toBeNull();
        expect(toolReminderRoute({ remote: false, data: null })).toBeNull();
        // Not the phone's own (no bpLocal: 1), even with `remote` inferred false: a push naming a tool opens nothing here.
        expect(toolReminderRoute({ remote: false, data: { bpTool: 'fixture-kit', screen: 'item' } })).toBeNull();
        expect(toolReminderRoute({ remote: false, data: { bpLocal: '1', bpTool: 'fixture-kit' } })).toBeNull();
    });

    it("opening a tool in community B never cancels community A's reminders", async () => {
        const n = fakeNotifications();
        n.scheduled.push(
            { identifier: `bp-tool:community_a:fixture-kit:back:${NOW + DAY}` },
            { identifier: `bp-tool:community_b:fixture-kit:back:${NOW + 10}` },
        );

        await scheduleToolReminders(KIT, doc, on, NOW, n, 'android', 'community_b');

        expect(n.scheduled.some((s) => s.identifier === `bp-tool:community_a:fixture-kit:back:${NOW + DAY}`)).toBe(true);
    });

    it("cancelToolReminders does not cancel reminders of other tools with matching reminder names", async () => {
        const n = fakeNotifications();
        n.scheduled.push(
            { identifier: 'bp-tool:comm:other-tool:due:1000' },
            { identifier: 'bp-tool:comm:due:item:2000' },
            { identifier: 'bp-tool:other-tool:due:3000' },
        );
        // Cancelling tool "due" should not match reminders of other-tool whose reminder name is "due",
        // nor should it match 5-part reminders by community identifier.
        await cancelToolReminders({ tool: 'due' }, n);
        expect(n.scheduled.map((s) => s.identifier)).toEqual([
            'bp-tool:comm:other-tool:due:1000',
            'bp-tool:other-tool:due:3000',
        ]);

        // Calling cancelToolReminders with community name as tool should not wipe other tools in that community
        await cancelToolReminders('comm', n);
        expect(n.scheduled.map((s) => s.identifier)).toEqual([
            'bp-tool:comm:other-tool:due:1000',
            'bp-tool:other-tool:due:3000',
        ]);

        // Cancelling by tool name cancels both anchored and legacy reminders for that tool
        await cancelToolReminders('other-tool', n);
        expect(n.scheduled.map((s) => s.identifier)).toEqual([]);
    });

    it('cancelToolReminders matches anchored prefix and cancels multi-part reminder ids', async () => {
        const n = fakeNotifications();
        n.scheduled.push(
            { identifier: 'bp-tool:mullum_key:kit:due:back:1700000000000' },
            { identifier: 'bp-tool:mullum_key:other:item:1700000000000' },
            { identifier: 'bp-tool:bellingen_key:kit:due:back:1700000000000' },
        );
        // Cancel kit in mullum_key
        await cancelToolReminders({ community: 'mullum_key', tool: 'kit' }, n);
        expect(n.scheduled.map((s) => s.identifier)).toEqual([
            'bp-tool:mullum_key:other:item:1700000000000',
            'bp-tool:bellingen_key:kit:due:back:1700000000000',
        ]);
        // Cancel whole mullum_key community
        await cancelToolReminders({ community: 'mullum_key' }, n);
        expect(n.scheduled.map((s) => s.identifier)).toEqual([
            'bp-tool:bellingen_key:kit:due:back:1700000000000',
        ]);
    });

    it("serializes reschedules so an older write cannot survive two quick writes", async () => {
        const n = fakeNotifications();
        const doc1: KitDoc = { v: 1, items: [{ id: '1', name: 'Ladder', at: NOW + 1000 }] };
        const doc2: KitDoc = { v: 1, items: [{ id: '2', name: 'Tent', at: NOW + 2000 }] };

        const p1 = scheduleToolReminders(KIT, doc1, on, NOW, n, 'android', 'comm');
        const p2 = scheduleToolReminders(KIT, doc2, on, NOW, n, 'android', 'comm');

        await Promise.all([p1, p2]);

        expect(n.scheduled.map((s) => s.identifier)).toEqual([`bp-tool:comm:fixture-kit:back:${NOW + 2000}`]);
    });

    it("the frame's menu delays presenting Settings or Alerts on iOS until its Modal closes", () => {
        vi.useFakeTimers();
        try {
            let called = false;
            afterModal(() => { called = true; }, 'ios');
            expect(called).toBe(false);
            vi.advanceTimersByTime(349);
            expect(called).toBe(false);
            vi.advanceTimersByTime(1);
            expect(called).toBe(true);

            let androidCalled = false;
            afterModal(() => { androidCalled = true; }, 'android');
            expect(androidCalled).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("the doors write the map composer's own draft (app/(tabs)/map.tsx, read, never edited)", () => {
    it('every field map.tsx restores is there, the fee as the sheet set it, no pin, the extra fields dropped', () => {
        const d = composerDraft('offer', { title: 'Ladder', description: 'Back within a week.', category: 'tools', lendable: true, shop: true }, 'https://mullum.example', ['data:image/jpeg;base64,AA'], { kind: 'daily', beans: 3 }, NOW);
        const map = fs.readFileSync(path.join(NATIVE, 'app/(tabs)/map.tsx'), 'utf8');
        const restore = map.slice(map.indexOf('const restoreDraft'), map.indexOf('const restoreDraft') + 1500);
        for (const field of restore.match(/\bd\.(\w+)/g)!.map((m) => m.slice(2))) expect(Object.keys(d), field).toContain(field);
        expect(map).toContain("const OFFER_DRAFT_KEY = 'beanpool_offer_draft'");
        expect(d).toMatchObject({ postType: 'offer', postTitle: 'Ladder', postCredits: '3', postPriceType: 'daily', postLat: null, postLng: null, anchorUrl: 'https://mullum.example' });
        expect(d).not.toHaveProperty('lendable');
        expect(composerDraft('offer', { title: 'x' }, null, [], { kind: 'free', beans: 9 }, NOW)).toMatchObject({ postCredits: '0', postPriceType: 'fixed' });
    });

    it('needDoor asks before it replaces an unfinished post on the map, and Cancel keeps it', async () => {
        setLanguage('en');
        const unfinished = JSON.stringify({ anchorUrl: 'https://mullum.example', postType: 'offer', postTitle: 'My half-written post' });
        store.map.set(OFFER_DRAFT_KEY, unfinished);
        const answer = async (button: string) => {
            alerts.said.length = 0;
            const opened = openNeedComposer(ME.publicKey, 'fixture-kit', { title: 'A ladder for a day' });
            await settle(3);
            expect(alerts.said).toEqual(['Replace your unfinished post?', 'You have an unfinished post on the map. Going on replaces it.']);
            alerts.buttons.find((b) => b.text === button)!.onPress!();
            await opened;
        };
        await answer('Cancel');
        expect([store.map.get(OFFER_DRAFT_KEY), nav.pushed]).toEqual([unfinished, []]);
        await answer('Go on');
        const writtenDraft = JSON.parse(store.map.get(OFFER_DRAFT_KEY)!);
        expect(writtenDraft).toMatchObject({ postType: 'need', postTitle: 'A ladder for a day', source: 'tool', tool: 'fixture-kit' });
        expect(decideDraftOpen(writtenDraft, 'https://mullum.example')).toBe('open-tool');
        expect(nav.pushed).toEqual(['/(tabs)/map?newPost=need']);
        // Nothing unfinished: straight to the composer, nothing asked.
        alerts.said.length = 0;
        store.map.delete(OFFER_DRAFT_KEY);
        await openNeedComposer(ME.publicKey, 'fixture-kit', { title: 'A tent' });
        expect(alerts.said).toEqual([]);
        expect(JSON.parse(store.map.get(OFFER_DRAFT_KEY)!)).toMatchObject({ postType: 'need', postTitle: 'A tent', source: 'tool', tool: 'fixture-kit' });
        expect(decideDraftOpen(JSON.parse(store.map.get(OFFER_DRAFT_KEY)!), 'https://mullum.example')).toBe('open-tool');
        expect(nav.pushed).toHaveLength(2);
    });
});
