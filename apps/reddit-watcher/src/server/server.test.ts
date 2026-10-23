// The endpoint as Devvit calls it: a real HTTP request to onReq, with Devvit's settings and Redis stood in for and
// fetch stubbed, so nothing leaves this machine.

import { request, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TOPIC = 'https://ntfy.sh/bp-control-room-TEST0secret0topic';
const INBOX = 'https://ntfy.sh/bp-inbox-TEST0secret0inbox';
const store = vi.hoisted(() => ({ values: new Map<string, number>(), secrets: {} as Record<string, string> }));

vi.mock('@devvit/web/server', () => ({
    settings: { get: async (name: string) => store.secrets[name] },
    redis: {
        incrBy: async (key: string, by: number) => {
            const n = (store.values.get(key) ?? 0) + by;
            store.values.set(key, n);
            return n;
        },
        expire: async () => undefined,
        del: async (key: string) => {
            store.values.delete(key);
        },
    },
}));

const { onReq, NEW_ITEM } = await import('./server');

let server: Server;
let port = 0;
const fetchMock = vi.fn(async () => ({ status: 200 }));

beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    server = createServer(onReq);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    vi.unstubAllGlobals();
    await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
    store.values.clear();
    store.secrets = { ntfyUrl: TOPIC };
    fetchMock.mockClear();
});

function call(method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (text += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

const newPost = JSON.stringify({
    type: 'PostCreate',
    post: { id: 't3_abc123', title: 'Hello', permalink: '/r/beanpool/comments/abc123/hello/' },
    author: { name: 'Some_Member' },
    subreddit: { name: 'beanpool' },
});

describe('the trigger endpoint', () => {
    it('answers a new post with {} and sends one notice to the topic', async () => {
        expect(await call('POST', NEW_ITEM, newPost)).toEqual({ status: 200, body: '{}' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(TOPIC);
        expect(init.body).toBe('Hello\nhttps://www.reddit.com/r/beanpool/comments/abc123/hello/');
    });

    it('sends nothing for the same post delivered again', async () => {
        await call('POST', NEW_ITEM, newPost);
        await call('POST', NEW_ITEM, newPost);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('answers {} to a body that is not JSON, and sends nothing', async () => {
        expect(await call('POST', NEW_ITEM, '{not json')).toEqual({ status: 200, body: '{}' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('with the inbox set, also sends the item to the inbox topic, once', async () => {
        store.secrets = { ntfyUrl: TOPIC, agentNtfyUrl: INBOX };
        expect(await call('POST', NEW_ITEM, newPost)).toEqual({ status: 200, body: '{}' });
        await call('POST', NEW_ITEM, newPost);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
        const sentTo = new Map(calls.map(([url, init]) => [url, String(init.body)]));
        expect(sentTo.get(TOPIC)).toBe('Hello\nhttps://www.reddit.com/r/beanpool/comments/abc123/hello/');
        expect(JSON.parse(sentTo.get(INBOX) ?? '')).toMatchObject({ v: 1, kind: 'post', id: 't3_abc123', title: 'Hello' });
        expect(sentTo.get(INBOX)).not.toContain('Some_Member');
    });

    it('serves nothing else', async () => {
        expect((await call('GET', NEW_ITEM)).status).toBe(404);
        expect((await call('POST', '/internal/triggers/other', newPost)).status).toBe(404);
        expect((await call('POST', '/api/anything', newPost)).status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
