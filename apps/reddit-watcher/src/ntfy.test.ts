import { describe, expect, it, vi } from 'vitest';
import { agentRequest, deliver, deliverAgent, ntfyRequest, SEEN_S, SEND_TIMEOUT_MS, topicUrl, type Deps } from './ntfy';
import type { Notice } from './notice';

// Stand-ins: never a real topic, token or send.
const TOPIC = 'https://ntfy.sh/bp-control-room-TEST0secret0topic';
const TOKEN = 'tk_TEST0secret0token';
const INBOX = 'https://ntfy.sh/bp-inbox-TEST0secret0inbox';

const post = {
    type: 'PostCreate',
    post: { id: 't3_abc123', title: 'How do I start a node?', selftext: 'My old laptop?', permalink: '/r/beanpool/comments/abc123/x/' },
    author: { name: 'Some_Member', accountType: 1 },
    subreddit: { name: 'beanpool' },
};
const comment = {
    type: 'CommentCreate',
    comment: { id: 't1_def456', postId: 't3_abc123', parentId: 't3_abc123', body: 'Try the guide', permalink: '/r/beanpool/comments/abc123/x/def456/' },
    post: post.post,
    author: { name: 'Other_Person', accountType: 1 },
    subreddit: { name: 'beanpool' },
};

type World = Deps & { sent: { url: string; init: RequestInit }[]; logs: string[]; seen: Map<string, number>; expires: Map<string, number> };

function world(opts: { url?: unknown; token?: unknown; agent?: unknown; quiet?: string; status?: number | 'throw'; redis?: 'throw'; settings?: 'throw' } = {}): World {
    const sent: World['sent'] = [];
    const logs: string[] = [];
    const seen = new Map<string, number>();
    const expires = new Map<string, number>();
    return {
        sent,
        logs,
        seen,
        expires,
        setting: async (name) => {
            if (opts.settings === 'throw') throw new Error('settings down');
            if (name === 'ntfyUrl') return 'url' in opts ? opts.url : TOPIC;
            if (name === 'agentNtfyUrl') return opts.agent;
            return name === 'ntfyToken' ? opts.token : opts.quiet;
        },
        firstTime: async (key) => {
            if (opts.redis === 'throw') throw new Error('redis down');
            const n = (seen.get(key) ?? 0) + 1;
            seen.set(key, n);
            if (n === 1) expires.set(key, SEEN_S);
            return n === 1;
        },
        forget: async (key) => {
            seen.delete(key);
        },
        fetch: async (url, init) => {
            sent.push({ url, init });
            if (opts.status === 'throw') throw new Error(`connect ECONNREFUSED ${url}`);
            return { status: opts.status ?? 200 };
        },
        log: (line) => logs.push(line),
    };
}

describe('topicUrl', () => {
    it('takes an https topic on ntfy.sh', () => {
        expect(topicUrl(TOPIC)?.href).toBe(TOPIC);
        expect(topicUrl(`  ${TOPIC}\n`)?.href).toBe(TOPIC);
    });

    it('refuses anything else, which Devvit would not fetch anyway', () => {
        for (const raw of [
            undefined, null, '', '   ', 42,
            'http://ntfy.sh/topic',
            'https://ntfy.example/topic',
            'https://ntfy.sh.evil.example/topic',
            'https://evil.example/ntfy.sh/topic',
            'https://ntfy.sh:8443/topic',
            'https://user:pw@ntfy.sh/topic',
            'https://ntfy.sh/',
            'https://ntfy.sh/a/b',
            'https://ntfy.sh/topic?x=1',
            'https://ntfy.sh/topic#x',
            'https://ntfy.sh/has%20space',
            `https://ntfy.sh/${'t'.repeat(65)}`,
            'not a url',
        ]) {
            expect(topicUrl(raw), String(raw)).toBeNull();
        }
    });
});

describe('ntfyRequest', () => {
    const notice: Notice = { id: 't3_abc123', title: 'New post in r/beanpool', body: 'Как начать? 🌱\nhttps://www.reddit.com/r/beanpool/comments/abc123/x/', url: 'https://www.reddit.com/r/beanpool/comments/abc123/x/' };
    const topic = topicUrl(TOPIC)!;

    it('POSTs the body as the message, with the title, a tag and the link for a tap', () => {
        const { url, init } = ntfyRequest(notice, topic);
        expect(url).toBe(TOPIC);
        expect(init.method).toBe('POST');
        expect(init.body).toBe(notice.body);
        expect(init.headers).toEqual({
            'Content-Type': 'text/plain; charset=utf-8',
            Title: 'New post in r/beanpool',
            Tags: 'speech_balloon',
            Click: notice.url,
        });
    });

    it('never follows a redirect, and gives up on a send that stalls', () => {
        const { init } = ntfyRequest(notice, topic);
        expect(init.redirect).toBe('manual');
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.signal?.aborted).toBe(false);
    });

    it('sends the token as a bearer only when there is one', () => {
        expect(ntfyRequest(notice, topic, TOKEN).init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
        for (const token of [undefined, '', '  ', 7]) {
            expect(ntfyRequest(notice, topic, token).init.headers).not.toHaveProperty('Authorization');
        }
    });

    it('keeps the headers printable ASCII whatever the title', () => {
        const { init } = ntfyRequest({ ...notice, title: 'Nuevo en r/beanpool — ¡hola!' }, topic);
        expect((init.headers as Record<string, string>).Title).toBe('Nuevo en r/beanpool ? ?hola!');
    });
});

describe('deliver', () => {
    it('tells a new post once, though Devvit may deliver it twice', async () => {
        const w = world();
        expect(await deliver(post, w)).toBe('sent');
        expect(await deliver(post, w)).toBe('repeat');
        expect(w.sent).toHaveLength(1);
        expect(w.sent[0]?.url).toBe(TOPIC);
        expect(w.expires.get('seen:t3_abc123')).toBe(SEEN_S);
    });

    it('tells a post and a comment on it as two notices', async () => {
        const w = world();
        expect(await deliver(post, w)).toBe('sent');
        expect(await deliver(comment, w)).toBe('sent');
        expect(w.sent.map((s) => (s.init.headers as Record<string, string>).Title)).toEqual(['New post in r/beanpool', 'New comment in r/beanpool']);
    });

    it('sends the token when one is set', async () => {
        const w = world({ token: TOKEN });
        await deliver(post, w);
        expect(w.sent[0]?.init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    });

    it('sends nothing for what it skips, and marks nothing', async () => {
        const w = world();
        expect(await deliver({ ...post, post: { ...post.post, spam: true } }, w)).toBe('skipped');
        expect(await deliver({ type: 'ModAction' }, w)).toBe('skipped');
        expect(await deliver(null, w)).toBe('skipped');
        expect(w.sent).toHaveLength(0);
        expect(w.seen.size).toBe(0);
    });

    it('sends nothing for the team\'s own accounts (quietUsernames), and still for everyone else', async () => {
        const w = world({ quiet: 'u/Other_Person, someone-else' });
        expect(await deliver(comment, w)).toBe('skipped');
        expect(await deliver(post, w)).toBe('sent');
        expect(w.sent).toHaveLength(1);
        expect(w.logs.join('\n')).not.toContain('Other_Person');
    });

    it('sends nothing without a usable topic, and says how to set one', async () => {
        for (const url of [undefined, '', 'http://ntfy.sh/topic', 'https://ntfy.example/topic']) {
            const w = world({ url });
            expect(await deliver(post, w)).toBe('no-channel');
            expect(w.sent).toHaveLength(0);
            expect(w.logs.join('\n')).toContain('npx devvit settings set ntfyUrl');
            expect(w.logs.join('\n')).not.toContain('ntfy.example');
        }
        const down = world({ settings: 'throw' });
        expect(await deliver(post, down)).toBe('no-channel');
    });

    it('a failed send takes its mark off, so a repeat delivery tries again', async () => {
        const w = world({ status: 500 });
        expect(await deliver(post, w)).toBe('failed');
        expect(w.seen.has('seen:t3_abc123')).toBe(false);
        expect(w.logs.at(-1)).toBe('[reddit-watcher] a new post, not told: ntfy HTTP 500');
        expect(await deliver(post, w)).toBe('failed');
        expect(w.sent).toHaveLength(2);
    });

    it('an unreachable ntfy is a failed send too', async () => {
        const w = world({ status: 'throw' });
        expect(await deliver(comment, w)).toBe('failed');
        expect(w.logs.at(-1)).toBe('[reddit-watcher] a new comment, not told: ntfy unreachable');
    });

    it('a send that stalls gives up, takes its mark off, and a repeat delivery tries again', async () => {
        // ntfy takes the connection and never answers. A real fetch rejects when its signal aborts; so does this one,
        // and the deadline is cut from SEND_TIMEOUT_MS to 20 ms so the test does not wait it out.
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        const asked: number[] = [];
        const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
            asked.push(ms);
            return timeout(20);
        });
        try {
            const w = world();
            w.fetch = (url, init) => {
                w.sent.push({ url, init });
                return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
            };
            expect(await deliver(post, w)).toBe('failed');
            expect(asked).toEqual([SEND_TIMEOUT_MS]);
            expect(w.seen.has('seen:t3_abc123')).toBe(false);
            expect(w.logs.at(-1)).toBe('[reddit-watcher] a new post, not told: ntfy unreachable');
            expect(await deliver(post, w)).toBe('failed');
            expect(w.sent).toHaveLength(2);
        } finally {
            spy.mockRestore();
        }
    });

    it('tells it anyway when the repeat check is down', async () => {
        const w = world({ redis: 'throw' });
        expect(await deliver(post, w)).toBe('sent');
        expect(w.sent).toHaveLength(1);
    });

    it('never logs the topic, the token, who wrote it or what they wrote', async () => {
        const logs: string[] = [];
        for (const opts of [{}, { status: 403 }, { status: 'throw' as const }, { redis: 'throw' as const }, { url: 'https://ntfy.sh/a/b' }]) {
            const w = world({ token: TOKEN, ...opts });
            await deliver(post, w);
            await deliver(comment, w);
            logs.push(...w.logs);
        }
        const all = logs.join('\n');
        expect(logs.length).toBeGreaterThan(0);
        for (const secret of ['TEST0secret0', 'bp-control-room', 'Some_Member', 'Other_Person', 'How do I start', 'ntfy.sh/a/b']) {
            expect(all).not.toContain(secret);
        }
    });
});

describe('agentRequest', () => {
    const topic = topicUrl(INBOX)!;

    it('POSTs the JSON as the message, with no title, tap or token, and not through Firebase', () => {
        const { url, init } = agentRequest('{"v":1}', topic);
        expect(url).toBe(INBOX);
        expect(init.method).toBe('POST');
        expect(init.body).toBe('{"v":1}');
        expect(init.headers).toEqual({ 'Content-Type': 'text/plain; charset=utf-8', 'X-Firebase': 'no' });
    });

    it('never follows a redirect, and gives up on a send that stalls', () => {
        const { init } = agentRequest('{}', topic);
        expect(init.redirect).toBe('manual');
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.signal?.aborted).toBe(false);
    });
});

describe('deliverAgent', () => {
    it('does nothing at all while agentNtfyUrl is unset', async () => {
        for (const agent of [undefined, null, '', '   ']) {
            const w = world({ agent });
            expect(await deliverAgent(post, w)).toBe('no-channel');
            expect(w.sent).toHaveLength(0);
            expect(w.logs).toEqual([]);
            expect(w.seen.size).toBe(0);
        }
    });

    it('sends a new post once to the inbox topic, as the JSON item', async () => {
        const w = world({ agent: INBOX, token: TOKEN });
        expect(await deliverAgent(post, w)).toBe('sent');
        expect(await deliverAgent(post, w)).toBe('repeat');
        expect(w.sent).toHaveLength(1);
        expect(w.sent[0]?.url).toBe(INBOX);
        expect(w.sent[0]?.init.headers).not.toHaveProperty('Authorization');
        expect(JSON.parse(String(w.sent[0]?.init.body))).toEqual({
            v: 1,
            kind: 'post',
            id: 't3_abc123',
            permalink: 'https://www.reddit.com/r/beanpool/comments/abc123/x/',
            title: 'How do I start a node?',
            body: 'My old laptop?',
            flair: '',
            createdAt: null,
        });
        expect(w.expires.get('inbox:t3_abc123')).toBe(SEEN_S);
        expect(w.logs).toEqual(['[reddit-watcher] the inbox: a new post, told (HTTP 200)', '[reddit-watcher] the inbox: a new post, already told']);
    });

    it('a comment goes too, with its parent', async () => {
        const w = world({ agent: INBOX });
        expect(await deliverAgent(comment, w)).toBe('sent');
        expect(JSON.parse(String(w.sent[0]?.init.body))).toMatchObject({
            kind: 'comment',
            id: 't1_def456',
            body: 'Try the guide',
            parentPermalink: 'https://www.reddit.com/r/beanpool/comments/abc123/x/',
        });
    });

    it('keeps its own mark, apart from the phone\'s: each is sent once, and one failing never stops the other', async () => {
        const w = world({ agent: INBOX });
        expect(await deliver(post, w)).toBe('sent');
        expect(await deliverAgent(post, w)).toBe('sent');
        expect(w.sent.map((s) => s.url)).toEqual([TOPIC, INBOX]);
        expect([...w.seen.keys()].sort()).toEqual(['inbox:t3_abc123', 'seen:t3_abc123']);

        const down = world({ agent: INBOX });
        down.fetch = async (url, init) => {
            down.sent.push({ url, init });
            return { status: url === INBOX ? 500 : 200 };
        };
        expect(await deliver(post, down)).toBe('sent');
        expect(await deliverAgent(post, down)).toBe('failed');
        expect(down.seen.has('seen:t3_abc123')).toBe(true);
        expect(down.seen.has('inbox:t3_abc123')).toBe(false);
        expect(down.logs.at(-1)).toBe('[reddit-watcher] the inbox: a new post, not told: ntfy HTTP 500');
        expect(await deliverAgent(post, down)).toBe('failed');
        expect(down.sent).toHaveLength(3);
    });

    it('skips what the phone notice skips, the team\'s own accounts included, and marks nothing', async () => {
        const w = world({ agent: INBOX, quiet: 'u/Other_Person' });
        expect(await deliverAgent({ ...post, post: { ...post.post, spam: true } }, w)).toBe('skipped');
        expect(await deliverAgent({ type: 'ModAction' }, w)).toBe('skipped');
        expect(await deliverAgent(null, w)).toBe('skipped');
        expect(await deliverAgent(comment, w)).toBe('skipped');
        expect(w.sent).toHaveLength(0);
        expect(w.seen.size).toBe(0);
        expect(await deliverAgent(post, w)).toBe('sent');
    });

    it('sends nothing to a topic it cannot use, and says how to set one', async () => {
        for (const agent of ['http://ntfy.sh/topic', 'https://ntfy.example/topic', 'https://ntfy.sh/a/b', 42]) {
            const w = world({ agent });
            expect(await deliverAgent(post, w)).toBe('no-channel');
            expect(w.sent).toHaveLength(0);
            expect(w.logs.join('\n')).toContain('npx devvit settings set agentNtfyUrl');
            expect(w.logs.join('\n')).not.toContain('ntfy.example');
        }
    });

    it('never sends the inbox to the phone\'s topic, where every message would show on the phone', async () => {
        const w = world({ agent: ` ${TOPIC}\n` });
        expect(await deliverAgent(post, w)).toBe('no-channel');
        expect(w.sent).toHaveLength(0);
        expect(w.logs.at(-1)).toContain('agentNtfyUrl is the phone\'s topic');
    });

    it('an unreachable ntfy is a failed send that takes its mark off', async () => {
        const w = world({ agent: INBOX, status: 'throw' });
        expect(await deliverAgent(comment, w)).toBe('failed');
        expect(w.seen.size).toBe(0);
        expect(w.logs.at(-1)).toBe('[reddit-watcher] the inbox: a new comment, not told: ntfy unreachable');
    });

    it('tells it anyway when the repeat check is down; sends nothing when the settings cannot be read', async () => {
        expect(await deliverAgent(post, world({ agent: INBOX, redis: 'throw' }))).toBe('sent');
        const down = world({ agent: INBOX, settings: 'throw' });
        expect(await deliverAgent(post, down)).toBe('no-channel');
        expect(down.sent).toHaveLength(0);
    });

    it('never logs either topic, the token, who wrote it or what they wrote', async () => {
        const logs: string[] = [];
        for (const opts of [{}, { status: 403 }, { status: 'throw' as const }, { redis: 'throw' as const }, { agent: 'https://ntfy.sh/a/b' }, { agent: TOPIC }]) {
            const w = world({ token: TOKEN, agent: INBOX, ...opts });
            await deliverAgent(post, w);
            await deliverAgent(post, w);
            await deliverAgent(comment, w);
            logs.push(...w.logs);
        }
        const all = logs.join('\n');
        expect(logs.length).toBeGreaterThan(0);
        for (const secret of ['TEST0secret0', 'bp-inbox', 'bp-control-room', 'Some_Member', 'Other_Person', 'How do I start', 'My old laptop', 'Try the guide', 'ntfy.sh/a/b']) {
            expect(all).not.toContain(secret);
        }
    });
});
