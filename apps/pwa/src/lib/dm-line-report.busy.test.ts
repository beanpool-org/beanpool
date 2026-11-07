/**
 * Report on a message request, met by a busy network (core busy-answer.ts; lib/dm-line-report.ts). Deciding review of #2960
 * (round 2): Cloudflare's 429 in front of a node was read as the moderators' hourly limit (`over_limit`), so Report blocked
 * the sender with NO report (Child safety included) and told the member "You have sent a lot of reports recently". A busy
 * network is no answer from the node: nothing is blocked, the busy sentence shows, the card stays, and a second try sends the
 * report. The node's OWN report limit (its JSON 429) is not busy and still blocks without a report.
 *
 * The whole chain is real (lib/api.ts request -> refusalError -> busyError -> core requestReportRefused); only fetch, the
 * identity, the block list and the conversation read are stubbed. Nothing here contacts a node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { setLanguage, toEd25519Pkcs8 } from '@beanpool/core';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 21);
const PUB = bytesToHex(ed25519.getPublicKey(SEED));
const IDENTITY = { publicKey: PUB, privateKey: bytesToHex(toEd25519Pkcs8(SEED)), callsign: 'Ana', createdAt: '2026-10-05T00:00:00.000Z' };

const mocks = vi.hoisted(() => ({
    loadIdentity: vi.fn(),
    blockUser: vi.fn(),
    getConversationMessages: vi.fn(),
    requestPreviewLines: vi.fn(),
}));
vi.mock('./identity', () => ({ loadIdentity: mocks.loadIdentity }));
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), getConversationMessages: mocks.getConversationMessages }));
vi.mock('./blocklist', async (importOriginal) => ({ ...(await importOriginal<typeof import('./blocklist')>()), blockUser: mocks.blockUser }));
vi.mock('./dm-requests', async (importOriginal) => ({ ...(await importOriginal<typeof import('./dm-requests')>()), requestPreviewLines: mocks.requestPreviewLines }));

import { reportRequestAndBlock } from './dm-line-report';
import { BlocklistError } from './blocklist';

const BUSY = 'Busy right now. Try again in a moment.';
const CF_HTML = '<!DOCTYPE html><html lang="en-US"><head><title>Access denied | global.beanpool.org used Cloudflare to restrict access</title></head>'
    + '<body><span class="cf-error-code">1015</span><h1>You are being rate limited</h1></body></html>';
const fetchMock = vi.fn();

/** Cloudflare's answer: not JSON, and maybe a Retry-After. */
const cloudflare = (status = 429, retryAfter?: string) => ({
    ok: false, status, statusText: 'Too Many Requests',
    headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}),
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    text: async () => CF_HTML,
});
const nodeJson = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300, status, statusText: status === 429 ? 'Too Many Requests' : 'OK',
    headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body),
});

const CONV = { id: 'c1', request: { from: 'bo-pubkey', to: PUB, state: 'pending', at: '2026-11-01T09:00:00.000Z' } } as any;
const ME = { publicKey: PUB, privateKey: IDENTITY.privateKey };

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    mocks.loadIdentity.mockReset().mockResolvedValue(IDENTITY);
    mocks.blockUser.mockReset().mockResolvedValue(true);
    mocks.getConversationMessages.mockReset().mockResolvedValue({ messages: [{ id: 'm1', type: 'text', ciphertext: 'cc', nonce: 'nn', metadata: {} }] });
    mocks.requestPreviewLines.mockReset().mockReturnValue([{ id: 'm1', words: 'Buy my crypto' }]);
});
afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('en');
});

const thrown = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('did not throw'); };
const reportCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/messages/report'));

describe('Report on a request, when the network in front of the node is busy', () => {
    it('blocks nobody, throws the busy sentence for the card to show, and sends the report once (a write is never resent)', async () => {
        fetchMock.mockResolvedValue(cloudflare(429, '2'));
        const err = await thrown(reportRequestAndBlock(CONV, ME, 'Child safety: they asked my age'));
        expect(err.message).toBe(BUSY);
        expect(err.code).toBe('busy');
        expect(mocks.blockUser).not.toHaveBeenCalled();
        expect(reportCalls()).toHaveLength(1);
    });

    it('says nothing about the hourly limit, and a second try sends the report and then blocks', async () => {
        fetchMock.mockResolvedValueOnce(cloudflare(429));
        const first = await thrown(reportRequestAndBlock(CONV, ME, 'Harassment'));
        expect(first.message).not.toMatch(/lot of reports|blocked/);
        expect(mocks.blockUser).not.toHaveBeenCalled();

        fetchMock.mockResolvedValueOnce(nodeJson(200, { success: true }));
        await expect(reportRequestAndBlock(CONV, ME, 'Harassment')).resolves.toBe('reported');
        expect(reportCalls()).toHaveLength(2);
        expect(mocks.blockUser).toHaveBeenCalledTimes(1);
        expect(mocks.blockUser).toHaveBeenCalledWith('bo-pubkey');
    });

    it("the node's own report limit (its JSON 429) is not busy: it still blocks, with no report, and says so", async () => {
        fetchMock.mockResolvedValueOnce(nodeJson(429, { error: 'You have sent a lot of reports recently. Please try again in an hour.', code: 'rate_limited' }));
        await expect(reportRequestAndBlock(CONV, ME, 'Harassment')).resolves.toBe('over_limit');
        expect(mocks.blockUser).toHaveBeenCalledWith('bo-pubkey');
    });

    it('a busy answer to the block after the report went says the report went and the block did not', async () => {
        fetchMock.mockResolvedValueOnce(nodeJson(200, { success: true }));
        mocks.blockUser.mockRejectedValueOnce(new BlocklistError(BUSY, 429, 'busy'));
        const err = await thrown(reportRequestAndBlock(CONV, ME, 'Harassment'));
        expect(err.message).toBe('Reported, but not blocked. Please try again.');
    });
});
