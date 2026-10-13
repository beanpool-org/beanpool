import { describe, expect, it } from 'vitest';
import { groupKindLine, keeperWords } from '../group-words.js';

describe('keeperWords (pick 8)', () => {
    it('a project has a leader and collaborators', () => {
        const w = keeperWords('bounded');
        expect([w.Kind, w.Lead, w.Keeper, w.Keepers, w.lead, w.keeper]).toEqual(['Project', 'Leader', 'Collaborator', 'Collaborators', 'leader', 'collaborator']);
    });
    it('an enterprise has a lead keeper and keepers, also when the lifecycle is missing', () => {
        for (const l of ['ongoing', null, undefined]) {
            const w = keeperWords(l);
            expect([w.Kind, w.Lead, w.Keeper, w.Keepers]).toEqual(['Enterprise', 'Lead keeper', 'Keeper', 'Keepers']);
        }
    });
    it('never shows the stored words', () => {
        for (const l of ['bounded', 'ongoing']) {
            const all = JSON.stringify(keeperWords(l)) + groupKindLine(l);
            expect(all).not.toMatch(/treasur|bounded|ongoing/i);
        }
    });
});
