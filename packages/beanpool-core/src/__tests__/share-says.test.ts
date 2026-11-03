import { describe, expect, it } from 'vitest';
import { shareSays } from '../share-says';
import { PEEK_WORDS as W } from '../peek-ticket';

describe('shareSays table rules', () => {
    it('Row 1: Sharing outside on — keeps both buttons, members only and 7 days line', () => {
        const res = shareSays({ shareOutside: true, door: 'members' });
        expect(res.membersLine).toBe(W.membersOnlyLine);
        expect(res.outsideLine).toBe(W.shareOutsideLine);
        expect(res.showInviteButton).toBe(false);
        expect(res.showShareOutside).toBe(true);
    });

    it('Row 2: Sharing outside off, any member may invite — Share with members, members only line, Invite someone button', () => {
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
            showShareOutside: false,
        });

        expect(shareSays(undefined)).toEqual({
            membersLine: null,
            outsideLine: null,
            showInviteButton: false,
            showShareOutside: false,
        });

        expect(shareSays({})).toEqual({
            membersLine: null,
            outsideLine: null,
            showInviteButton: false,
            showShareOutside: false,
        });

        expect(shareSays({ door: null, shareOutside: null })).toEqual({
            membersLine: null,
            outsideLine: null,
            showInviteButton: false,
            showShareOutside: false,
        });
    });
});
