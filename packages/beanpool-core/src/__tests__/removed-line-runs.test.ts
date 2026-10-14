import { afterEach, describe, expect, it } from 'vitest';
import { isCollapsedRun, isLockedAwayLine, lockedAwayLineText, removedLineRuns, removedRunText, type RemovedLineKind } from '../removed-line-runs.js';
import { pluralKey, setLanguage } from '../words.js';

const kinds = (s: string) => [...s].map((c, i) => ({ id: `l${i}`, kind: (c === 'c' ? 'convenor' : c === 'a' ? 'author' : null) as RemovedLineKind | null }));
const shape = (s: string) => removedLineRuns(kinds(s), (l) => l.kind).map((r) => `${r.kind ?? 'line'}×${r.lines.length}`);

describe('removed lines in a row are one line', () => {
    afterEach(() => setLanguage('en'));

    it('eleven in a row are one run of eleven; a real line between breaks a run; kinds never mix', () => {
        expect(shape('ccccccccccc')).toEqual(['convenor×11']);
        expect(shape('cc.ccc')).toEqual(['convenor×2', 'line×1', 'convenor×3']);
        expect(shape('ccaac')).toEqual(['convenor×2', 'author×2', 'convenor×1']);
        expect(shape('..')).toEqual(['line×1', 'line×1']);
        const runs = removedLineRuns(kinds('.c.cc'), (l) => l.kind);
        expect(runs.map(isCollapsedRun)).toEqual([false, false, false, true]);
        expect(runs[3].lines.map((l) => l.id)).toEqual(['l3', 'l4']);
    });

    it('a line removed when the chat was locked is told by the node\'s marker, both halves of it', () => {
        expect(isLockedAwayLine({ removed: true, removedBy: 'SYSTEM', lockedAway: true })).toBe(true);
        // A member's own metadata may carry lockedAway into a convenor's removal: removedBy is the node's alone.
        expect(isLockedAwayLine({ removed: true, removedBy: 'ab'.repeat(32), lockedAway: true })).toBe(false);
        expect(isLockedAwayLine({ removed: true, removedBy: 'SYSTEM' })).toBe(false);
        expect(isLockedAwayLine(null)).toBe(false);
        expect(isLockedAwayLine('{"removedBy":"SYSTEM","lockedAway":true}')).toBe(false);
        expect(lockedAwayLineText()).toBe('An earlier message was removed when this chat was locked');
        expect(removedRunText('locked', 11)).toBe('11 earlier messages removed when this chat was locked');
    });

    it('the count sentence in English', () => {
        expect(removedRunText('convenor', 11)).toBe('11 messages removed by a convenor');
        expect(removedRunText('author', 2)).toBe('2 messages were deleted');
    });

    it('goes through the words layer: Russian and Arabic pick their plural forms', () => {
        const key = pluralKey('{n} message removed by a convenor', '{n} messages removed by a convenor');
        setLanguage('ru', [{ [key]: { one: '{n} сообщение удалено', few: '{n} сообщения удалены', many: '{n} сообщений удалено', other: '{n} сообщения удалено' } }]);
        expect(removedRunText('convenor', 11)).toBe('11 сообщений удалено');
        expect(removedRunText('convenor', 22)).toBe('22 сообщения удалены');
        // A Russian `one` holds 21 too: the singular form is reachable even though a run of 1 never collapses.
        expect(removedRunText('convenor', 21)).toBe('21 сообщение удалено');
        setLanguage('ar', [{ [key]: { zero: 'z{n}', one: 'o{n}', two: 't{n}', few: 'f{n}', many: 'm{n}', other: 'x{n}' } }]);
        expect([2, 3, 11, 100].map((n) => removedRunText('convenor', n))).toEqual(['t2', 'f3', 'm11', 'x100']);
        setLanguage('xx');
        expect(removedRunText('author', 3)).toMatch(/^\[.*3.*\]$/);
    });
});
