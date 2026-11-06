// @vitest-environment jsdom
/**
 * Home's "A chat" card on the phone (components/home/ChatBody.tsx) and its settings list (CardSettingsSheet.tsx), drawn
 * for real: react-dom in jsdom, React Native's host components as plain tags (as card-settings-tags-render.test.ts does).
 * The card's lines are opened on the phone by the doors handed to it and drawn from its memory; a tap opens the chat; a
 * gone chat offers Remove; the list picks a chat and refuses one another card holds (DESIGN-home-chosen-chat-fable.md §2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, disabled, testID, value, onChangeText, accessibilityLabel } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (disabled) attrs['data-disabled'] = 'true';
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        Modal: ({ children, visible }: any) => (visible ? createElement('div', null, children) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
    };
});
const pushed = vi.hoisted(() => [] as unknown[]);
/** The screen's focus, as react-navigation keeps it: Home at the front, or left for another tab. */
const nav = vi.hoisted(() => ({ focused: true, subs: new Set<() => void>() }));
const setFocused = async (on: boolean) => { await act(async () => { nav.focused = on; nav.subs.forEach(s => s()); }); await act(async () => { await Promise.resolve(); }); };
// useFocusEffect as react-navigation runs it: on a focused screen the callback runs again whenever it changes, and its
// cleanup runs when the screen is left.
vi.mock('expo-router', async () => {
    const React = await import('react');
    return {
        router: { push: (h: unknown) => pushed.push(h) },
        useFocusEffect: (cb: () => void | (() => void)) => {
            const [focused, setF] = React.useState(nav.focused);
            React.useEffect(() => { const s = () => setF(nav.focused); nav.subs.add(s); return () => { nav.subs.delete(s); }; }, []);
            React.useEffect(() => { if (!focused) return; const c = cb(); return typeof c === 'function' ? c : undefined; }, [cb, focused]);
        },
    };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../../components/useModalKeyboardLift', () => ({ useModalKeyboardLift: () => ({ maxHeight: 500, lift: 0 }) }));
vi.mock('../../components/home/HomeParts', async () => {
    const { createElement: h } = await import('react');
    return {
        HOME_TARGET_DP: 48,
        homeStyles: () => ({ chips: {}, chip: {}, chipOn: {}, chipText: {}, chipTextOn: {}, buttonRow: {}, pressed: {} }),
        HomeButton: ({ text, onPress, testID }: any) => h('button', { onClick: onPress, 'data-testid': testID }, text),
    };
});
vi.mock('../../components/home/sheet-parts', () => ({ sheetStyles: { backdrop: {}, sheet: {}, head: {}, title: {}, done: {}, doneText: {}, list: {} } }));
vi.mock('../../constants/categories', () => ({ POST_CATEGORIES: [], categoryLabel: (id: string) => id }));

import { ChatBody } from '../../components/home/ChatBody';
import { CardSettingsSheet } from '../../components/home/CardSettingsSheet';
import { darkColors, lightColors, type AppColors } from '../../constants/colors';
import type { HomeChatCard } from '@beanpool/core';
import type { HomeChatOpenDeps } from '../home-chat-open';
import { chatPickList } from '../home-chat';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); pushed.length = 0; });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const press = async (id: string) => { await act(async () => { byId(id)!.click(); }); };

const ME = 'a'.repeat(64);
const ANA = 'b'.repeat(64);
const inst = { id: 'chat-abcd', type: 'chat', settings: { conversationId: 'dm-1', kind: 'dm', name: 'Ana Reyes' } };
const sealed = { ciphertext: 'c', nonce: 'x25519-xc20p-v2:n', metadata: null };
const now = Date.parse('2026-11-07T10:00:00Z');
const at = (min: number) => new Date(now - min * 60_000).toISOString();
/** The phone's DM judge as db.ts answers it: these lines opened (the words), any other not verified. */
const judge = (words: Record<string, string>): HomeChatOpenDeps['judgeDm'] => async (_c, lines) =>
    new Map(lines.map(l => [l.id, words[l.id] ? { text: words[l.id], format: 3 as const, after: null, mark: null } : { text: null, format: null, after: null, mark: 'not-verified' as const }]));
const deps = (words: Record<string, string>): HomeChatOpenDeps => ({ judgeDm: judge(words), keyring: async () => { throw new Error('no group here'); } });

async function drawCard(card: HomeChatCard | null, d: HomeChatOpenDeps, colors: AppColors = lightColors, extra: { onPick?: () => void; onRemove?: () => void } = {}) {
    await act(async () => {
        root.render(createElement(ChatBody, { inst, card, me: ME, colors, deps: d, now, onPick: extra.onPick ?? (() => {}), onRemove: extra.onRemove ?? (() => {}) }) as any);
    });
    await act(async () => { await Promise.resolve(); });
}

describe('the card, drawn (light and dark)', () => {
    const card: HomeChatCard = {
        kind: 'dm', name: 'Ana Reyes', unread: 2, muted: false, lines: [
            { id: 'l1', author: ANA, who: 'Ana', at: at(120), type: 'text', systemType: null, sealed },
            { id: 'l2', author: ME, who: 'Me', at: at(60), type: 'text', systemType: null, sealed },
            { id: 'l3', author: ANA, who: 'Ana', at: at(30), type: 'image', systemType: null, sealed },
        ],
    };

    for (const [theme, colors] of [['light', lightColors], ['dark', darkColors as unknown as AppColors]] as const) {
        it(`a DM's opened lines, "You" for the member's own, a photo as "📷 Photo", the new count (${theme})`, async () => {
            await drawCard(card, deps({ l1: 'Who has a ladder?', l2: "Mine's at the shed", l3: 'the fence' }), colors);
            expect(byId('home-chat-name-chat-abcd')!.textContent).toBe('Ana Reyes');
            expect(host.textContent).toContain('2 new');
            expect(byId('home-chat-line-chat-abcd-0')!.textContent).toBe('Ana, 2h ago: Who has a ladder?');
            expect(byId('home-chat-line-chat-abcd-1')!.textContent).toBe("You, 1h ago: Mine's at the shed");
            expect(byId('home-chat-line-chat-abcd-2')!.textContent).toBe('Ana, 30m ago: 📷 Photo');
            // The caption of the photo is never shown on Home, and nothing sealed is drawn as words.
            expect(host.textContent).not.toContain('the fence');
            expect(host.textContent).not.toContain('x25519');
        });
    }

    it('a tap opens the chat, told it is a DM', async () => {
        await drawCard(card, deps({}));
        await press('home-chat-chat-abcd');
        expect(pushed).toEqual([{ pathname: '/chat/[id]', params: { id: 'dm-1' } }]);
    });

    it('a line that doesn\'t open is nobody\'s; before anything opens, the lines are locked, never the bytes', async () => {
        await drawCard(card, deps({ l1: 'Who has a ladder?' }));
        expect(byId('home-chat-line-chat-abcd-1')!.textContent).toBe("🔒 This message couldn't be verified, so it isn't shown.");
        await drawCard(card, { judgeDm: async () => null, keyring: async () => { throw new Error('no'); } });
        expect(byId('home-chat-line-chat-abcd-0')!.textContent).toBe('🔒 Message');
    });

    it('gone: the sentence and Remove, with no name and no line; none picked: Pick a chat', async () => {
        const onRemove = vi.fn();
        await drawCard({ gone: 'left' }, deps({}), lightColors, { onRemove });
        expect(host.textContent).toContain("You're no longer in this chat.");
        expect(host.textContent).not.toContain('Ana');
        await press('home-chat-remove-chat-abcd');
        expect(onRemove).toHaveBeenCalledTimes(1);
        const onPick = vi.fn();
        await act(async () => {
            root.render(createElement(ChatBody, { inst: { ...inst, settings: {} }, card: null, me: ME, colors: lightColors, deps: deps({}), onPick, onRemove }) as any);
        });
        await press('home-chat-pick-chat-abcd');
        expect(onPick).toHaveBeenCalledTimes(1);
    });

    it('opens its lines once per change, not once per Home render (#2943 finding 4); again when Home comes back to the front', async () => {
        let opens = 0;
        const counted: HomeChatOpenDeps = { judgeDm: async (c, l) => { opens += 1; return judge({ l1: 'Who has a ladder?' })(c, l); }, keyring: async () => { throw new Error('no'); } };
        await drawCard(card, counted);
        expect(opens).toBe(1);
        // Home builds the card afresh on every render (chatCardFor): the same lines in a new object open nothing again.
        for (let i = 0; i < 5; i++) await drawCard(structuredClone(card), counted);
        expect(opens).toBe(1);
        expect(byId('home-chat-line-chat-abcd-0')!.textContent).toBe('Ana, 2h ago: Who has a ladder?');
        // New lines: one open.
        const more: HomeChatCard = { ...card, lines: [...card.lines, { id: 'l4', author: ANA, who: 'Ana', at: at(5), type: 'text', systemType: null, sealed }] };
        await drawCard(more, counted);
        await drawCard(structuredClone(more), counted);
        expect(opens).toBe(2);
        // Home left for Talk and back: one open (a key opened there meanwhile now reads the lines).
        await setFocused(false);
        expect(opens).toBe(2);
        await setFocused(true);
        expect(opens).toBe(3);
    });

    it('an empty chat says so', async () => {
        await drawCard({ kind: 'dm', name: 'Ana Reyes', unread: 0, muted: true, lines: [] }, deps({}));
        expect(byId('home-chat-name-chat-abcd')!.textContent).toBe('Ana Reyes 🔕');
        expect(byId('home-chat-note-chat-abcd')!.textContent).toBe('Nothing said here yet.');
        expect(host.textContent).not.toContain('new');
    });
});

describe('the settings list', () => {
    const rows = [
        { conversationId: 'g1', kind: 'group' as const, name: 'Garden crew', emoji: '🌻', at: at(5) },
        { conversationId: 'dm-1', kind: 'dm' as const, name: 'Ana', emoji: '👤', at: at(90) },
    ];
    async function open(settings: Record<string, unknown> | undefined, onHome: string[]) {
        const onDone = vi.fn();
        await act(async () => {
            root.render(createElement(CardSettingsSheet, {
                visible: true, type: 'chat', settings, mode: settings ? 'save' : 'add', colors: lightColors, onDone, onClose: () => {},
                chats: { rows, failed: false, onHome: new Set(onHome) },
            }) as any);
        });
        return onDone;
    }

    it('a chat picked is stored as its id, kind and name; one another card holds says On Home and can\'t be picked', async () => {
        const onDone = await open(undefined, ['dm-1']);
        expect(byId('card-settings-chat-dm-1')!.textContent).toContain('On Home');
        expect(byId('card-settings-chat-dm-1')!.getAttribute('data-disabled')).toBe('true');
        await press('card-settings-done');
        expect(onDone).not.toHaveBeenCalled();
        await press('card-settings-chat-g1');
        await press('card-settings-done');
        expect(onDone).toHaveBeenCalledWith({ conversationId: 'g1', kind: 'group', name: 'Garden crew' });
    });

    it('Settings… opens on the card\'s own chat, which is never "On Home" to itself', async () => {
        const onDone = await open({ conversationId: 'dm-1', kind: 'dm', name: 'Ana' }, []);
        await press('card-settings-done');
        expect(onDone).toHaveBeenCalledWith({ conversationId: 'dm-1', kind: 'dm', name: 'Ana' });
    });

    it('no filter box up to 8 rows; a read that failed says so', async () => {
        await open(undefined, []);
        expect(byId('card-settings-chats-filter')).toBeNull();
        await act(async () => {
            root.render(createElement(CardSettingsSheet, {
                visible: true, type: 'chat', mode: 'add', colors: lightColors, onDone: () => {}, onClose: () => {}, chats: { rows: null, failed: true, onHome: new Set<string>() },
            }) as any);
        });
        expect(byId('card-settings-chats-note')!.textContent).toBe("Couldn't load your chats. Try again.");
    });

    it('the node can\'t be reached (#2943 finding 3): "Couldn\'t load your chats", never "No chats yet." nor the DMs alone as the whole list', async () => {
        const dm = { id: 'dm-1', type: 'dm', peer: 'Ana', rawTimestamp: at(5), request: undefined };
        for (const phoneChats of [[dm], []]) {
            await act(async () => {
                root.render(createElement(CardSettingsSheet, {
                    visible: true, type: 'chat', mode: 'add', colors: lightColors, onDone: () => {}, onClose: () => {},
                    chats: { ...chatPickList(null, phoneChats), onHome: new Set<string>() },
                }) as any);
            });
            expect(byId('card-settings-chats-note')!.textContent, `${phoneChats.length} DMs`).toBe("Couldn't load your chats. Try again.");
            expect(host.textContent).not.toContain('No chats yet.');
            expect(byId('card-settings-chat-dm-1')).toBeNull();
        }
    });
});
