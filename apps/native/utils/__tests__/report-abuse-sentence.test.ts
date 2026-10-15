/**
 * The post and event report forms show a failed report's message to the member (app/post/[id].tsx, components/
 * EventDetail.tsx): it is the node's sentence when it sent one beside its code, never the code. A report on a post that
 * is no longer at the community answers 404 `{ error: 'not_found', message: 'That post is not here any more.' }`.
 * Nothing here contacts a node: fetch is a stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// db.ts pulls in device modules at import time; stub them at the boundary (same set as decisions-list-fetch.test.ts).
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
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { reportAbuse, signedRequest } from '../db';
import { reportKind } from '@beanpool/core';

const fetchMock = vi.fn();
const reply = (status: number, body: any) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

describe('reportAbuse (native)', () => {
    it("a report on a post that is no longer there fails with the node's sentence, the code kept beside it", async () => {
        fetchMock.mockResolvedValueOnce(reply(404, { error: 'not_found', message: 'That post is not here any more.' }));
        const err: any = await reportAbuse('me-pub', 'them-pub', 'Spam', 'post-gone').catch(e => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('That post is not here any more.');
        expect(err.code).toBe('not_found');
        expect(err.status).toBe(404);
    });

    it('an answer with no sentence keeps what the node said', async () => {
        fetchMock.mockResolvedValueOnce(reply(400, { error: 'Failed — must be a registered member, cannot report yourself' }));
        const err: any = await reportAbuse('me-pub', 'me-pub', 'Spam').catch(e => e);
        expect(err.message).toBe('Failed — must be a registered member, cannot report yourself');
        expect(err.status).toBe(400);
    });

    it('a report the node takes answers as before', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, report: { id: 'r1' } }));
        expect(await reportAbuse('me-pub', 'them-pub', 'Spam or scam', 'post-1')).toEqual({ success: true, report: { id: 'r1' } });
    });

    // #1938 confirmation 9: a report naming a post's, an event's or an enterprise's id goes with the member's words only
    // where refuseReadableIntoDm lets readable words through; this file's phone has no database, so the guard can't tell,
    // and the reason picked goes alone, saying why ('unread'). A report is never held up. dm-line-binding's GXR measures
    // the known DM's id ('private').
    const sentReason = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body).reason;
    it('words with an id the guard can\'t tell: the reason picked goes alone, and the answer says why (unread)', async () => {
        fetchMock.mockResolvedValue(reply(201, { success: true }));
        expect(await reportAbuse('me-pub', 'them-pub', 'Child safety: he asked my son for photos', 'ev-1')).toEqual({ success: true, wordsLeftOut: 'unread' });
        expect(sentReason()).toBe('Child safety');
        expect(await reportAbuse('me-pub', 'them-pub', 'Spam or scam: the code is 4821', 'ent-1')).toEqual({ success: true, wordsLeftOut: 'unread' });
        expect(sentReason()).toBe('Spam or scam');
        // Words with no reason the list knows: "Other", never the words.
        expect(await reportAbuse('me-pub', 'them-pub', 'the code is 4821', 'post-1')).toEqual({ success: true, wordsLeftOut: 'unread' });
        expect(sentReason()).toBe('Other');
    });

    // GXR10 (#1938 confirmation 10, finding 1, the director's ruling (i)): with the words left out, the server's own rule over
    // the full reason (@beanpool/core reportKind) still decides child safety: words that say it under another reason go as
    // "Child safety" (never the words); ordinary words under that reason go as the reason picked.
    it('words left out that say child safety under another reason go as "Child safety"; ordinary words go as the reason picked', async () => {
        fetchMock.mockResolvedValue(reply(201, { success: true }));
        const child = 'Offensive content: he is grooming a child, sexual abuse of a minor';
        expect(reportKind(child)).toBe('child safety');
        expect(await reportAbuse('me-pub', 'them-pub', child, 'ev-1')).toEqual({ success: true, wordsLeftOut: 'unread' });
        expect(sentReason()).toBe('Child safety');
        expect(reportKind(sentReason())).toBe('child safety');
        expect(await reportAbuse('me-pub', 'them-pub', 'Other: about child safety at the pool', 'post-1')).toEqual({ success: true, wordsLeftOut: 'unread' });
        expect(sentReason()).toBe('Child safety');
        expect(await reportAbuse('me-pub', 'them-pub', 'Offensive content: shouted at the market', 'ev-1')).toEqual({ success: true, wordsLeftOut: 'unread' });
        expect(sentReason()).toBe('Offensive content');
        expect(reportKind(sentReason())).toBe('offensive content');
        expect(fetchMock.mock.calls.map((c) => c[1].body).join(' ')).not.toMatch(/grooming|minor|pool|shouted/);
    });

    it('a reason with no words (or only spaces) and a member report with no id go as they are, never asking the guard', async () => {
        fetchMock.mockResolvedValue(reply(201, { success: true }));
        expect(await reportAbuse('me-pub', 'them-pub', 'Child safety', 'ev-1')).toEqual({ success: true });
        expect(sentReason()).toBe('Child safety');
        expect(await reportAbuse('me-pub', 'them-pub', 'Other:   ', 'post-1')).toEqual({ success: true });
        expect(sentReason()).toBe('Other:   ');
        expect(await reportAbuse('me-pub', 'them-pub', 'Offensive content: shouted at the market')).toEqual({ success: true });
        expect(sentReason()).toBe('Offensive content: shouted at the market');
    });

    it("other signed requests keep the node's code as their message, for the callers that match on it", async () => {
        fetchMock.mockResolvedValueOnce(reply(404, { error: 'not_found', message: 'That post is not here any more.' }));
        const err: any = await signedRequest('/api/anything', {}).catch(e => e);
        expect(err.message).toBe('not_found');
        expect(err.nodeMessage).toBe('That post is not here any more.');
    });
});
