import { describe, expect, it } from 'vitest';
import { inviteAndShareLink, landingPostId, postIdFromInviteLink } from './invite-and-share.js';

const UUID = '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a34';

describe('the link invite-and-share hands the share sheet', () => {
    it('is the community, the invite and the listing', () => {
        expect(inviteAndShareLink('https://mullum.beanpool.org', 'INV-AB12-CD34', UUID))
            .toBe(`https://mullum.beanpool.org/?invite=INV-AB12-CD34&post=${UUID}`);
    });

    it('is the plain invite link, byte for byte, with no listing', () => {
        expect(inviteAndShareLink('https://mullum.beanpool.org', 'INV-AB12-CD34')).toBe('https://mullum.beanpool.org/?invite=INV-AB12-CD34');
        expect(inviteAndShareLink('https://mullum.beanpool.org', 'INV-AB12-CD34', null)).toBe('https://mullum.beanpool.org/?invite=INV-AB12-CD34');
    });

    it('leaves out an id that is not one: a path, a query or an address rides nowhere', () => {
        for (const bad of ['../../etc', 'a b', 'a&invite=EVIL', 'https://evil.example', 'x'.repeat(101), '', '<script>']) {
            expect(inviteAndShareLink('https://n.example', 'INV-AB12-CD34', bad)).toBe('https://n.example/?invite=INV-AB12-CD34');
        }
    });
});

describe('the listing an invite link carries', () => {
    it('is read from a link, a deep link and a Play referrer', () => {
        expect(postIdFromInviteLink(`https://n.example/?invite=INV-AB12-CD34&post=${UUID}`)).toBe(UUID);
        expect(postIdFromInviteLink(`beanpool://welcome?invite=INV-AB12-CD34&server=https%3A%2F%2Fn.example&post=${UUID}`)).toBe(UUID);
        expect(postIdFromInviteLink(`invite=INV-AB12-CD34&server=https://n.example&post=${UUID}`)).toBe(UUID);
        expect(postIdFromInviteLink(`Join: https://n.example/?post=${UUID}&invite=INV-AB12-CD34`)).toBe(UUID);
    });

    it('is nothing without an invite: a shared listing is a shared listing', () => {
        expect(postIdFromInviteLink(`https://n.example/?post=${UUID}`)).toBeNull();
        expect(postIdFromInviteLink(`https://n.example/?peek=T&post=${UUID}`)).toBeNull();
    });

    it('is nothing for an invite with no listing, an empty one, or an id that is not one', () => {
        expect(postIdFromInviteLink('https://n.example/?invite=INV-AB12-CD34')).toBeNull();
        expect(postIdFromInviteLink('https://n.example/?invite=INV-AB12-CD34&post=')).toBeNull();
        expect(postIdFromInviteLink('https://n.example/?invite=INV-AB12-CD34&post=..%2F..%2Fetc')).toBeNull();
        expect(postIdFromInviteLink('https://n.example/?invite=INV-AB12-CD34&post=%E0%A4%A')).toBeNull();
        expect(postIdFromInviteLink('https://n.example/?invite=INV-AB12-CD34&post=a%26b')).toBeNull();
        expect(postIdFromInviteLink(null)).toBeNull();
        expect(postIdFromInviteLink(undefined)).toBeNull();
    });

    it('checks an id as an id', () => {
        expect(landingPostId(UUID)).toBe(UUID);
        expect(landingPostId('sample-ladder')).toBe('sample-ladder');
        expect(landingPostId('a/b')).toBeNull();
        expect(landingPostId(42)).toBeNull();
    });
});
