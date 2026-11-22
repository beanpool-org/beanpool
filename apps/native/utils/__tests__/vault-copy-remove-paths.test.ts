// @vitest-environment jsdom
/**
 * Every line that sends a member to remove a copy BeanPool's key vault kept of their key, after a delete left it there
 * (review of #3369 at bde83114), as one table: each kind of copy → the path its words name → that path's screen really
 * offers Remove for that copy.
 *
 * The defect it closes: "It is removed the same way, at Settings → Account Protection → Remove." named CommunityAdminsRow's
 * Remove, which is the copy of the community the phone is on now only. After Delete Anyway the community that held the other
 * half has purged its side, so the vault's half is stray, and only "Where your account can be brought back from" lists it
 * with a Remove (utils/ways-back-state.ts `strayVaultHalves`). Its siblings: "→ Disconnect" for a sign-in's copy (Account
 * Protection lists the vault's copies only where that community's rule is the vault's), and the web app's line the same.
 *
 * - The path: one per line, built from the screen's own words (the header's Settings, Settings' Account Protection row, the
 *   row that opens the list, the button on each copy), in English and in every catalog (the phone's words, for the web
 *   app's line too: it names the phone's screen).
 * - The screen: app/ways-back.tsx rendered for real, under each rule a community can have (vault, its own server, none),
 *   with the copies the delete left; each copy's Remove, the word on its button that path's last step, removes that copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

const alerts = vi.hoisted(() => ({ shown: [] as { title: string; body?: string; buttons: { text?: string; onPress?: () => void }[] }[] }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', checkbox: 'checkbox' };
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TouchableOpacity: el('button'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: (title: string, body?: string, buttons?: { text?: string; onPress?: () => void }[]) => { alerts.shown.push({ title, body, buttons: buttons ?? [] }); } },
        AppState: { currentState: 'active', addEventListener: listener },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', async () => {
    const React = await import('react');
    return {
        router: { push() {}, back() {} },
        useFocusEffect: (cb: () => void | (() => void)) => { React.useEffect(cb, [cb]); },
        ErrorBoundary: () => null,
    };
});
vi.mock('react-native-safe-area-context', async () => {
    const React = await import('react');
    return { SafeAreaView: ({ children }: { children?: unknown }) => React.createElement('div', null, children as any), useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), digest: async () => new ArrayBuffer(32) };
});
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, getEnrolledLevelAsync: async () => 0,
    authenticateAsync: async () => ({ success: false }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, getAllKeys: async () => [], multiRemove: async () => {} },
}));
vi.mock('../db', () => ({ clearDB: async () => {}, closeDB: async () => {}, initDB: async () => {} }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: async () => {} }));
vi.mock('../../services/pillar-sync', () => ({ resetSyncFingerprints: () => {} }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx), useOnboardingColors: () => onboardingColors('light') };
});
const me = vi.hoisted(() => ({ identity: { publicKey: 'a1'.repeat(32), privateKey: 'b2'.repeat(32), callsign: 'Kim', mnemonic: [] as string[] } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity, setIdentity() {} }) }));
vi.mock('../../components/RecoveryAlertBanner', () => ({ RecoveryAlertBanner: () => null }));
const fx = vi.hoisted(() => ({ ways: null as any, rule: 'vault' as string, removed: [] as unknown[] }));
vi.mock('../copies-rule', async (importOriginal) => ({ ...(await importOriginal<typeof import('../copies-rule')>()), copiesAtFor: async () => fx.rule }));
vi.mock('../ways-back', async (importOriginal) => {
    const real = await importOriginal<typeof import('../ways-back')>();
    return {
        ...real,
        listWaysBack: async () => fx.ways,
        wordsWrittenDown: async () => true,
        noteWordsWrittenDown: async () => {},
        removeVaultCopy: async (_i: unknown, provider: string) => { fx.removed.push(['vault', provider]); return { removed: true }; },
        removeVaultHalf: async (_i: unknown, ref: string) => { fx.removed.push(['vault-half', ref]); return { removed: true }; },
        removeCommunityCopyFrom: async (_i: unknown, c: { url: string }, provider: string) => { fx.removed.push([c.url, provider]); return { removed: true }; },
        removeAdminsCopyFrom: async (_i: unknown, c: { url: string }) => { fx.removed.push([c.url, 'admins']); return { removed: true }; },
        removeEverything: async () => { fx.removed.push('everything'); return null; },
    };
});

import { setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import { WAYS_BACK_LINES } from '../../components/WaysBackList';
import WaysBackScreen from '../../app/ways-back';
import { ADMINS_HALF_STAYS_TOO, VAULT_COPIES_REMOVE_PATH, vaultCopyStaysLine, type DeleteOutcome } from '../delete-here';
import type { WaysBack } from '../ways-back';

const NATIVE = path.resolve(__dirname, '../..');
const PWA = path.resolve(NATIVE, '../pwa');
const read = (file: string) => fs.readFileSync(file, 'utf8');
/** A source file with its quoted pieces joined ('a ' + "b" → 'a b'), so a long sentence reads whole. */
const joined = (file: string) => read(file).replace(/(['"])\s*\+\s*(['"])/g, '');

// ── What the delete leaves, at a community that has the member afterwards (they brought their key back) ──
const RIVERSIDE = 'https://riverside.example';
const NOW_HERE = { url: RIVERSIDE, name: 'Riverside', vaultRef: 'label-riverside', status: { providers: [], generation: 0 } };
/** The half the vault kept for the deleted community's admins: that community purged its own half, so none claims it. */
const HALF = { ref: 'label-of-the-deleted-community', copy: 'digest', since: '2026-10-29', lastReleasedAt: null };
const SIGN_IN = { provider: 'google' as const, since: '2026-10-03', lastReleasedAt: null };
const left = (copies: (typeof SIGN_IN)[], halves: (typeof HALF)[]): WaysBack => ({
    vault: { kind: 'listed', copies, communityCopies: halves },
    communities: [NOW_HERE],
    pending: [],
});

const stays = (copyKnown: boolean, communityOnly: boolean, reason = "it didn't answer: check your connection") =>
    ({ kind: 'vault-copy-stays', reason, copyKnown, communityOnly }) as Extract<DeleteOutcome, { kind: 'vault-copy-stays' }>;

/** A copy the line says stays, and its Remove on the screen: the button's name, and what tapping it (then Remove) removes. */
interface CopyLeft { kind: string; button: string; removes: unknown }
const HALF_LEFT: CopyLeft = {
    kind: "the half kept for the deleted community's admins (stray)",
    button: `Remove ${WAYS_BACK_LINES.vaultHalfStray}`,
    removes: ['vault-half', HALF.ref],
};
const SIGN_IN_LEFT: CopyLeft = { kind: "a sign-in's copy", button: "Remove the Google copy at BeanPool's key vault", removes: ['vault', 'google'] };

/** The web app's line (apps/pwa/src/lib/delete-here.ts WEB_VAULT_COPY_LINE), read from its source: the web app's modules don't load here. */
function webLine(): string {
    const m = joined(path.join(PWA, 'src/lib/delete-here.ts')).match(/export const WEB_VAULT_COPY_LINE =\s*['"](.*?)['"];/s);
    expect(m, 'WEB_VAULT_COPY_LINE in apps/pwa/src/lib/delete-here.ts').toBeTruthy();
    return m![1];
}

/**
 * The table. `line` is what the member reads (in English; its catalog keys are `keys`), `left` the copies the line says
 * stay, `state` what "Where your account can be brought back from" then lists.
 */
const ROWS: { name: string; line: () => string; keys: () => { at: 'native' | 'pwa'; key: string; path: boolean }[]; left: CopyLeft[]; state: WaysBack }[] = [
    {
        name: "the admins' half alone (the phone knows only it, 'c')",
        line: () => vaultCopyStaysLine('Riverside', stays(true, true)),
        keys: () => [{ at: 'native', key: vaultCopyStaysLine('{here}', stays(true, true, '{reason}')), path: true }],
        left: [HALF_LEFT],
        state: left([], [HALF]),
    },
    {
        name: "a sign-in's copy the phone knows of, and any half beside it",
        line: () => vaultCopyStaysLine('Riverside', stays(true, false)),
        keys: () => [
            { at: 'native', key: vaultCopyStaysLine('{here}', stays(true, false, '{reason}')).slice(0, -(ADMINS_HALF_STAYS_TOO.length + 1)), path: true },
            { at: 'native', key: ADMINS_HALF_STAYS_TOO, path: false },
        ],
        left: [SIGN_IN_LEFT, HALF_LEFT],
        state: left([SIGN_IN], [HALF]),
    },
    {
        name: "a sign-in's copy the phone doesn't know of (restored with the 12 words), and any half beside it",
        line: () => vaultCopyStaysLine('Riverside', stays(false, false)),
        keys: () => [
            { at: 'native', key: vaultCopyStaysLine('{here}', stays(false, false, '{reason}')).slice(0, -(ADMINS_HALF_STAYS_TOO.length + 1)), path: true },
            { at: 'native', key: ADMINS_HALF_STAYS_TOO, path: false },
        ],
        left: [SIGN_IN_LEFT, HALF_LEFT],
        state: left([SIGN_IN], [HALF]),
    },
    {
        name: "the web app's delete, where the phone app put a sign-in's copy",
        line: webLine,
        keys: () => [{ at: 'pwa', key: webLine(), path: true }],
        left: [SIGN_IN_LEFT],
        state: left([SIGN_IN], []),
    },
];

/** The path's steps, each the screen's own word, read where the member taps it. */
function screenSteps(): string[] {
    // The header's Settings button (components/GlobalHeader.tsx: the Settings tab itself is hidden, href: null).
    const header = read(path.join(NATIVE, 'components/GlobalHeader.tsx'));
    const at = header.indexOf("accessibilityLabel={t('Settings')}");
    expect(at, "GlobalHeader's Settings button").toBeGreaterThan(-1);
    expect(header.slice(at, at + 600), 'it opens Settings').toContain("router.push('/(tabs)/settings')");
    // Settings' Account Protection row, and, in it, the row that opens "Where your account can be brought back from".
    const settings = read(path.join(NATIVE, 'app/(tabs)/settings.tsx'));
    expect(settings).toMatch(/onPress=\{\(\) => \{ setMode\('protection'\); \}\}[^]{0,300}\{t\("Account Protection"\)\}/);
    expect(settings).toMatch(/onPress=\{\(\) => router\.push\('\/ways-back'\)\}[^]{0,200}\{t\('Where your account can be brought back from'\)\}/);
    expect(WAYS_BACK_LINES.title).toBe('Where your account can be brought back from');
    return ['Settings', 'Account Protection', WAYS_BACK_LINES.title, WAYS_BACK_LINES.remove];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Between two steps: an arrow (← where a right-to-left language writes one), with the quote marks a language puts round a step. */
const SEP = '[」”"]?\\s*[→←]\\s*[「“"]?';
const arrows = (s: string) => (s.match(/[→←]/g) ?? []).length;

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => { alerts.shown.length = 0; fx.removed.length = 0; me.identity.mnemonic = 'apple banana cherry delta eagle fabric garden hollow island jungle kettle lemon'.split(' '); setLanguage('en'); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; setLanguage('en'); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(WaysBackScreen)) as any); });
    await settle();
}
const all = (sel: string) => Array.from(host!.querySelectorAll(sel)) as HTMLElement[];

describe('a copy the key vault kept after a delete: the words name one path, and its screen offers Remove for that copy (review of #3369)', () => {
    it("the path is the screen's own words, step by step", () => {
        // In English each step is its catalog key, as the screen shows it.
        expect(VAULT_COPIES_REMOVE_PATH).toBe(screenSteps().join(' → '));
    });

    for (const row of ROWS) {
        describe(row.name, () => {
            it('names that one path, and no other way out (never Account Protection → Remove or → Disconnect)', () => {
                const line = row.line();
                expect(line.split(VAULT_COPIES_REMOVE_PATH).length - 1, line).toBe(1);
                expect(arrows(line), line).toBe(3);
                expect(line).not.toMatch(/Disconnect/);
            });

            for (const rule of ['vault', 'community', 'none']) {
                it(`at a community whose copies go to ${rule === 'vault' ? "BeanPool's key vault" : rule === 'community' ? 'its own server' : 'nowhere'}: the screen lists each copy with that Remove, and it removes that copy`, async () => {
                    fx.ways = row.state;
                    fx.rule = rule;
                    await mount();
                    const [, , listTitle, button] = screenSteps();
                    expect(all('[role="heading"]').map((h) => h.textContent)).toContain(listTitle);
                    for (const copy of row.left) {
                        const remove = all('button').find((b) => b.getAttribute('aria-label') === copy.button);
                        expect(remove, `${copy.kind}: its Remove`).toBeTruthy();
                        expect(remove!.textContent, `${copy.kind}: the word on its button`).toBe(button);
                        fx.removed.length = 0;
                        await act(async () => { remove!.click(); });
                        await settle();
                        const ask = alerts.shown.at(-1)!;
                        const go = ask.buttons.find((b) => b.text === button);
                        expect(go, `${copy.kind}: the confirm offers ${button}: ${ask.buttons.map((b) => b.text).join(', ')}`).toBeTruthy();
                        await act(async () => { go!.onPress?.(); });
                        await settle();
                        expect(fx.removed, copy.kind).toEqual([copy.removes]);
                    }
                });
            }

            it("every catalog's draft names the same path in that catalog's own words (the phone's, for the web app's line too)", () => {
                const dirs = { native: path.join(NATIVE, 'words'), pwa: path.join(PWA, 'words') };
                const langs = fs.readdirSync(dirs.native).filter((f) => /^[a-zA-Z-]+\.json$/.test(f)).map((f) => f.replace('.json', ''));
                expect(langs).toHaveLength(24);
                for (const lang of langs) {
                    const phone: Record<string, string> = JSON.parse(read(path.join(dirs.native, `${lang}.json`)));
                    const steps = screenSteps().map((s) => phone[s]);
                    steps.forEach((s, i) => expect(s, `${lang}: the phone's word for step ${i + 1}`).toBeTruthy());
                    for (const { at, key, path: names } of row.keys()) {
                        const draft: string | undefined = JSON.parse(read(path.join(dirs[at], `${lang}.json`)))[key];
                        expect(draft, `${lang} ${at}: a draft of ${JSON.stringify(key.slice(0, 70))}`).toBeTruthy();
                        if (!names) {
                            // Its screen is the one the sentence before it names.
                            expect(arrows(draft!), `${lang} ${at}: ${draft}`).toBe(0);
                            continue;
                        }
                        expect(arrows(draft!), `${lang} ${at}: one path of four steps in ${draft}`).toBe(3);
                        expect(draft, `${lang} ${at}: the path in the catalog's own words`).toMatch(new RegExp(steps.map(esc).join(SEP)));
                    }
                }
            });
        });
    }
});
