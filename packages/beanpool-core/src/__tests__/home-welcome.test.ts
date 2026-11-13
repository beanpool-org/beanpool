/**
 * Welcome's lines (home-welcome.ts, DESIGN-home-default-fable.md §2.3): one rule the phone and the web both read, so each
 * case has one wording on both. The parity read of D2 against D3 (rows 14-16) found three cases where the two apps said
 * different things: the global community's place line, an inviter with no name, and "the first one here".
 */
import { describe, expect, it } from 'vitest';
import { readerMayInvite, welcomeFacts, WELCOME_PLACE_WORDS, type WelcomeAnswer } from '../home-welcome.js';
import { pseudoLocalise, setLanguage } from '../words.js';

const local = (me: WelcomeAnswer['me'] = {}, community: { name?: string | null; members?: number | null } | null = { name: 'Byron Shire BeanPool', members: 40 }): WelcomeAnswer =>
    ({ profile: 'local', me, cards: community ? { community } : {} });

describe('where you are', () => {
    it('a local community by its own name, the design\'s example', () => {
        expect(welcomeFacts(local()).place).toBe("You're in Byron Shire BeanPool.");
    });

    it('the global community by its own sentence, card or no card: never "You\'re in The global community."', () => {
        expect(welcomeFacts({ profile: 'global', me: {}, cards: {} }).place).toBe("You're in the global community");
        expect(welcomeFacts({ profile: 'global', me: {}, cards: { community: { name: 'The global community', members: 2310 } } }).place).toBe("You're in the global community");
        expect(WELCOME_PLACE_WORDS.global).toBe("You're in the global community");
    });

    it('a local community whose name the answer doesn\'t carry: no line, never a stand-in name', () => {
        expect(welcomeFacts(local({}, { name: null, members: 4 })).place).toBeNull();
        expect(welcomeFacts(local({}, { name: '   ', members: 4 })).place).toBeNull();
        expect(welcomeFacts(local({}, null)).place).toBeNull();
    });

    it('in the member\'s language', () => {
        setLanguage('xx');
        try {
            expect(welcomeFacts(local()).place).toBe(pseudoLocalise("You're in {community}.").replace('{community}', 'Byron Shire BeanPool'));
            expect(welcomeFacts({ profile: 'global', me: {}, cards: {} }).place).toBe(pseudoLocalise("You're in the global community"));
        } finally {
            setLanguage('en');
        }
    });
});

describe('who brought you', () => {
    it('whoever\'s invite they used, by name, trimmed', () => {
        expect(welcomeFacts(local({ invitedBy: { key: 'ana-key', name: ' Ana ' } })).inviter).toEqual({ key: 'ana-key', name: 'Ana' });
    });

    it('no inviter, or one with no name to say: no line (§2.3), so never "Someone invited you."', () => {
        expect(welcomeFacts(local({ invitedBy: null })).inviter).toBeNull();
        expect(welcomeFacts(local({ invitedBy: { key: 'ana-key', name: null } })).inviter).toBeNull();
        expect(welcomeFacts(local({ invitedBy: { key: 'ana-key', name: '  ' } })).inviter).toBeNull();
        expect(welcomeFacts(local({ invitedBy: { key: 7, name: 'Ana' } })).inviter).toBeNull();
    });
});

describe('the first one here', () => {
    const one = { name: 'New Place', members: 1 };

    it('an owner alone on a new local community that nobody invited them to', () => {
        expect(welcomeFacts(local({ invitedBy: null }, one)).firstHere).toBe(true);
        expect(welcomeFacts(local({}, one)).firstHere).toBe(true);
    });

    it('never for a member someone invited, named or not: whoever invited them is here too', () => {
        const named = welcomeFacts(local({ invitedBy: { key: 'ana-key', name: 'Ana' } }, one));
        expect(named.firstHere).toBe(false);
        expect(named.inviter).not.toBeNull();
        const nameless = welcomeFacts(local({ invitedBy: { key: 'ana-key', name: null } }, one));
        expect(nameless.firstHere).toBe(false);
        expect(nameless.inviter).toBeNull();
    });

    it('never on the global community, nor with others here, nor when the count is unknown', () => {
        expect(welcomeFacts({ profile: 'global', me: { invitedBy: null }, cards: { community: one } }).firstHere).toBe(false);
        expect(welcomeFacts(local({ invitedBy: null }, { name: 'New Place', members: 2 })).firstHere).toBe(false);
        expect(welcomeFacts(local({ invitedBy: null }, { name: 'New Place', members: null })).firstHere).toBe(false);
        expect(welcomeFacts(local({ invitedBy: null }, null)).firstHere).toBe(false);
    });
});

describe('"Invite someone ›" only where the reader can invite', () => {
    it('invites on, any member; where only admins invite, an owner or admin the node has named; a role not heard is no', () => {
        expect(readerMayInvite({ invites: true }, undefined)).toBe(true);
        expect(readerMayInvite({ invites: true, door: 'members' }, null)).toBe(true);
        expect(readerMayInvite({ invites: false }, 'owner')).toBe(false);
        expect(readerMayInvite({}, 'owner')).toBe(false);
        expect(readerMayInvite({ invites: true, door: 'admins' }, undefined)).toBe(false);
        expect(readerMayInvite({ invites: true, door: 'admins' }, null)).toBe(false);
        expect(readerMayInvite({ invites: true, door: 'admins' }, 'moderator')).toBe(false);
        expect(readerMayInvite({ invites: true, door: 'admins' }, 'admin')).toBe(true);
        expect(readerMayInvite({ invites: true, door: 'admins' }, 'owner')).toBe(true);
    });
});
