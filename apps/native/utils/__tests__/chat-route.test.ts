/**
 * Which screen `/chat/:id` draws (utils/chat-route.ts, app/chat/[id].tsx ChatRoute): a held group first, then a known DM,
 * and never a view that posts without asking the key memory when it couldn't be read (confirmation 2 of #1788, findings
 * 1, 2 and 4).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chatRouteView, askHeldGroup, askKnownDm, askRouteKind, screenIdOf, routeChat, type ChatRouteFacts, type ChatRouteAsks } from '../chat-route';

const facts = (f: Partial<ChatRouteFacts>): ChatRouteFacts => ({ held: false, knownDm: false, isEventChat: false, threadKind: null, ...f });

describe('chatRouteView', () => {
    it('draws nothing until the key memory has answered, a known DM included', () => {
        expect(chatRouteView(facts({ held: null, knownDm: true }))).toBe('wait');
        expect(chatRouteView(facts({ held: null, knownDm: false, threadKind: 'group' }))).toBe('wait');
        expect(chatRouteView(facts({ held: false, knownDm: null }))).toBe('wait');
    });

    it('a held group opens in its group chat whatever else is said: a DM label, an event or enterprise link, or no row', () => {
        for (const f of [
            facts({ held: true }),
            facts({ held: true, knownDm: true }),
            facts({ held: true, knownDm: null }),
            facts({ held: true, isEventChat: true }),
            facts({ held: true, threadKind: 'enterprise' }),
        ]) expect(chatRouteView(f)).toBe('group');
    });

    it('a known DM that was never held opens in the DM screen, whatever a link or its type says', () => {
        expect(chatRouteView(facts({ knownDm: true }))).toBe('dm');
        expect(chatRouteView(facts({ knownDm: true, isEventChat: true }))).toBe('dm');
        expect(chatRouteView(facts({ knownDm: true, threadKind: 'group' }))).toBe('dm');
        expect(chatRouteView(facts({ knownDm: true, threadKind: 'enterprise' }))).toBe('dm');
    });

    it('when the key memory could not be read, never the event chat or the enterprise thread (they post without asking it)', () => {
        expect(chatRouteView(facts({ held: 'error', isEventChat: true }))).toBe('dm');
        expect(chatRouteView(facts({ held: 'error', threadKind: 'enterprise' }))).toBe('dm');
        expect(chatRouteView(facts({ held: 'error', threadKind: 'group' }))).toBe('group_thread');
        expect(chatRouteView(facts({ held: 'error', knownDm: true }))).toBe('dm');
        expect(chatRouteView(facts({ held: 'error' }))).toBe('dm');
    });

    it('otherwise: an event chat, a group\'s or an enterprise\'s thread, else a DM', () => {
        expect(chatRouteView(facts({ isEventChat: true }))).toBe('event');
        expect(chatRouteView(facts({ threadKind: 'group' }))).toBe('group_thread');
        expect(chatRouteView(facts({ threadKind: 'enterprise' }))).toBe('enterprise_thread');
        expect(chatRouteView(facts({}))).toBe('dm');
    });
});

/** ChatRoute's three wirings to utils/db.ts (#1815 review, finding 3: M21–M23). */
describe('ChatRoute asks', () => {
    const asks = (o: Partial<ChatRouteAsks>): ChatRouteAsks => ({
        isHeldGroupChat: vi.fn(async () => false), knownDmConversationId: vi.fn(async () => null), getConversationKind: vi.fn(async () => null), ...o,
    });

    it('a held check that throws (the key memory unread) is \'error\', never "not held"; the route then draws no event chat or enterprise thread', async () => {
        const a = asks({ isHeldGroupChat: vi.fn(async () => { throw new Error("This phone couldn't check this chat's keys just now."); }) });
        const held = await askHeldGroup(a, 'g');
        expect(held).toBe('error');
        expect(chatRouteView(facts({ held, isEventChat: true }))).toBe('dm');
        expect(chatRouteView(facts({ held, threadKind: 'enterprise' }))).toBe('dm');
        expect(await askHeldGroup(asks({ isHeldGroupChat: vi.fn(async () => true) }), 'g')).toBe(true);
        expect(await askHeldGroup(asks({}), 'g')).toBe(false);
    });

    it('a known-DM check that throws is no known DM; a known DM answers the spelling the phone keeps it under', async () => {
        expect(await askKnownDm(asks({ knownDmConversationId: vi.fn(async () => { throw new Error('x'); }) }), 'd')).toBe(null);
        expect(await askKnownDm(asks({ knownDmConversationId: vi.fn(async () => 'D') }), 'd')).toBe('D');
        expect(await askKnownDm(asks({}), 'd')).toBe(null);
    });

    it('the kind is asked with askNode (no row yet: the node is asked), and each type maps to its screen', async () => {
        const getConversationKind = vi.fn(async (_id: string, _o: { askNode?: boolean }) => 'group_thread');
        expect(await askRouteKind(asks({ getConversationKind }), 'g')).toBe('group');
        expect(getConversationKind).toHaveBeenCalledWith('g', { askNode: true });
        for (const [kind, want] of [['event_thread', 'event'], ['enterprise_thread', 'enterprise'], ['dm', null], [null, null]] as const) {
            expect(await askRouteKind(asks({ getConversationKind: vi.fn(async () => kind) }), 'g')).toBe(want);
        }
    });

    it('the node-readable screens get the id lower-cased (a link or a push may carry it in capitals)', () => {
        const g = '3F2B9C1E-7A4D-4E8B-9C0D-1A2B3C4D5E6F';
        expect(screenIdOf(g)).toBe(g.toLowerCase());
    });
});

/** One route function asks every fact of one id and hands the screen that id (#1841 review, findings 1 and 4). */
describe('routeChat', () => {
    const G = '3F2B9C1E-7A4D-4E8B-9C0D-1A2B3C4D5E6F';
    const g = G.toLowerCase();
    const asks = (o: Partial<ChatRouteAsks>): ChatRouteAsks => ({
        isHeldGroupChat: vi.fn(async () => false), knownDmConversationId: vi.fn(async () => null), getConversationKind: vi.fn(async () => null), ...o,
    });

    it('asks the held check, the DM guard and the kind of the id lower-cased, however the link spelled it', async () => {
        const a = asks({});
        await routeChat(a, G, {});
        expect(a.isHeldGroupChat).toHaveBeenCalledWith(g);
        expect(a.knownDmConversationId).toHaveBeenCalledWith(g);
        expect(a.getConversationKind).toHaveBeenCalledWith(g, { askNode: true });
        for (const f of [a.isHeldGroupChat, a.knownDmConversationId, a.getConversationKind] as any[]) expect(f.mock.calls.every((c: any[]) => c[0] === g)).toBe(true);
    });

    it('a DM known under another spelling: a push for its id in capitals with group=1 draws the DM screen, on the phone\'s spelling', async () => {
        const a = asks({ knownDmConversationId: vi.fn(async (id: string) => (id === g ? g : null)) });
        expect(await routeChat(a, G, { thread: 'group' })).toEqual({ view: 'dm', screenId: g });
    });

    it('a known DM is one conversation whatever the link\'s case: its kind is asked of the spelling the phone keeps it under, and its DM screen gets that spelling (#1841 confirmation 1, C3 and C4)', async () => {
        // C4: a DM the node minted in capitals, opened from the Inbox as /chat/<D>.
        const minted = asks({ knownDmConversationId: vi.fn(async (id: string) => (id.toLowerCase() === g ? G : null)), getConversationKind: vi.fn(async () => 'dm') });
        expect(await routeChat(minted, G, {})).toEqual({ view: 'dm', screenId: G });
        expect(minted.getConversationKind).toHaveBeenCalledWith(G, { askNode: true });
        expect((minted.getConversationKind as any).mock.calls.every((c: any[]) => c[0] === G)).toBe(true);
        // C3: an honest DM (lower-case), a push for /chat/<its id in capitals>, with and without group=1.
        const honest = asks({ knownDmConversationId: vi.fn(async (id: string) => (id.toLowerCase() === g ? g : null)) });
        expect(await routeChat(honest, G, {})).toEqual({ view: 'dm', screenId: g });
        expect(await routeChat(honest, G, { thread: 'group' })).toEqual({ view: 'dm', screenId: g });
        expect((honest.getConversationKind as any).mock.calls.every((c: any[]) => c[0] === g)).toBe(true);
        // A held group stays its group screen on its own id, whatever DM the phone also knows under its id (C1).
        expect(await routeChat(asks({ isHeldGroupChat: vi.fn(async () => true), knownDmConversationId: vi.fn(async () => G) }), G, {})).toEqual({ view: 'group', screenId: g });
    });

    it('a group\'s, an event\'s or an enterprise\'s screen gets the id lower-cased; the DM screen of an id the phone knows no DM by keeps the link\'s spelling', async () => {
        expect(await routeChat(asks({ isHeldGroupChat: vi.fn(async () => true) }), G, {})).toEqual({ view: 'group', screenId: g });
        expect(await routeChat(asks({}), G, { thread: 'group' })).toEqual({ view: 'group_thread', screenId: g });
        expect(await routeChat(asks({}), G, { event: true })).toEqual({ view: 'event', screenId: g });
        expect(await routeChat(asks({}), G, { thread: 'enterprise' })).toEqual({ view: 'enterprise_thread', screenId: g });
        expect(await routeChat(asks({ getConversationKind: vi.fn(async () => 'group_thread') }), G, {})).toEqual({ view: 'group_thread', screenId: g });
        expect(await routeChat(asks({}), G, {})).toEqual({ view: 'dm', screenId: G });
    });

    it('a link that says the kind is not second-guessed by the conversation\'s type; a held check that throws is "error" (the DM screen, never an event chat)', async () => {
        const a = asks({});
        await routeChat(a, G, { event: true });
        await routeChat(a, G, { thread: 'group' });
        expect(a.getConversationKind).not.toHaveBeenCalled();
        const failing = asks({ isHeldGroupChat: vi.fn(async () => { throw new Error('unread'); }) });
        expect((await routeChat(failing, G, { event: true })).view).toBe('dm');
        expect((await routeChat(failing, G, { thread: 'group' })).view).toBe('group_thread');
    });

    it('never rejects: a kind lookup that throws counts as no kind', async () => {
        const a = asks({ getConversationKind: vi.fn(async () => { throw new Error('x'); }) });
        expect(await routeChat(a, G, {})).toEqual({ view: 'dm', screenId: G });
    });
});

/** The screens only render what routeChat answers, and open keys through the DM guard (#1841 review, findings 1 and 4). */
describe('the screens\' wiring', () => {
    const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf-8');
    const route = read('app/chat/[id].tsx');
    const chatRoute = route.slice(route.indexOf('export default function ChatRoute()'), route.indexOf('function ChatScreen('));

    it('ChatRoute asks routeChat once, with the link\'s kind, and asks no fact itself', () => {
        expect(chatRoute).toMatch(/routeChat\(ROUTE_ASKS, String\(id\), \{ event: event === '1', thread: group === '1' \? 'group' : enterprise === '1' \? 'enterprise' : null \}\)/);
        expect(route).toMatch(/const ROUTE_ASKS: ChatRouteAsks = \{ isHeldGroupChat, knownDmConversationId, getConversationKind \};/);
        expect(chatRoute).not.toMatch(/isHeldGroupChat\(|isKnownDmConversation\(|knownDmConversationId\(|getConversationKind\(|askHeldGroup|askKnownDm|askRouteKind/);
    });

    it('every node-readable screen gets routeChat\'s id, and only an answer for this id draws', () => {
        expect(chatRoute).toMatch(/if \(!id \|\| !route \|\| route\.for !== String\(id\)\) return null;/);
        expect(chatRoute.match(/<GroupChatView kind="group" id=\{screenId\}/g)?.length).toBe(1);
        expect(chatRoute).toMatch(/<EventChatView eventId=\{screenId\} \/>/);
        expect(chatRoute).toMatch(/<GroupChatView kind="enterprise" id=\{screenId\}/);
        expect(chatRoute).not.toMatch(/id=\{(?!screenId\})|eventId=\{(?!screenId\})/);
    });

    it('the DM screen gets routeChat\'s id too, and never reads the link\'s spelling itself', () => {
        expect(chatRoute).toMatch(/return <ChatScreen id=\{screenId\} \/>;/);
        const dmScreen = route.slice(route.indexOf('function ChatScreen('));
        expect(dmScreen).toMatch(/^function ChatScreen\(\{ id \}: \{ id: string \}\) \{/);
        expect(dmScreen).not.toMatch(/useLocalSearchParams<\{ id\?|const \{ id[,\s]/);
    });

    it('the DM screen\'s send keeps the typed words when the line is refused (the store unread, or not locked)', () => {
        expect(route).toMatch(/const refused = refusedSendNotice\(err, peerPubkey \? peerName : null\);\s*if \(refused\) \{[\s\S]{0,400}?composerRef\.current\?\.setText\(restoredDraft\(currentDraft,/);
    });

    it('the group screen opens its keyring through the DM guard (groupScreenKeyringFor), never groupKeyringFor', () => {
        const view = read('components/GroupChatView.tsx');
        expect(view).toMatch(/groupScreenKeyringFor\(id\)\s*\.then\(async ring =>/);
        expect(view).not.toMatch(/groupKeyringFor\b/);
    });
});
