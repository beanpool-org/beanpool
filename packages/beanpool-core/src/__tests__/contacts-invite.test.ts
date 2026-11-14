/**
 * Invite from a contact (DESIGN-private-contacts-fable.md §3.8, §3.9, slice C5): core's half, shared by both apps. Each check
 * names the change that turns it red.
 */
import { describe, expect, it } from 'vitest';
import {
    CONTACTS_LIMITS, contactInviteAsk, contactInviteCodes, contactInviteLines, contactInviteNames, contactInviteOut, contactInviteTitle, contactInvitedLine, contactMailtoLink,
    contactSmsLink, forgetContactInvite, linkContactToInvite, withContactInvite, inviteWho, type Contact,
} from '../index';

const HERE = 'https://riverside.example';
const THERE = 'https://riverbend.example';
const same = (a: string) => a === HERE;
const DEE_KEY = 'd1'.repeat(32);
const NOW = Date.parse('2026-11-15T10:00:00.000Z');
const dee = (more: Partial<Contact> = {}): Contact => ({
    id: 'a'.repeat(32), name: 'Dee Walker', phones: ['0412 345 678'], emails: ['dee@example.org'], note: '', links: [], invite: null, clock: 3, ...more,
});
const invited = (code = 'INV-ABCD-1234', community = HERE, at = '2026-11-12T01:00:00.000Z') => dee({ invite: { code, community, at } });

describe('the sheet\'s words', () => {
    it('names the person and the community, says one invite for one person, and that the name and number stay here', () => {
        expect(contactInviteTitle('Dee', 'Riverside')).toBe('Invite Dee to Riverside');
        expect(contactInviteLines(dee({ name: 'Dee' }))).toEqual([
            'One invite, for one person. It works once, for 30 days.',
            "Dee's name and number are not sent to the server.",
        ]);
        // With no number, the sentence names what the list holds instead (never says a number that isn't there).
        expect(contactInviteLines(dee({ name: 'Dee', phones: [] }))[1]).toBe("Dee's name and email are not sent to the server.");
        expect(contactInviteLines(dee({ name: 'Dee', phones: [], emails: [] }))[1]).toBe("Dee's name is not sent to the server.");
    });

    it('the row after an invite reads "invited 12 Nov"', () => {
        expect(contactInvitedLine(invited())).toBe('invited 12 Nov');
        expect(contactInvitedLine(dee())).toBeNull();
    });
});

describe('the links that open the member\'s own apps (nothing goes to a server)', () => {
    it('a text message: the number stripped to digits and +, the message in the body', () => {
        expect(contactSmsLink('+61 (412) 345-678', 'Join me', 'android')).toBe('sms:+61412345678?body=Join%20me');
        // iPhone's Messages reads the body after & (the form it has always opened).
        expect(contactSmsLink('0412 345 678', 'a&b', 'ios')).toBe('sms:0412345678&body=a%26b');
        // A number that is all marks and letters, or a script in it, opens nothing (design §7: only digits and + go in).
        expect(contactSmsLink('call me', 'x', 'android')).toBeNull();
        expect(contactSmsLink('0412;javascript:1', 'x', 'android')).toBe('sms:04121?body=x');
        // Mutation: pass the number as written → the brackets, spaces and the script reach the link.
    });

    it('an email: the address checked, subject and body encoded', () => {
        expect(contactMailtoLink('dee@example.org', 'Join me on BeanPool', 'line 1\nline 2')).toBe('mailto:dee@example.org?subject=Join%20me%20on%20BeanPool&body=line%201%0Aline%202');
        expect(contactMailtoLink('dee@example.org?bcc=x@y.z', 's', 'b')).toBeNull();
        expect(contactMailtoLink('not an address', 's', 'b')).toBeNull();
    });
});

describe('the code kept in the locked list', () => {
    it('an invite made is kept on the contact (code, community, when), and nothing else of the contact changes', () => {
        const c = withContactInvite(dee(), 'INV-ABCD-1234', HERE, new Date(NOW));
        expect(c.invite).toEqual({ code: 'INV-ABCD-1234', community: HERE, at: '2026-11-15T10:00:00.000Z' });
        expect({ ...c, invite: null }).toEqual(dee());
    });

    it('Pending names an invite from the list on this device: only codes for this community', () => {
        const names = contactInviteNames([invited('INV-HERE-0001'), { ...invited('INV-THERE-001', THERE), id: 'b'.repeat(32), name: 'Tom' }], same);
        expect(names.get('inv-here-0001')).toBe('Dee Walker');
        expect(names.has('inv-there-001')).toBe(false);
        // inviteWho reads it as the name, ahead of the code, for an invite with no note and no names-list entry.
        expect(inviteWho({ code: 'INV-HERE-0001', createdAt: '2026-11-12T01:00:00.000Z' }, { contactName: names.get('inv-here-0001') })).toBe('Dee Walker');
        // The names list's own name still wins for a bound invite.
        expect(inviteWho({ code: 'X', createdAt: '2026-11-12T01:00:00.000Z', namesEntryId: 'e1' }, { name: 'Sam', contactName: 'Dee' })).toBe('Sam');
        // Mutation: drop contactName from inviteWho → the row reads the bare code.
    });

    it('the codes made here, as one key: a second invite, or Invite again, changes it (so each app reads its invites again)', () => {
        const tom = (code: string) => ({ ...invited(code), id: 'b'.repeat(32), name: 'Tom' });
        const there = { ...invited('INV-THERE-001', THERE), id: 'c'.repeat(32), name: 'Sam' };
        expect(contactInviteCodes([dee(), there], same)).toBe('');
        const one = contactInviteCodes([invited('INV-DEE-0001'), there], same);
        expect(one).toBe('inv-dee-0001');
        // Tom invited in the same visit: the key changes although "someone holds an invite here" was already true.
        const two = contactInviteCodes([invited('INV-DEE-0001'), tom('INV-TOM-0001'), there], same);
        expect(two).toBe('inv-dee-0001,inv-tom-0001');
        // Invite again on Dee: a new code in place of the old one.
        expect(contactInviteCodes([invited('INV-DEE-0002'), tom('INV-TOM-0001')], same)).not.toBe(two);
        // The order of the list doesn't change it.
        expect(contactInviteCodes([tom('INV-TOM-0001'), invited('INV-DEE-0001')], same)).toBe(two);
        // Mutation: return whether any code is held (a boolean) → the second and third keys equal the first, red.
    });
});

describe('"Is this Dee?": asked once the invite is used, never assumed', () => {
    const used = { code: 'INV-ABCD-1234', createdAt: '2026-11-12T01:00:00.000Z', usedBy: DEE_KEY, usedAt: '2026-11-14T01:00:00.000Z', usedByCallsign: 'dee_w' };
    it('asks when this community says the code was used, with who used it', () => {
        expect(contactInviteAsk(invited(), [used], same)).toEqual({ code: 'INV-ABCD-1234', key: DEE_KEY, callsign: 'dee_w' });
    });
    it('does not ask for an unused code, a code of another community, or one already linked to that member', () => {
        expect(contactInviteAsk(invited(), [{ ...used, usedBy: null }], same)).toBeNull();
        expect(contactInviteAsk(invited('INV-ABCD-1234', THERE), [used], same)).toBeNull();
        expect(contactInviteAsk(dee(), [used], same)).toBeNull();
        const linked = linkContactToInvite(invited(), { code: used.code, key: DEE_KEY, callsign: 'dee_w' }, new Date(NOW));
        expect(contactInviteAsk(linked, [used], same)).toBeNull();
    });
    it('does not ask for a contact already holding its 5 links: a Yes could add none, so the question would come back', () => {
        const link = (i: number) => ({ key: String(i).repeat(64), community: HERE, callsign: `m${i}`, how: 'hand' as const, at: '2026-11-13T01:00:00.000Z' });
        const four = invited();
        four.links = [1, 2, 3, 4].map(link);
        expect(contactInviteAsk(four, [used], same)).toEqual({ code: 'INV-ABCD-1234', key: DEE_KEY, callsign: 'dee_w' });
        const full = { ...four, links: [...four.links, link(5)] };
        expect(full.links).toHaveLength(CONTACTS_LIMITS.links);
        expect(contactInviteAsk(full, [used], same)).toBeNull();
        // Mutation: drop the links check → the full contact is asked, red.
    });
    it('Yes links the contact to that member (how: invite), here; No forgets the invite so it is not asked again', () => {
        const linked = linkContactToInvite(invited(), { code: used.code, key: DEE_KEY, callsign: 'dee_w' }, new Date(NOW));
        expect(linked.links).toEqual([{ key: DEE_KEY, community: HERE, callsign: 'dee_w', how: 'invite', at: '2026-11-15T10:00:00.000Z' }]);
        const no = forgetContactInvite(invited());
        expect(no.invite).toBeNull();
        expect(contactInviteAsk(no, [used], same)).toBeNull();
    });
});

describe('"Also cancel the invite I sent": only for an invite still out here', () => {
    const mine = (usedBy: string | null) => [{ code: 'INV-ABCD-1234', createdAt: '2026-11-12T01:00:00.000Z', usedBy }];
    it('offered for an unused code of this community within its 30 days', () => {
        expect(contactInviteOut(invited(), mine(null), same, NOW)).toBe('INV-ABCD-1234');
    });
    it('not for a used, lapsed, unknown or other community\'s code', () => {
        expect(contactInviteOut(invited(), mine(DEE_KEY), same, NOW)).toBeNull();
        expect(contactInviteOut(invited(), [], same, NOW)).toBeNull();
        expect(contactInviteOut(invited('INV-ABCD-1234', THERE), mine(null), same, NOW)).toBeNull();
        expect(contactInviteOut(invited(), mine(null), same, Date.parse('2026-12-13T01:00:00.000Z'))).toBeNull();
        expect(contactInviteOut(dee(), mine(null), same, NOW)).toBeNull();
    });
});
