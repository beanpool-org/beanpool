import { describe, it, expect, vi, beforeEach } from 'vitest';

// db.ts pulls in device modules at import time; stub them at the boundary (same set as apply-delta.test.ts).
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('../identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'me-pub', privateKey: 'me-priv', callsign: 'Me' })),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, path: string) => ({ 'X-Signed': `${method} ${path}` })),
}));

import { fetchMemberPreferences, fetchMyEvents, isRouteMissing, setEventReminder } from '../db';
import { buildSignedHeaders } from '../crypto';

const fetchMock = vi.fn();

function reply(status: number, body: any) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

const row = (postId: string, startAt: string, over: Record<string, unknown> = {}) => ({
    postId, title: postId, startAt, endAt: null, placeName: null, rsvp: 'going', photo: null, reminderOffsets: null, ...over,
});

beforeEach(() => {
    fetchMock.mockReset();
    (buildSignedHeaders as any).mockClear();
    (globalThis as any).fetch = fetchMock;
});

describe('fetchMyEvents — "Your events" (the shared contract)', () => {
    it('is a signed GET whose signature covers the path, with no member named in it', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, [row('ev-1', '2026-09-27T00:00:00Z')]));
        await fetchMyEvents();

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://test.beanpool.org/api/events/mine');
        expect(init.method).toBe('GET');
        // Whose list it is comes from the signature, never from a parameter.
        expect(url).not.toContain('publicKey');
        expect(buildSignedHeaders).toHaveBeenCalledWith('GET', '/api/events/mine', '', 'me-priv', 'me-pub');
    });

    it('puts the soonest first even when the node did not', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, [
            row('later', '2026-10-05T00:00:00Z'),
            row('sooner', '2026-09-27T00:00:00Z'),
        ]));
        expect((await fetchMyEvents()).map(r => r.postId)).toEqual(['sooner', 'later']);
    });

    it('throws a 404 an older node can be recognised by, rather than a plain failure', async () => {
        fetchMock.mockResolvedValueOnce(reply(404, {}));
        const err = await fetchMyEvents().catch(e => e);
        expect(isRouteMissing(err)).toBe(true);
    });

    it('surfaces any other refusal as a real error, which is NOT an older node', async () => {
        fetchMock.mockResolvedValueOnce(reply(401, { error: 'Signature required' }));
        const err = await fetchMyEvents().catch(e => e);
        expect(err.message).toBe('Signature required');
        expect(isRouteMissing(err)).toBe(false);
    });
});

describe('setEventReminder — one event’s own choice', () => {
    it('PUTs the offsets, signed over the exact path and body it sends', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
        await expect(setEventReminder('ev/1', [1440, 120])).resolves.toEqual({ success: true });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://test.beanpool.org/api/events/ev%2F1/reminder');
        expect(init.method).toBe('PUT');
        expect(init.body).toBe('{"offsets":[1440,120]}');
        expect(buildSignedHeaders).toHaveBeenCalledWith('PUT', '/api/events/ev%2F1/reminder', '{"offsets":[1440,120]}', 'me-priv', 'me-pub');
    });

    it('sends null to hand the event back to the member’s default', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
        await setEventReminder('ev-1', null);
        expect(fetchMock.mock.calls[0][1].body).toBe('{"offsets":null}');
    });

    it('sends an empty list for "no reminder on this one", which is not the same as null', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true }));
        await setEventReminder('ev-1', []);
        expect(fetchMock.mock.calls[0][1].body).toBe('{"offsets":[]}');
    });

    it("passes on the node's own refusal — e.g. an event the member has no RSVP on", async () => {
        fetchMock.mockResolvedValueOnce(reply(403, { error: 'You are not going to this event.' }));
        await expect(setEventReminder('ev-1', [30])).rejects.toThrow('You are not going to this event.');
    });

    it('marks a 404 as an older node, so the screen can hide the row instead of showing an error', async () => {
        fetchMock.mockResolvedValueOnce(reply(404, {}));
        const err = await setEventReminder('ev-1', [30]).catch(e => e);
        expect(isRouteMissing(err)).toBe(true);
    });
});

describe('fetchMemberPreferences — where the member’s default lives', () => {
    it('is a signed GET to the bag holiday_mode and the notify_* flags already use', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { holiday_mode: 'false', eventReminderOffsets: '[1440]' }));
        await expect(fetchMemberPreferences('me-pub')).resolves.toMatchObject({ eventReminderOffsets: '[1440]' });
        expect(fetchMock.mock.calls[0][0]).toBe('https://test.beanpool.org/api/members/preferences?publicKey=me-pub');
        expect(buildSignedHeaders).toHaveBeenCalledWith('GET', '/api/members/preferences', '', 'me-priv', 'me-pub');
    });
});
