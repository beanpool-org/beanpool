/** Removed lines in a row are one line on the phone too (Marty, 15 Oct: "Yes, one line"). */
import { afterEach, describe, expect, it } from 'vitest';
import { pluralKey, setLanguage } from '@beanpool/core';
import {
    buildChatListItems, chatListIndexOf, isRemovedRun, removedRunLineText, tombstoneText, REMOVED_BY_CONVENOR_TEXT,
    type ChatMessage, type ChatRemovedRun,
} from '../chat-actions';

const NOW = new Date('2026-10-15T12:00:00Z');
let n = 0;
const line = (over: Partial<ChatMessage> = {}): ChatMessage => {
    n += 1;
    return { id: `m${n}`, text: `line ${n}`, senderId: 'ben', timestamp: `10:${String(n).padStart(2, '0')}`, rawTimestamp: '2026-10-15T10:00:00Z', ...over } as ChatMessage;
};
const removed = () => line({ type: 'removed', text: '', metadata: { removed: true, removedBy: 'ana' } });
const deleted = () => line({ type: 'removed', text: '', metadata: { removed: true, removedBy: 'ben' } });
/** The list as drawn, oldest first, without the day pill. */
const drawn = (msgs: ChatMessage[], kind: 'group' | 'event' = 'group') =>
    buildChatListItems(msgs, NOW, kind).reverse().filter((i) => (i as any).type !== 'day-separator');
const words = (msgs: ChatMessage[], kind: 'group' | 'event' = 'group') =>
    drawn(msgs, kind).map((i) => (isRemovedRun(i) ? removedRunLineText(i) : (i as ChatMessage).type === 'removed' ? tombstoneText(i as ChatMessage, kind) : (i as ChatMessage).text));

describe('removed lines in a row on the phone', () => {
    afterEach(() => setLanguage('en'));

    it('eleven in a row: one row that counts them, keyed by the first line, and every line still found for a reply', () => {
        const msgs = Array.from({ length: 11 }, removed);
        const items = drawn(msgs);
        expect(items).toHaveLength(1);
        const run = items[0] as ChatRemovedRun;
        expect(run).toMatchObject({ type: 'removed-run', id: msgs[0].id, kind: 'convenor', timestamp: msgs[10].timestamp });
        expect(run.lineIds).toEqual(msgs.map((m) => m.id));
        expect(removedRunLineText(run)).toBe('11 messages removed by a convenor');
        const list = buildChatListItems(msgs, NOW, 'group');
        for (const m of msgs) expect(list[chatListIndexOf(list, m.id)]).toEqual(run);
    });

    it('a real line between breaks the run; one alone keeps today\'s words; deletes join only deletes', () => {
        const msgs = [removed(), removed(), line({ text: 'Bring gloves' }), removed(), removed(), removed(), line({ text: 'See you' }), removed(), deleted(), deleted(), removed()];
        expect(words(msgs)).toEqual([
            '2 messages removed by a convenor', 'Bring gloves', '3 messages removed by a convenor', 'See you',
            REMOVED_BY_CONVENOR_TEXT, '2 messages were deleted', REMOVED_BY_CONVENOR_TEXT,
        ]);
    });

    it('only a group chat collapses (an event chat\'s removals are another reading)', () => {
        expect(drawn([removed(), removed()], 'event')).toHaveLength(2);
    });

    it('a day pill breaks a run', () => {
        const items = buildChatListItems([removed(), { ...removed(), rawTimestamp: '2026-10-14T10:00:00Z' }], NOW, 'group');
        expect(items.filter(isRemovedRun)).toHaveLength(0);
    });

    it('the count goes through the words layer: Russian and Arabic plural forms', () => {
        const run = drawn(Array.from({ length: 11 }, removed))[0] as ChatRemovedRun;
        const key = pluralKey('{n} message removed by a convenor', '{n} messages removed by a convenor');
        setLanguage('ru', [{ [key]: { one: '{n} сообщение удалено', few: '{n} сообщения удалены', many: '{n} сообщений удалено', other: '{n} сообщения удалено' } }]);
        expect(removedRunLineText(run)).toBe('11 сообщений удалено');
        setLanguage('ar', [{ [key]: { zero: 'z{n}', one: 'o{n}', two: 't{n}', few: 'f{n}', many: 'm{n}', other: 'x{n}' } }]);
        expect(removedRunLineText(run)).toBe('m11');
        expect(removedRunLineText({ ...run, lineIds: run.lineIds.slice(0, 3) })).toBe('f3');
    });
});
