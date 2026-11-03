import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// No identity: the save is being checked for what it remembers, not for the signature the shared `request` wrapper adds.
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));

import { updateMemberProfile } from './api';
import { lastPhotoFrom, lastPhotoToOffer, readLastPhoto, rememberLastPhoto } from './last-photo';

/**
 * Profile S3: the picture a member used last is kept in this browser only so joining another community can OFFER it.
 * What is kept, when it moves, and when it is offered (core's one rule, the phone's too).
 */

const DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const FIRST = 'https://first.example.test';
const HERE = 'https://second.example.test';
const fetchMock = vi.fn();
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('what is kept', () => {
    it('keeps a photo and the community it was set in, as that community\'s origin', () => {
        rememberLastPhoto(DATA, 'https://First.Example.test/some/path');
        expect(readLastPhoto()).toEqual({ avatar: DATA, from: FIRST });
    });

    it('keeps a ready-made picture the same way, and the newest replaces the one before', () => {
        rememberLastPhoto(DATA, FIRST);
        rememberLastPhoto('bundled://sun', HERE);
        expect(readLastPhoto()).toEqual({ avatar: 'bundled://sun', from: HERE });
    });

    it('keeps nothing that cannot travel: a node\'s picture URL, an empty value, a missing one', () => {
        rememberLastPhoto(DATA, FIRST);
        for (const no of ['/api/avatar/abc?size=thumb', 'https://a.example/x.jpg', '', null, undefined]) rememberLastPhoto(no, HERE);
        expect(readLastPhoto()).toEqual({ avatar: DATA, from: FIRST });
    });

    it('reads damaged storage as none, and a photo kept without its community as "not known"', () => {
        localStorage.setItem('bp_last_photo', '{not json');
        expect(readLastPhoto()).toBeNull();
        localStorage.setItem('bp_last_photo', JSON.stringify({ avatar: '/api/avatar/x' }));
        expect(readLastPhoto()).toBeNull();
        localStorage.setItem('bp_last_photo', JSON.stringify({ avatar: DATA }));
        expect(readLastPhoto()).toEqual({ avatar: DATA, from: null });
    });
});

describe('what is offered', () => {
    it('offers the photo to a community that holds none, naming the one it came from by its host', () => {
        rememberLastPhoto(DATA, FIRST);
        const offer = lastPhotoToOffer(HERE, null)!;
        expect(offer).toEqual({ avatar: DATA, from: FIRST });
        expect(lastPhotoFrom(offer)).toBe('first.example.test');
        expect(lastPhotoFrom({ avatar: DATA, from: null })).toBeNull();
    });

    it('offers nothing where the community already holds a photo, where the photo was set, or when none was used', () => {
        expect(lastPhotoToOffer(HERE, null)).toBeNull();
        rememberLastPhoto(DATA, FIRST);
        expect(lastPhotoToOffer(HERE, '/api/avatar/abc?size=thumb&v=1&k=2')).toBeNull();
        expect(lastPhotoToOffer(`${FIRST}/`, null)).toBeNull();
        expect(lastPhotoToOffer('HTTPS://FIRST.example.test:443', null)).toBeNull();
    });
});

describe('a save the node took', () => {
    it('remembers the photo that was saved, in the community the web app talks to', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, profile: { publicKey: 'k', avatar: DATA, bio: '', contact: null } }));
        await updateMemberProfile('k', { avatar: DATA });
        expect(readLastPhoto()).toEqual({ avatar: DATA, from: window.location.origin });
    });

    it('leaves it alone when the save carries no photo, or a value that cannot travel', async () => {
        rememberLastPhoto(DATA, FIRST);
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, profile: {} }));
        await updateMemberProfile('k', { bio: 'hello' });
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, profile: {} }));
        await updateMemberProfile('k', { avatar: null });
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, profile: {} }));
        await updateMemberProfile('k', { avatar: '/api/avatar/k?size=thumb' });
        expect(readLastPhoto()).toEqual({ avatar: DATA, from: FIRST });
    });

    it('a save the node refuses remembers nothing', async () => {
        fetchMock.mockResolvedValueOnce(reply(400, { error: 'Invalid avatar' }));
        await expect(updateMemberProfile('k', { avatar: DATA })).rejects.toThrow();
        expect(readLastPhoto()).toBeNull();
    });
});
