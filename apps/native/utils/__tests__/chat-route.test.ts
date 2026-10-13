/**
 * Which screen `/chat/:id` draws (utils/chat-route.ts, app/chat/[id].tsx ChatRoute): a held group first, then a known DM,
 * and never a view that posts without asking the key memory when it couldn't be read (confirmation 2 of #1788, findings
 * 1, 2 and 4).
 */
import { describe, it, expect } from 'vitest';
import { chatRouteView, type ChatRouteFacts } from '../chat-route';

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
