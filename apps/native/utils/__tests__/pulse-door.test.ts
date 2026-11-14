/**
 * The Pulse lives behind the Market's door (scratch/fable-design/DESIGN-pulse-home-fable.md §3.1, P2): while it is open the
 * Market tab stays lit, so the member knows where they are and the tab takes them back to the Market.
 */
import { describe, expect, it } from 'vitest';
import { marketTabLit } from '../pulse-door';

describe('the Market tab while the Pulse is open (P2)', () => {
    it('lit on the Market and on the Pulse; not on another screen', () => {
        expect(marketTabLit(true, '/market')).toBe(true);
        expect(marketTabLit(false, '/pulse')).toBe(true);
        expect(marketTabLit(false, '/')).toBe(false);
        expect(marketTabLit(false, '/chats')).toBe(false);
        expect(marketTabLit(false, '/pulse-intake')).toBe(false);
        expect(marketTabLit(false, null)).toBe(false);
    });
});
