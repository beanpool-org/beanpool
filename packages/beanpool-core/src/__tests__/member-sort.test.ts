/**
 * The Community list's sorts, shared by the phone and the web app (member-sort.ts): the phone's five, in its order, with
 * its words, so one catalog entry (core's) serves both apps.
 */
import { describe, it, expect } from 'vitest';
import { MEMBER_SORTS, MEMBER_SORT_WORDS, wordKey } from '../index.js';

describe('member sorts', () => {
    it('are the phone’s five, Newest first, in its order', () => {
        expect(MEMBER_SORTS).toEqual(['newest', 'name', 'friends', 'trusted', 'active']);
    });

    it('carry the phone’s words, each with the "member sort" context', () => {
        expect(MEMBER_SORT_WORDS).toEqual({
            newest: wordKey('Newest', 'member sort'),
            name: wordKey('Name', 'member sort'),
            friends: wordKey('Friends', 'member sort'),
            trusted: wordKey('Trusted', 'member sort'),
            active: wordKey('Active', 'member sort'),
        });
    });
});
