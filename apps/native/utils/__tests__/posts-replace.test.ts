import { describe, it, expect } from 'vitest';
import { postsTheNodeNoLongerHas, type HeldListing } from '../posts-replace';

// utils/posts-replace.ts: what a take-over's whole pull says the node no longer has. `sentOnly` names the rows another
// read carried (the catch-up of what changed since the pull began, services/pillar-sync.ts): the node has them, but they
// are no part of the pull's answer (review of PR #1719, NB5).
const row = (id: string, at: string, scope = 'public') => ({ id, updatedAt: at, audienceScope: scope });
const heldRow = (id: string, at: string, scope: string | null = 'public'): HeldListing => ({ id, at, scope });

describe('postsTheNodeNoLongerHas and the rows only sent', () => {
    const pull = [row('new', '2026-09-03T00:00:00.000Z'), row('mid', '2026-09-02T00:00:00.000Z')];
    const held = [
        heldRow('new', '2026-09-03T00:00:00.000Z'), heldRow('mid', '2026-09-02T00:00:00.000Z'),
        heldRow('unread', '2026-08-01T00:00:00.000Z'), heldRow('tail', '2026-09-02T12:00:00.000Z'),
    ];

    it('an old row on the catch-up read never lowers the pull\'s oldest time: the unread rows below the pull stay', () => {
        const oldOnCatchUp = row('ancient', '2026-01-01T00:00:00.000Z');
        expect(postsTheNodeNoLongerHas([...pull, oldOnCatchUp], [...held, heldRow('ancient', '2026-01-01T00:00:00.000Z')], new Set(['ancient'])))
            .toEqual(['tail']);
        // As it was without the name: the old row set the bound, and the unread row went.
        expect(postsTheNodeNoLongerHas([...pull, oldOnCatchUp], [...held, heldRow('ancient', '2026-01-01T00:00:00.000Z')]))
            .toEqual(['unread', 'tail']);
    });

    it('a row only sent is still the node\'s: it never goes', () => {
        const changed = row('tail', '2026-09-04T00:00:00.000Z');
        expect(postsTheNodeNoLongerHas([...pull, changed], held, new Set(['tail']))).toEqual([]);
    });

    it('a group row only sent says nothing of whose view the pull was', () => {
        const heldGroup = [...held, heldRow('club', '2026-09-02T18:00:00.000Z', 'group')];
        expect(postsTheNodeNoLongerHas([...pull, row('other-club', '2026-09-04T00:00:00.000Z', 'group')], heldGroup, new Set(['other-club'])))
            .toEqual(['tail']);
    });
});
