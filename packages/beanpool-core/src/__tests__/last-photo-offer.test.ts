import { describe, it, expect } from 'vitest';
import { lastPhotoOffer, communityHostOf, photoCanTravel } from '../index.js';

// Profile S3: the last photo is OFFERED on joining a community that holds none for the member, and nothing else
// ever reads it. This is the one rule the phone and the web both ask.

const DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const PRESET = 'bundled://bean-green';

describe('lastPhotoOffer', () => {
    it('offers a picked photo to a community that holds none for the member', () => {
        expect(lastPhotoOffer({ last: { avatar: DATA, from: 'https://a.example' }, hereAvatar: null, setHere: false }))
            .toEqual({ avatar: DATA, from: 'https://a.example' });
    });

    it('offers a ready-made picture the member chose, the same way', () => {
        expect(lastPhotoOffer({ last: { avatar: PRESET, from: null }, hereAvatar: undefined, setHere: false }))
            .toEqual({ avatar: PRESET, from: null });
    });

    it('offers nothing when the member has never chosen a photo', () => {
        expect(lastPhotoOffer({ last: null, hereAvatar: null, setHere: false })).toBeNull();
        expect(lastPhotoOffer({ last: undefined, hereAvatar: null, setHere: false })).toBeNull();
    });

    it('offers nothing when this community already holds a photo for the member: that is the truth here', () => {
        expect(lastPhotoOffer({ last: { avatar: DATA, from: 'https://a.example' }, hereAvatar: '/api/avatar/abc?size=thumb&v=1', setHere: false })).toBeNull();
        expect(lastPhotoOffer({ last: { avatar: DATA, from: null }, hereAvatar: PRESET, setHere: false })).toBeNull();
    });

    it('treats empty, "null" and "undefined" strings as no photo here', () => {
        for (const none of ['', '   ', 'null', 'undefined']) {
            expect(lastPhotoOffer({ last: { avatar: DATA, from: null }, hereAvatar: none, setHere: false }), `[${none}]`).not.toBeNull();
        }
    });

    it('offers nothing when the last photo was set in this very community', () => {
        expect(lastPhotoOffer({ last: { avatar: DATA, from: 'https://a.example' }, hereAvatar: null, setHere: true })).toBeNull();
    });

    it('never offers a value that cannot travel: a node URL, a device file, junk', () => {
        for (const bad of ['/api/avatar/abc?size=thumb', 'https://a.example/api/avatar/abc', 'file:///data/user/0/x.jpg', '', 'null', 'undefined']) {
            expect(lastPhotoOffer({ last: { avatar: bad, from: null }, hereAvatar: null, setHere: false }), bad).toBeNull();
        }
    });
});

describe('photoCanTravel', () => {
    it('is true for a picture itself or a shipped one, and false for anything that names a place or nothing', () => {
        expect(photoCanTravel(DATA)).toBe(true);
        expect(photoCanTravel('DATA:image/png;base64,iVBOR')).toBe(true);
        expect(photoCanTravel(PRESET)).toBe(true);
        for (const no of ['/api/avatar/abc?size=thumb', 'https://a.example/x.jpg', 'file:///x.jpg', '', '  ', 'null', 'undefined', null, undefined, 7]) {
            expect(photoCanTravel(no), String(no)).toBe(false);
        }
    });
});

describe('communityHostOf', () => {
    it('reads the host of an address, in lower case, and nothing else', () => {
        expect(communityHostOf('https://Mullum.Beanpool.org')).toBe('mullum.beanpool.org');
        expect(communityHostOf('https://mullum.beanpool.org:8443/path?x=1')).toBe('mullum.beanpool.org:8443');
        expect(communityHostOf('http://user:pw@host.example/')).toBe('host.example');
    });

    it('is null for anything that is not an address', () => {
        expect(communityHostOf(null)).toBeNull();
        expect(communityHostOf(undefined)).toBeNull();
        expect(communityHostOf('')).toBeNull();
        expect(communityHostOf('not an address')).toBeNull();
    });
});
