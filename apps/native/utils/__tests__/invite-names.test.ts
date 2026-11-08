/**
 * People → Invites, owners' and admins' boxes (DESIGN-invites-and-names-list-amend3-fable.md §1–§2, slice A2): who gets them,
 * when "Make them a voucher" is greyed and why, the duplicate-name warning, and what Generate sends and makes. The screen's own
 * render is people-invites-names-boxes-render.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
vi.mock('../push-pins', () => ({ communityAddress: (a: string) => a }));

import {
    offersNamesBoxes, voucherBoxWhy, voucherBoxWords, sameNameOnList, sameNameWords, inviteWithNamesEntry, inviteNotMadeWords,
} from '../invite-names';
import type { OpenedEntry, NamesOpened } from '../names-list';

const entry = (id: string, name: string, confirmation: Partial<NonNullable<OpenedEntry['confirmation']>> | null = null): OpenedEntry => ({
    id, keyId: 'k1', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', text: { name, note: '' }, locked: null, key: null,
    holders: [], notTrusting: [], checkedHere: [], voucher: null,
    confirmation: confirmation ? {
        id: 'c1', memberPubkey: 'mem', callsign: null, entryId: id, confirmedBy: 'owen', confirmedAt: '2026-11-02T00:00:00Z', needsSecond: false,
        secondedBy: null, secondedAt: null, status: 'confirmed', ...confirmation,
    } as NonNullable<OpenedEntry['confirmation']> : null,
});
const opened = {
    list: { entries: [{ id: 'e-jane', ciphertext: 'x', keyId: 'k1', createdBy: 'damo-key', createdAt: '', updatedBy: 'damo-key', updatedAt: '' }] },
    state: { admins: [{ pubkey: 'damo-key', callsign: 'damo' }], callsigns: {} },
} as unknown as Pick<NamesOpened, 'list' | 'state'>;

describe('who gets the boxes', () => {
    it('owners and admins of a local community; never a member, a moderator or the global community', () => {
        expect(offersNamesBoxes('owner', 'local')).toBe(true);
        expect(offersNamesBoxes('admin', null)).toBe(true);
        expect(offersNamesBoxes(null, 'local')).toBe(false);
        expect(offersNamesBoxes(undefined, 'local')).toBe(false);
        expect(offersNamesBoxes('moderator', 'local')).toBe(false);
        expect(offersNamesBoxes('owner', 'global')).toBe(false);
    });
});

describe('"Make them a voucher": greyed, and why', () => {
    it('only for the credit committee, whatever else is true', () => {
        expect(voucherBoxWhy({ committee: false, online: true, namesTicked: true })).toBe('committee_only');
        expect(voucherBoxWords('committee_only')).toBe('Only an owner or an admin on the credit committee makes vouchers and sets their budgets.');
    });
    it('needs a connection: a ticket never carries a level', () => {
        expect(voucherBoxWhy({ committee: true, online: false, namesTicked: true })).toBe('needs_signal');
        expect(voucherBoxWords('needs_signal')).toBe('Needs a connection. You can make them a voucher from the list once they’ve joined.');
    });
    it('only with the names box ticked', () => {
        expect(voucherBoxWhy({ committee: true, online: true, namesTicked: false })).toBe('needs_names');
        expect(voucherBoxWhy({ committee: true, online: true, namesTicked: true })).toBeNull();
        expect(voucherBoxWords(null)).toBeNull();
    });
});

describe('the duplicate-name warning (design §1)', () => {
    const entries = [entry('e-jane', 'Jane Albury'), entry('e-kit', 'Kit Fairweather', { callsign: 'kit' })];
    it('a typed name that folds to one on the list: who added it, not joined yet, and the way to invite that entry', () => {
        const same = sameNameOnList('  jane   ALBURY ', entries, opened);
        expect(same).toEqual({ entryId: 'e-jane', name: 'Jane Albury', by: '@damo', member: null });
        expect(sameNameWords(same!)).toBe('Jane Albury is on the list already (added by @damo, not joined yet). Invite that entry instead?');
    });
    it('accents set aside', () => {
        expect(sameNameOnList('Jáne Albury', entries, opened)?.entryId).toBe('e-jane');
    });
    it('a confirmed entry says who joined, and offers no invite', () => {
        const same = sameNameOnList('kit fairweather', entries, opened);
        expect(same?.member).toBe('kit');
        expect(sameNameWords(same!)).toBe('Kit Fairweather is on the list already (added by an admin, confirmed as @kit).');
    });
    it('nothing for another name, or nothing typed', () => {
        expect(sameNameOnList('Jane Alberry', entries, opened)).toBeNull();
        expect(sameNameOnList('   ', entries, opened)).toBeNull();
    });
});

describe('Generate with the names box ticked (design §2)', () => {
    const ok = <T,>(value: T) => ({ ok: true as const, value });
    const no = (status: number, message: string) => ({ ok: false as const, status, message });

    it('adds the entry, then the invite bound to it, with the vouch and the level chosen (Q1: both)', async () => {
        const invite = vi.fn(async () => ok({ invite: { code: 'INV-1' } }));
        const ticket = vi.fn(async () => 'BP-T');
        const r = await inviteWithNamesEntry({ saveEntry: async () => ok({ id: 'e-new' }), invite, offlineTicket: ticket }, { vouchAmount: 50, voucherLevel: 1000 });
        expect(r).toEqual({ kind: 'made', code: 'INV-1', offline: false, entryId: 'e-new' });
        expect(invite).toHaveBeenCalledWith('e-new', { vouchAmount: 50, voucherLevel: 1000 });
        expect(ticket).not.toHaveBeenCalled();
    });

    it('sends only what was chosen: nothing chosen is today’s empty body', async () => {
        const invite = vi.fn(async () => ok({ invite: { code: 'INV-2' } }));
        await inviteWithNamesEntry({ saveEntry: async () => ok({ id: 'e-new' }), invite, offlineTicket: async () => 'x' }, { vouchAmount: null, voucherLevel: null });
        expect(invite).toHaveBeenCalledWith('e-new', {});
    });

    it('the entry not written: nothing made, no invite asked', async () => {
        const invite = vi.fn();
        const r = await inviteWithNamesEntry({ saveEntry: async () => no(0, 'This phone can’t write to the list right now. Open it again.'), invite, offlineTicket: async () => 'x' }, {});
        expect(r).toEqual({ kind: 'entry_not_saved', message: 'This phone can’t write to the list right now. Open it again.' });
        expect(invite).not.toHaveBeenCalled();
    });

    it('the entry written, the invite refused: says so, the entry stands, and points to the list', async () => {
        const r = await inviteWithNamesEntry({
            saveEntry: async () => ok({ id: 'e-new' }), invite: async () => no(403, 'Only an owner or an admin on the credit committee makes vouchers and sets their budgets.'), offlineTicket: async () => 'x',
        }, { voucherLevel: 1000 });
        expect(r).toEqual({ kind: 'invite_not_made', entryId: 'e-new', entryIsNew: true, message: 'Only an owner or an admin on the credit committee makes vouchers and sets their budgets.' });
        expect(inviteNotMadeWords(r as Extract<typeof r, { kind: 'invite_not_made' }>)).toBe(
            'The name is on the names list, but the invite wasn’t made: Only an owner or an admin on the credit committee makes vouchers and sets their budgets. '
            + 'Their entry stays: open the names list and use Invite this person on it.');
    });

    it('no answer with a level chosen: no ticket, since a ticket never carries a level', async () => {
        const ticket = vi.fn(async () => 'BP-T');
        const r = await inviteWithNamesEntry({ saveEntry: async () => ok({ id: 'e-new' }), invite: async () => no(0, 'unreachable'), offlineTicket: ticket }, { voucherLevel: 1500 });
        expect(r.kind).toBe('invite_not_made');
        expect(ticket).not.toHaveBeenCalled();
    });

    it('no answer with a vouch chosen: no ticket either', async () => {
        const ticket = vi.fn(async () => 'BP-T');
        const r = await inviteWithNamesEntry({ saveEntry: async () => ok({ id: 'e-new' }), invite: async () => no(0, 'unreachable'), offlineTicket: ticket }, { vouchAmount: 25 });
        expect(r.kind).toBe('invite_not_made');
        expect(ticket).not.toHaveBeenCalled();
    });

    it('no answer, nothing chosen: a ticket bound to the entry, as Invite this person makes', async () => {
        const ticket = vi.fn(async (_id: string) => 'BP-T');
        const r = await inviteWithNamesEntry({ saveEntry: async () => ok({ id: 'e-new' }), invite: async () => no(0, 'unreachable'), offlineTicket: ticket }, {});
        expect(r).toEqual({ kind: 'made', code: 'BP-T', offline: true, entryId: 'e-new' });
        expect(ticket).toHaveBeenCalledWith('e-new');
    });

    it('"Invite that entry": binds the entry on the list, adds nothing', async () => {
        const save = vi.fn();
        const invite = vi.fn(async () => ok({ invite: { code: 'INV-3' } }));
        const r = await inviteWithNamesEntry({ saveEntry: save, invite, offlineTicket: async () => 'x' }, { vouchAmount: 100 }, 'e-jane');
        expect(r).toEqual({ kind: 'made', code: 'INV-3', offline: false, entryId: 'e-jane' });
        expect(save).not.toHaveBeenCalled();
        expect(invite).toHaveBeenCalledWith('e-jane', { vouchAmount: 100 });
        const refused = await inviteWithNamesEntry({ saveEntry: save, invite: async () => no(409, 'Taken.'), offlineTicket: async () => 'x' }, {}, 'e-jane');
        expect(refused).toEqual({ kind: 'invite_not_made', entryId: 'e-jane', entryIsNew: false, message: 'Taken.' });
        expect(inviteNotMadeWords(refused as Extract<typeof refused, { kind: 'invite_not_made' }>)).toBe('Taken.');
    });
});
