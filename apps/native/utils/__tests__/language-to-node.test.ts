/**
 * The language the phone writes in, told to its node (Marty's call M6; translation design §3): `X-Language` on every signed
 * request through db.ts — `signedRequest` and `signedRequestWithMethod` (review of #1954, N4) — exactly as LANGS spells
 * it, following a switch at once, and never the pseudo-locale. Not signed: the signature covers what it always did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// db.ts pulls in device modules at import time; stubbed at the boundary as enterprise-season-api.test.ts does.
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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me-pub', privateKey: 'me-priv', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { setLanguage } from '@beanpool/core';
import { signedRequest, signedRequestWithMethod } from '../db';
import { buildSignedHeaders } from '../crypto';

const fetchMock = vi.fn();
const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply({ success: true }));
    (buildSignedHeaders as any).mockClear();
    (globalThis as any).fetch = fetchMock;
});
afterEach(() => setLanguage('en'));

describe('X-Language on signed requests', () => {
    it('signedRequestWithMethod carries the language, follows a switch at once, and signs only what it always signed', async () => {
        await signedRequestWithMethod('PATCH', '/api/community/me/consent', { version: 'v1' });
        expect(fetchMock.mock.calls[0][1].headers).toEqual({
            'Content-Type': 'application/json', Accept: 'application/json',
            'X-Signed': 'PATCH https://test.beanpool.org/api/community/me/consent', 'X-Language': 'en',
        });
        setLanguage('ru');
        await signedRequestWithMethod('DELETE', '/api/x');
        expect(fetchMock.mock.calls[1][1].headers['X-Language']).toBe('ru');
        setLanguage('zh-Hant');
        await signedRequestWithMethod('PUT', '/api/x', {});
        expect(fetchMock.mock.calls[2][1].headers['X-Language']).toBe('zh-Hant');
        // The signature is over method, URL and body, as before: the language is beside it, not in it.
        expect(buildSignedHeaders).toHaveBeenCalledWith('PUT', 'https://test.beanpool.org/api/x', '{}', 'me-priv', 'me-pub');
    });

    it('signedRequest carries it too, and never the pseudo-locale', async () => {
        setLanguage('fr');
        await signedRequest('/api/x', { a: 1 });
        expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'X-Signed': 'POST https://test.beanpool.org/api/x', 'X-Language': 'fr' });
        setLanguage('xx');
        await signedRequest('/api/x', { a: 1 });
        expect(fetchMock.mock.calls[1][1].headers['X-Language']).toBe('en');
    });
});
