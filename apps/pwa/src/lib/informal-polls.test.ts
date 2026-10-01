import { describe, it, expect } from 'vitest';
import { pollsInformal, INFORMAL_POLL_NOTE } from './informal-polls';

describe('informal polls', () => {
    it('are the global community\'s', () => {
        expect(pollsInformal({ profile: 'global' } as any)).toBe(true);
    });

    it('are not a local community\'s, nor a node that says nothing, nor an answer that never came', () => {
        expect(pollsInformal({ profile: 'local' } as any)).toBe(false);
        expect(pollsInformal({} as any)).toBe(false);
        expect(pollsInformal(null)).toBe(false);
        expect(pollsInformal(undefined)).toBe(false);
    });

    it('say they decide nothing', () => {
        expect(INFORMAL_POLL_NOTE).toBe('An informal poll; it decides nothing');
    });
});
