import { describe, expect, it } from 'vitest';
import { postRulesFor } from '../features.js';

describe('postRulesFor', () => {
    it('keeps every rule where Beans are on (a local community)', () => {
        expect(postRulesFor(true)).toEqual({ offerFirst: true, profilePhoto: true, needPhoto: true });
    });
    it('drops every rule where Beans are off (the global node)', () => {
        expect(postRulesFor(false)).toEqual({ offerFirst: false, profilePhoto: false, needPhoto: false });
    });
});
