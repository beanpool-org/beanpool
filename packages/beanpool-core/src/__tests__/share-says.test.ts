import { describe, expect, it } from 'vitest';
import { shareSays } from '../share-says';
import { PEEK_WORDS as W } from '../peek-ticket';

describe('shareSays table rules', () => {
    it('Row 1: Sharing outside on — keeps both buttons, members only and 7 days line', () => {
        const res = shareSays({ shareOutside: true, door: 'members', knocks: true });
        expect(res.membersLine).toBe(W.membersOnlyLine);
        expect(res.outsideLine).toBe(W.shareOutsideLine);
        // One flow (share-one-flow, 3 Nov): Invite and share shows wherever the member may invite, sharing outside on or not.
        // (This row used to say false, when #2774 offered no invite button here; #2777's Invite and share showed here anyway.)
        expect(res.showInviteButton).toBe(true);
        expect(res.showShareOutside).toBe(true);
    });

    it('Row 1: the invite action follows who may invite, the same as without sharing outside', () => {
        const on = { shareOutside: true, knocks: true };
        expect(shareSays({ ...on, door: 'members', invites: false }).showInviteButton).toBe(false);
        expect(shareSays({ ...on, door: 'admins' }, undefined).showInviteButton).toBe(false);
        expect(shareSays({ ...on, door: 'admins' }, null).showInviteButton).toBe(false);
        expect(shareSays({ ...on, door: 'admins' }, 'moderator').showInviteButton).toBe(false);
        expect(shareSays({ ...on, door: 'admins' }, 'admin').showInviteButton).toBe(true);
        expect(shareSays({ ...on, door: 'admins' }, 'owner').showInviteButton).toBe(true);
    });

    it('Row 2: Sharing outside off, any member may invite — Share with members, members only line, Invite and share', () => {
        const res = shareSays({ shareOutside: false, door: 'members' });
        expect(res.membersLine).toBe(W.membersOnlyLine);
        expect(res.outsideLine).toBeNull();
        expect(res.showInviteButton).toBe(true);
        expect(res.showShareOutside).toBe(false);
    });

    it('Row 3: Sharing outside off, only admins invite, member not an admin — Share with members, only admins invite line, no button', () => {
        const res = shareSays({ shareOutside: false, door: 'admins' }, null);
        expect(res.membersLine).toBe(W.adminsOnlyLine);
        expect(res.outsideLine).toBeNull();
        expect(res.showInviteButton).toBe(false);
        expect(res.showShareOutside).toBe(false);

        const resMod = shareSays({ shareOutside: false, door: 'admins' }, 'moderator');
        expect(resMod.membersLine).toBe(W.adminsOnlyLine);
        expect(resMod.showInviteButton).toBe(false);
    });

    it('Row 4: Sharing outside off, only admins invite, member is owner/admin — as second row', () => {
        const resAdmin = shareSays({ shareOutside: false, door: 'admins' }, 'admin');
        expect(resAdmin.membersLine).toBe(W.membersOnlyLine);
        expect(resAdmin.outsideLine).toBeNull();
        expect(resAdmin.showInviteButton).toBe(true);
        expect(resAdmin.showShareOutside).toBe(false);

        const resOwner = shareSays({ shareOutside: false, door: 'admins' }, 'owner');
        expect(resOwner.membersLine).toBe(W.membersOnlyLine);
        expect(resOwner.showInviteButton).toBe(true);
    });

    it('Row 5: Open door (global) — no line under share buttons', () => {
        const resOpen = shareSays({ door: 'open', openJoin: true, invites: false, shareOutside: false });
        expect(resOpen.membersLine).toBeNull();
        expect(resOpen.outsideLine).toBeNull();
        expect(resOpen.showInviteButton).toBe(false);
        expect(resOpen.showShareOutside).toBe(false);

        // Also when door: 'open' alone
        const resOpenOnly = shareSays({ door: 'open' });
        expect(resOpenOnly.membersLine).toBeNull();
    });

    it('Row 6: Private preview — member sees third row, admin sees second row', () => {
        const resMember = shareSays({ privatePreview: true, door: 'admins', shareOutside: false }, null);
        expect(resMember.membersLine).toBe(W.adminsOnlyLine);
        expect(resMember.outsideLine).toBeNull();
        expect(resMember.showInviteButton).toBe(false);
        expect(resMember.showShareOutside).toBe(false);

        const resAdmin = shareSays({ privatePreview: true, door: 'admins', shareOutside: false }, 'admin');
        expect(resAdmin.membersLine).toBe(W.membersOnlyLine);
        expect(resAdmin.outsideLine).toBeNull();
        expect(resAdmin.showInviteButton).toBe(true);
        expect(resAdmin.showShareOutside).toBe(false);
    });

    it('Fallback: settings cannot be read — shows today buttons and no line', () => {
        expect(shareSays(null)).toEqual({
            membersLine: null,
            outsideLine: null,
            showInviteButton: false,
            showAskAdmin: false,
            showShareOutside: false,
        });

        expect(shareSays(undefined)).toEqual({
            membersLine: null,
            outsideLine: null,
            showInviteButton: false,
            showAskAdmin: false,
            showShareOutside: false,
        });

        expect(shareSays({})).toEqual({
            membersLine: null,
            outsideLine: null,
            showInviteButton: false,
            showAskAdmin: false,
            showShareOutside: false,
        });

        expect(shareSays({ door: null, shareOutside: null })).toEqual({
            membersLine: null,
            outsideLine: null,
            showInviteButton: false,
            showAskAdmin: false,
            showShareOutside: false,
        });
    });

    it('Row 1 with joining paused (knocks off, or not said): the outside note never says ask to join', () => {
        for (const knocks of [false, null, undefined]) {
            const res = shareSays({ shareOutside: true, door: 'members', knocks });
            expect(res.membersLine).toBe(W.membersOnlyLine);
            expect(res.outsideLine).toBe(W.shareOutsideNoKnockLine);
            expect(res.showShareOutside).toBe(true);
        }
    });

    it('an event says "event", with and without asking to join', () => {
        expect(shareSays({ shareOutside: true, door: 'members', knocks: true }, null, 'event').outsideLine).toBe(W.shareOutsideEventLine);
        expect(shareSays({ shareOutside: true, door: 'members', knocks: false }, null, 'event').outsideLine).toBe(W.shareOutsideEventNoKnockLine);
        expect(shareSays({ shareOutside: true, door: 'members', knocks: true }).outsideLine).toBe(W.shareOutsideLine);
    });

    it('where only admins invite, a role not known yet (loading, or no answer) says nothing and offers no button; a known "none" still says only admins invite', () => {
        const unknown = shareSays({ shareOutside: false, door: 'admins' }, undefined);
        expect(unknown).toEqual({ membersLine: null, outsideLine: null, showInviteButton: false, showAskAdmin: false, showShareOutside: false });
        const preview = shareSays({ privatePreview: true, door: 'admins', shareOutside: false }, undefined);
        expect(preview).toEqual({ membersLine: null, outsideLine: null, showInviteButton: false, showAskAdmin: false, showShareOutside: false });
        expect(shareSays({ shareOutside: false, door: 'admins' }, null).membersLine).toBe(W.adminsOnlyLine);
        // Where any member may invite, the role does not matter.
        expect(shareSays({ shareOutside: false, door: 'members' }, undefined).showInviteButton).toBe(true);
    });

    it('invites off with a members door (an override): no invite action and no line about who may invite, for a member and an admin', () => {
        const nothing = { membersLine: null, outsideLine: null, showInviteButton: false, showAskAdmin: false, showShareOutside: false };
        expect(shareSays({ shareOutside: false, door: 'members', invites: false }, null)).toEqual(nothing);
        expect(shareSays({ shareOutside: false, door: 'members', invites: false }, 'owner')).toEqual(nothing);
        expect(shareSays({ shareOutside: false, door: 'admins', invites: false }, 'owner')).toEqual(nothing);
        // Sharing outside on is untouched: the link is still members-only and still shareable outside.
        expect(shareSays({ shareOutside: true, door: 'members', invites: false, knocks: true }).showShareOutside).toBe(true);
    });

    describe('Ask an admin to invite someone (showAskAdmin)', () => {
        const closed = { door: 'admins', inviteAsks: true, shareOutside: false };

        it('only admins invite, a member who is no admin, role known, the node takes asks: the line stays and the Ask shows', () => {
            for (const role of [null, 'moderator', 'member']) {
                const res = shareSays(closed, role);
                expect(res.membersLine).toBe(W.adminsOnlyLine);
                expect(res.showAskAdmin).toBe(true);
                expect(res.showInviteButton).toBe(false);
            }
        });

        it('also with sharing outside on (the link is still members-only, and only admins invite)', () => {
            const res = shareSays({ ...closed, shareOutside: true, knocks: true }, null);
            expect(res.showAskAdmin).toBe(true);
            expect(res.showInviteButton).toBe(false);
            expect(res.showShareOutside).toBe(true);
        });

        it('an owner or admin sees Invite and share and never the Ask', () => {
            for (const role of ['owner', 'admin']) {
                const res = shareSays(closed, role);
                expect(res.showInviteButton).toBe(true);
                expect(res.showAskAdmin).toBe(false);
            }
        });

        it('asks off (or an older node that says nothing): no Ask', () => {
            expect(shareSays({ ...closed, inviteAsks: false }, null).showAskAdmin).toBe(false);
            expect(shareSays({ door: 'admins', shareOutside: false }, null).showAskAdmin).toBe(false);
            expect(shareSays({ ...closed, inviteAsks: null }, null).showAskAdmin).toBe(false);
        });

        it('invites off: no Ask and no line', () => {
            expect(shareSays({ ...closed, invites: false }, null)).toEqual({ membersLine: null, outsideLine: null, showInviteButton: false, showAskAdmin: false, showShareOutside: false });
            expect(shareSays({ ...closed, invites: false, shareOutside: true, knocks: true }, null).showAskAdmin).toBe(false);
        });

        it('the door is not admins (members, or a private preview with another door): no Ask', () => {
            expect(shareSays({ door: 'members', inviteAsks: true, shareOutside: false }, null).showAskAdmin).toBe(false);
            expect(shareSays({ door: 'members', inviteAsks: true, privatePreview: true, shareOutside: false }, null).showAskAdmin).toBe(false);
            expect(shareSays({ door: 'open', inviteAsks: true }, null).showAskAdmin).toBe(false);
        });

        it('role not known yet (loading, or the node did not answer): no Ask, as for the invite action', () => {
            expect(shareSays(closed, undefined).showAskAdmin).toBe(false);
            expect(shareSays({ ...closed, shareOutside: true, knocks: true }, undefined).showAskAdmin).toBe(false);
        });

        it('settings unreadable: no Ask', () => {
            expect(shareSays(null, null).showAskAdmin).toBe(false);
            expect(shareSays({ inviteAsks: true }, null).showAskAdmin).toBe(false);
        });
    });
});
