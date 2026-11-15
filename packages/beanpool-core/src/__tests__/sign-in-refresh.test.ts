/**
 * signInsToRefresh (recovery S4): the sign-ins Account Protection offers to Refresh, from the status answer alone, on the
 * phone and on the web. The server's half (which copies are findable) is apps/server/src/test-recovery-findable.ts, which
 * runs every kind of copy through the real route and then through this function.
 */
import { describe, expect, it } from 'vitest';
import { signInsToRefresh } from '../sign-in-refresh';

describe('signInsToRefresh', () => {
    it.each([
        ['a copy the server can find: nothing to refresh', { enrolledSso: ['google'], findableSso: ['google'] }, []],
        ['a copy it cannot find yet: that sign-in', { enrolledSso: ['google'], findableSso: [] }, ['google']],
        ['two sign-ins, one findable: the other only', { enrolledSso: ['google', 'facebook'], findableSso: ['facebook'] }, ['google']],
        ['no sign-in: nothing', { enrolledSso: [], findableSso: [] }, []],
        ['each once, in the server\'s order', { enrolledSso: ['facebook', 'google', 'facebook'], findableSso: [] }, ['facebook', 'google']],
        ['a server from before S4 (no findableSso): nothing, never a guess', { enrolledSso: ['google'] }, []],
        ['findableSso not a list: nothing', { enrolledSso: ['google'], findableSso: 'google' }, []],
        ['enrolledSso not a list: nothing', { enrolledSso: null, findableSso: [] }, []],
        ['entries that are not names are skipped', { enrolledSso: ['google', 7, '', null], findableSso: [7] }, ['google']],
    ])('%s', (_label, status, expected) => {
        expect(signInsToRefresh(status)).toEqual(expected);
    });

    it.each([[null], [undefined], ['<html>a proxy page</html>'], [42], [[]]])('no status answer (%j): nothing', (status) => {
        expect(signInsToRefresh(status)).toEqual([]);
    });
});
