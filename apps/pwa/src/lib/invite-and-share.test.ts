// @vitest-environment jsdom
/**
 * Invite and share on the web (lib/invite-and-share.ts): who is offered the button, what a tap asks the node for and what it
 * never makes, and the web app's own join path: an invite sent from a listing (`/app?invite=…&webjoin=1&post=<id>`, the
 * trampoline's Continue in browser) keeps the listing in the tab as an id and opens it when the friend has joined.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { inviteAndShareLink, linkedPostAtLoad, makeInviteForShare, offersInviteAndShare } from './invite-and-share';
import { LINKED_POST_STORAGE_KEY, takeKeptLinkedPost } from './visitor-lobby';
import { eventLink } from './event-extras';
import { extractInviteToken, formatInviteCode, normaliseInviteCode } from './invite-code';

const POST = '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a34';
const info = (features: Record<string, unknown> = {}) => ({ features } as any);

describe('who is offered the button', () => {
    it('a member where invites are on and any member may make them', () => {
        expect(offersInviteAndShare({ info: info({ door: 'members' }), role: undefined, hasKey: true, postId: POST })).toBe(true);
        expect(offersInviteAndShare({ info: info(), role: undefined, hasKey: true, postId: POST })).toBe(true);
    });
    it('nobody where the community takes no invites, no key, or no listing', () => {
        expect(offersInviteAndShare({ info: info({ invites: false }), role: undefined, hasKey: true, postId: POST })).toBe(false);
        expect(offersInviteAndShare({ info: info(), role: undefined, hasKey: false, postId: POST })).toBe(false);
        expect(offersInviteAndShare({ info: info(), role: undefined, hasKey: true, postId: '' })).toBe(false);
    });
    it('where only admins invite: owners and admins, not a member; a role not heard counts as before', () => {
        const admins = info({ door: 'admins' });
        expect(offersInviteAndShare({ info: admins, role: null, hasKey: true, postId: POST })).toBe(false);
        expect(offersInviteAndShare({ info: admins, role: 'moderator', hasKey: true, postId: POST })).toBe(false);
        expect(offersInviteAndShare({ info: admins, role: 'admin', hasKey: true, postId: POST })).toBe(true);
        expect(offersInviteAndShare({ info: admins, role: 'owner', hasKey: true, postId: POST })).toBe(true);
        expect(offersInviteAndShare({ info: admins, role: undefined, hasKey: true, postId: POST })).toBe(true);
    });
});

describe('what a tap asks the node for', () => {
    const made = (code: string) => (async () => ({ success: true, invite: { code } } as any));
    const refused = (status: number, code: string | undefined, message: string) => (async () => { throw Object.assign(new Error(message), { status, code }); });

    it('an invite, asked with the member\'s key and nothing else', async () => {
        const calls: unknown[][] = [];
        const make = (async (...a: unknown[]) => { calls.push(a); return { success: true, invite: { code: 'INV-AB12-CD34' } }; }) as any;
        expect(await makeInviteForShare('pk', make)).toEqual({ ok: true, code: 'INV-AB12-CD34' });
        expect(calls).toEqual([['pk']]);
    });

    it('is the link a share carries: the community, the invite and the listing', () => {
        expect(inviteAndShareLink('https://mullum.example', 'INV-AB12-CD34', POST)).toBe(`https://mullum.example/?invite=INV-AB12-CD34&post=${POST}`);
        // The event link a member shares is the same shape beside it: ?post= with no invite.
        expect(eventLink('https://mullum.example', POST)).toBe(`https://mullum.example/?post=${POST}`);
    });

    it('never an offline ticket: with no answer it says so', async () => {
        const down = async () => { throw new TypeError('Failed to fetch'); };
        const r = await makeInviteForShare('pk', down as any);
        expect(r).toMatchObject({ ok: false, offline: true });
        expect((r as { message: string }).message).toContain('needs a connection');
    });

    it('a refusal says the node\'s words; a reply with no code is no invite', async () => {
        expect(await makeInviteForShare('pk', refused(403, 'admins_only', 'Only admins invite here.') as any)).toEqual({ ok: false, offline: false, message: 'Only admins invite here.' });
        expect(await makeInviteForShare('pk', refused(404, 'feature_off', 'This community takes no invites.') as any)).toEqual({ ok: false, offline: false, message: 'This community takes no invites.' });
        expect(await makeInviteForShare('pk', refused(403, 'paused', 'Your account here is paused.') as any)).toEqual({ ok: false, offline: false, message: 'Your account here is paused.' });
        // Any other refusal: the invite was not made, and nothing is shared.
        expect(await makeInviteForShare('pk', refused(400, undefined, 'Something else.') as any)).toEqual({ ok: false, offline: false, message: 'The invite was not made.' });
        expect(await makeInviteForShare('pk', (async () => ({ success: true })) as any)).toEqual({ ok: false, offline: false, message: 'The invite was not made.' });
        expect(await makeInviteForShare('pk', made('') as any)).toMatchObject({ ok: false });
    });
});

describe('the web app\'s join: the listing is kept for after the join', () => {
    const at = (path: string) => window.history.replaceState(null, '', path);
    beforeEach(() => { sessionStorage.clear(); at('/'); });

    it('an invite with a listing: nothing opens now, the id is kept in the tab and taken once at the join', () => {
        at(`/app?invite=INV-AB12-CD34&webjoin=1&post=${POST}`);
        expect(linkedPostAtLoad()).toBeNull();
        expect(JSON.parse(sessionStorage.getItem(LINKED_POST_STORAGE_KEY)!).id).toBe(POST);
        // Taken out of the address, the invite stays for the join page.
        expect(window.location.search).toBe('?invite=INV-AB12-CD34&webjoin=1');
        expect(takeKeptLinkedPost()).toBe(POST);
        expect(takeKeptLinkedPost()).toBeNull();
    });

    it('an invite with a listing that is no id keeps and opens nothing', () => {
        for (const bad of ['..%2F..%2Fetc', 'a%20b', 'https%3A%2F%2Fevil.example', '%3Cscript%3E']) {
            sessionStorage.clear();
            at(`/app?invite=INV-AB12-CD34&webjoin=1&post=${bad}`);
            expect(linkedPostAtLoad(), bad).toBeNull();
            expect(sessionStorage.getItem(LINKED_POST_STORAGE_KEY), bad).toBeNull();
        }
    });

    it('an invite with no listing: as it was, nothing kept', () => {
        at('/app?invite=INV-AB12-CD34&webjoin=1');
        expect(linkedPostAtLoad()).toBeNull();
        expect(sessionStorage.getItem(LINKED_POST_STORAGE_KEY)).toBeNull();
        expect(window.location.search).toBe('?invite=INV-AB12-CD34&webjoin=1');
    });

    it('a shared listing with no invite is read as it always was, for a member', () => {
        at(`/?post=${POST}`);
        expect(linkedPostAtLoad()).toBe(POST);
        expect(sessionStorage.getItem(LINKED_POST_STORAGE_KEY)).toBeNull();
        expect(window.location.search).toBe('');
    });
});

describe('the link, read by a web app that never heard of it', () => {
    const LINK = `https://mullum.example/?invite=INV-AB12-CD34&post=${POST}`;
    it('still gives the code to the web join box', () => {
        expect(extractInviteToken(LINK)).toBe('INV-AB12-CD34');
        expect(normaliseInviteCode(LINK)).toBe('INV-AB12-CD34');
        expect(formatInviteCode(LINK)).toBe('INV-AB12-CD34');
        // As the address bar holds it after the trampoline's Continue in browser.
        expect(normaliseInviteCode(`?invite=INV-AB12-CD34&webjoin=1&post=${POST}`)).toBe('INV-AB12-CD34');
    });
});
