/**
 * Which screen `/chat/:id` draws (utils/chat-route.ts, app/chat/[id].tsx ChatRoute): a held group first, then a known DM,
 * and never a view that posts without asking the key memory when it couldn't be read (confirmation 2 of #1788, findings
 * 1, 2 and 4).
 */
import { describe, it, expect, vi } from 'vitest';
import { chatRouteView, askHeldGroup, askKnownDm, askRouteKind, screenIdOf, type ChatRouteFacts, type ChatRouteAsks } from '../chat-route';

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
        isHeldGroupChat: vi.fn(async () => false), isKnownDmConversation: vi.fn(async () => false), getConversationKind: vi.fn(async () => null), ...o,
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

    it('a known-DM check that throws is false', async () => {
        expect(await askKnownDm(asks({ isKnownDmConversation: vi.fn(async () => { throw new Error('x'); }) }), 'd')).toBe(false);
        expect(await askKnownDm(asks({ isKnownDmConversation: vi.fn(async () => true) }), 'd')).toBe(true);
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
