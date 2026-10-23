// The app's one endpoint: Devvit POSTs each new post and comment here (devvit.json "triggers"). Everything it decides
// is in ../notice.ts, ../agent-item.ts and ../ntfy.ts; this file only wires them to Devvit's settings, Redis and fetch.

import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { redis, settings } from '@devvit/web/server';
import { deliver, deliverAgent, SEEN_S, type Deps } from '../ntfy';

export const NEW_ITEM = '/internal/triggers/new-item';

const deps: Deps = {
    setting: (name) => settings.get(name),
    firstTime: async (key) => {
        const n = await redis.incrBy(key, 1);
        if (n === 1) await redis.expire(key, SEEN_S);
        return n === 1;
    },
    forget: (key) => redis.del(key),
    fetch: (url, init) => fetch(url, init),
    log: (line) => console.log(line),
};

export async function onReq(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== NEW_ITEM) {
        writeJson(res, 404, { error: 'not found', status: 404 });
        return;
    }
    let event: unknown = null;
    try {
        event = await readJson(req);
    } catch {
        console.log('[reddit-watcher] a trigger request that is not JSON');
    }
    // The phone's notice and the inbox's item go out side by side, each bounded: neither waits on the other.
    await Promise.all([deliver(event, deps), deliverAgent(event, deps)]);
    // A trigger's answer is an empty object (TriggerResponse); what happened is in the log line.
    writeJson(res, 200, {});
}

async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    await once(req, 'end');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeJson(res: ServerResponse, status: number, json: object): void {
    const body = JSON.stringify(json);
    res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), 'Content-Type': 'application/json' });
    res.end(body);
}
