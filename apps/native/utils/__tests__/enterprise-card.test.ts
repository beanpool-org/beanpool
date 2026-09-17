import { describe, it, expect } from 'vitest';
import { enterpriseCardStatus } from '../enterprise-card';

const base = { balance: 35.82, liveOffers: 2, goalAmount: null, currentAmount: null, lifecycle: 'ongoing', status: 'active', paused: false, keepers: [] };
const twoKeepers = [{ pubkey: 'a', callsign: 'A', role: 'lead' }, { pubkey: 'b', callsign: 'B', role: 'keeper' }];

describe('enterpriseCardStatus — what the Commons card says', () => {
    it('an active ongoing enterprise shows its live offers and keepers', () => {
        const s = enterpriseCardStatus({ ...base, keepers: twoKeepers });
        expect(s.stateBadge).toBeNull();
        expect(s.kindBadge).toBe('ongoing');
        expect(s.meta).toBe('2 live offers · 2 keepers');
    });

    it('a paused enterprise says so instead of only saying ONGOING', () => {
        // The screen-check bug: a paused enterprise's card read "ONGOING · 2 live offers".
        const s = enterpriseCardStatus({ ...base, paused: true, keepers: twoKeepers });
        expect(s.stateBadge).toBe('paused');
        expect(s.meta).toBe('Paused for season · 2 keepers');
    });

    it('winding up outranks paused, as on the web card', () => {
        const s = enterpriseCardStatus({ ...base, paused: true, status: 'winding_up' });
        expect(s.stateBadge).toBe('winding_up');
        expect(s.meta).toBe('Winding up');
    });

    it('a completed enterprise is closed', () => {
        const s = enterpriseCardStatus({ ...base, paused: true, status: 'completed' });
        expect(s.stateBadge).toBe('closed');
        expect(s.meta).toBe('Completed · Closed');
    });

    it('a bounded lifecycle with no goal still reads as a project', () => {
        expect(enterpriseCardStatus({ ...base, lifecycle: 'bounded' }).kindBadge).toBe('project');
    });

    it('a goal reached is funded; one short is a project', () => {
        expect(enterpriseCardStatus({ ...base, goalAmount: 100, currentAmount: 100 }).kindBadge).toBe('funded');
        const short = enterpriseCardStatus({ ...base, goalAmount: 100, currentAmount: 40 });
        expect(short.kindBadge).toBe('project');
        expect(short.isFunded).toBe(false);
        expect(short.currentRaised).toBe(40);
    });

    it('singular wording for one offer and one keeper', () => {
        const s = enterpriseCardStatus({ ...base, liveOffers: 1, keepers: [twoKeepers[0]] });
        expect(s.meta).toBe('1 live offer · 1 keeper');
    });
});
