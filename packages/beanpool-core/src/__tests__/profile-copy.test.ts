import { describe, it, expect } from 'vitest';
import { profileCopySend, photoToCopyHere } from '../index.js';

// Profile S4: a copy carries exactly what the member ticked, and nothing else. This is the one rule the phone and the web
// both ask.

const DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const PRESET = 'bundled://bean-green';
const NODE_URL = '/api/avatar/abc?size=thumb&v=1&k=2';

describe('profileCopySend', () => {
    it('both ticked: the name and the photo, and no other field', () => {
        const send = profileCopySend({ callsign: 'Rosa', photo: DATA }, { name: true, photo: true });
        expect(send).toEqual({ callsign: 'Rosa', avatar: DATA });
        expect(Object.keys(send!).sort()).toEqual(['avatar', 'callsign']);
    });

    it('only the name ticked: no photo is carried, though one exists', () => {
        expect(profileCopySend({ callsign: 'Rosa', photo: DATA }, { name: true, photo: false })).toEqual({ callsign: 'Rosa' });
    });

    it('only the photo ticked: no name is carried, though one exists', () => {
        expect(profileCopySend({ callsign: 'Rosa', photo: PRESET }, { name: false, photo: true })).toEqual({ avatar: PRESET });
    });

    it('neither ticked: nothing is sent at all', () => {
        expect(profileCopySend({ callsign: 'Rosa', photo: DATA }, { name: false, photo: false })).toBeNull();
    });

    it('a ticked box with nothing behind it adds nothing, and does not stand in for the other', () => {
        // A node's own picture URL names a place, not a picture: it cannot travel.
        expect(profileCopySend({ callsign: 'Rosa', photo: NODE_URL }, { name: false, photo: true })).toBeNull();
        expect(profileCopySend({ callsign: 'Rosa', photo: NODE_URL }, { name: true, photo: true })).toEqual({ callsign: 'Rosa' });
        expect(profileCopySend({ callsign: '  ', photo: DATA }, { name: true, photo: true })).toEqual({ avatar: DATA });
        expect(profileCopySend({ callsign: 'null', photo: null }, { name: true, photo: true })).toBeNull();
        expect(profileCopySend({ callsign: undefined, photo: undefined }, { name: true, photo: true })).toBeNull();
    });

    it('trims what it sends', () => {
        expect(profileCopySend({ callsign: '  Rosa ', photo: `  ${DATA} ` }, { name: true, photo: true })).toEqual({ callsign: 'Rosa', avatar: DATA });
    });
});

describe('photoToCopyHere', () => {
    it('is the photo the browser kept from another community', () => {
        expect(photoToCopyHere({ last: { avatar: DATA, from: 'https://a.example' }, setHere: false }))
            .toEqual({ avatar: DATA, from: 'https://a.example' });
    });

    it('stands when this community already holds a photo: the member asked, so it is theirs to replace', () => {
        // lastPhotoOffer, the offer on joining, is silent there; this one takes no row, so it cannot be.
        expect(Object.keys(photoToCopyHere({ last: { avatar: PRESET, from: null }, setHere: false })!).sort()).toEqual(['avatar', 'from']);
        expect(photoToCopyHere({ last: { avatar: PRESET, from: null }, setHere: false })).toEqual({ avatar: PRESET, from: null });
    });

    it('is nothing when there is no last photo, it cannot travel, or it was set in this very community', () => {
        expect(photoToCopyHere({ last: null, setHere: false })).toBeNull();
        expect(photoToCopyHere({ last: undefined, setHere: false })).toBeNull();
        expect(photoToCopyHere({ last: { avatar: NODE_URL, from: 'https://a.example' }, setHere: false })).toBeNull();
        expect(photoToCopyHere({ last: { avatar: DATA, from: 'https://a.example' }, setHere: true })).toBeNull();
    });
});
