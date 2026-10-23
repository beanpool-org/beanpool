#!/usr/bin/env node
// The team's Reddit inbox, fetched once (Marty, 2026-10-23; apps/reddit-watcher/TRIAGE.md).
//
// The Reddit watcher app (apps/reddit-watcher) sends each new r/beanpool post and comment, as one JSON item, to a private
// ntfy topic: its agentNtfyUrl secret. This reads that topic ONCE, keeps each item it has not had before as
// scratch/reddit-inbox/new/<reddit id>.json, prints how many, and stops. It never starts an agent, never posts or sends
// anything, and never runs again by itself: the director runs it once per heartbeat (no cron, launchd or loop may start
// agents).
//
// The topic's address is its password. It is read from ~/.config/beanpool/reddit-agent-topic — one line, chmod 600,
// outside the repository — never from an argument or the environment, and it is never printed.
//
//   node scripts/reddit-inbox.mjs
//
// Exit 0: read (zero or more new items). Exit 1: not set up, or the topic could not be read; the message says why.
// Kept in scratch/reddit-inbox/ (git-ignored): state.json (ntfy's id of the last message read, and the Reddit ids
// already kept), new/ (items waiting to be sorted) and done/ (the director moves them there once carded).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOPIC_FILE_SHOWN = '~/.config/beanpool/reddit-agent-topic';
export const TOPIC_FILE = path.join(os.homedir(), '.config', 'beanpool', 'reddit-agent-topic');
export const INBOX_DIR = path.join(ROOT, 'scratch', 'reddit-inbox');
/** How long one read of the topic may take, answer included. */
export const POLL_TIMEOUT_MS = 20_000;
/** The most of one answer it reads. ntfy.sh keeps a topic's messages for 12 hours; r/beanpool's fill a few KB. */
export const MAX_BYTES = 2 * 1024 * 1024;
/** How many Reddit ids it remembers: far more than 12 hours of r/beanpool. */
export const SEEN_MAX = 2000;
/** The hosts a topic may be on: the app's NTFY_HOSTS (apps/reddit-watcher/src/ntfy.ts). */
export const NTFY_HOSTS = ['ntfy.sh'];
// ntfy's message ids: 12 letters and digits. Anything else is never put in a request.
const NTFY_ID = /^[A-Za-z0-9]{12}$/;
const REDDIT_ID = /^t[13]_[a-z0-9]{1,16}$/;
// The app's limits (apps/reddit-watcher/src/agent-item.ts), with room: an item past them is not one the app sent.
const LIMITS = { title: 300, body: 2000, flair: 64, link: 600 };

const HOW_TO_SET_UP = [
    `Create it once, holding the same address as the watcher app's agentNtfyUrl secret (apps/reddit-watcher/README.md, "The team's inbox"):`,
    `  copy the address, then: (umask 077 && mkdir -p ~/.config/beanpool && pbpaste > ${TOPIC_FILE_SHOWN}) && chmod 600 ${TOPIC_FILE_SHOWN}`,
].join('\n');

/** The topic URL, or null when it is not an https topic on an allowed host: the app's topicUrl, the same rules. */
export function topicUrl(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let u;
    try {
        u = new URL(raw.trim());
    } catch {
        return null;
    }
    if (u.protocol !== 'https:' || !NTFY_HOSTS.includes(u.hostname) || u.port || u.username || u.password) return null;
    if (!/^\/[-_A-Za-z0-9]{1,64}$/.test(u.pathname) || u.search || u.hash) return null;
    return u;
}

/** The topic from its file: { url } or { problem }, a message that never repeats what the file holds. */
export function readTopic(file = TOPIC_FILE) {
    const shown = file === TOPIC_FILE ? TOPIC_FILE_SHOWN : file;
    let st;
    try {
        st = fs.lstatSync(file);
    } catch (e) {
        if (e?.code === 'ENOENT') return { problem: `No inbox topic: ${shown} does not exist.\n${HOW_TO_SET_UP}` };
        return { problem: `Cannot read ${shown} (${e?.code ?? 'error'}).` };
    }
    if (!st.isFile()) return { problem: `${shown} is not a plain file (a link or a folder). Make it a file.\n${HOW_TO_SET_UP}` };
    if ((st.mode & 0o077) !== 0) {
        return { problem: `${shown} can be read by other accounts on this computer (mode ${(st.mode & 0o777).toString(8)}). The address is the topic's password: chmod 600 ${shown}` };
    }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { problem: `${shown} belongs to another account. Make it yours, chmod 600.` };
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return { problem: `Cannot read ${shown} (${e?.code ?? 'error'}).` };
    }
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length !== 1) return { problem: `${shown} must hold exactly one line, the topic's address (it holds ${lines.length}).` };
    const url = topicUrl(lines[0]);
    if (!url) return { problem: `${shown} does not hold an https://${NTFY_HOSTS[0]}/<topic> address (letters, digits, - and _ only).` };
    return { url };
}

const isStr = (v, max) => typeof v === 'string' && Array.from(v).length <= max;

function redditLink(v) {
    if (!isStr(v, LIMITS.link)) return false;
    try {
        const u = new URL(v);
        return u.origin === 'https://www.reddit.com' && u.href === v && !u.username && !u.password;
    } catch {
        return false;
    }
}

/**
 * One message's text as an inbox item, or null when it is not one the app sends (agent-item.ts): the fields and their
 * limits are checked, and only those fields are kept.
 */
export function toInboxItem(text) {
    if (typeof text !== 'string' || text.length > 16_384) return null;
    let m;
    try {
        m = JSON.parse(text);
    } catch {
        return null;
    }
    if (!m || typeof m !== 'object' || Array.isArray(m) || m.v !== 1) return null;
    if (m.kind !== 'post' && m.kind !== 'comment') return null;
    if (typeof m.id !== 'string' || !REDDIT_ID.test(m.id) || m.id.startsWith('t3_') !== (m.kind === 'post')) return null;
    if (!redditLink(m.permalink) || !isStr(m.title, LIMITS.title) || !isStr(m.body, LIMITS.body) || !isStr(m.flair, LIMITS.flair)) return null;
    if (m.createdAt !== null && !(typeof m.createdAt === 'string' && m.createdAt.length <= 40 && Number.isFinite(Date.parse(m.createdAt)))) return null;
    const item = { v: 1, kind: m.kind, id: m.id, permalink: m.permalink, title: m.title, body: m.body, flair: m.flair, createdAt: m.createdAt };
    if (m.kind === 'comment') {
        if (!redditLink(m.parentPermalink)) return null;
        item.parentPermalink = m.parentPermalink;
    } else if (m.parentPermalink !== undefined) {
        return null;
    }
    return item;
}

/** state.json: { lastId, seen } — a fresh state when there is none, a problem when it is there but unreadable. */
export function loadState(dir) {
    const file = path.join(dir, 'state.json');
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e?.code === 'ENOENT') return { lastId: null, seen: [] };
        return { problem: `Cannot read ${shownPath(file)} (${e?.code ?? 'error'}).` };
    }
    try {
        const s = JSON.parse(text);
        const lastId = s?.lastId === null || (typeof s?.lastId === 'string' && NTFY_ID.test(s.lastId)) ? s.lastId : undefined;
        if (s?.v !== 1 || lastId === undefined || !Array.isArray(s.seen) || !s.seen.every((id) => typeof id === 'string' && REDDIT_ID.test(id))) {
            throw new Error('shape');
        }
        return { lastId, seen: s.seen };
    } catch {
        return {
            problem: `${shownPath(file)} is not the inbox's state. Move it aside (mv it to state.json.bad) and run again: it then reads the topic's last 12 hours, and items already in new/ or done/ are not kept twice.`,
        };
    }
}

function writeAtomic(file, text) {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

function shownPath(p) {
    const r = path.relative(ROOT, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p;
}

/** Why a request failed, in words that never carry its address: the error's code or name only. */
function failure(e) {
    const code = e?.cause?.code ?? e?.code;
    if (typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code)) return code;
    return e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'no answer in time' : 'unreachable';
}

/** The answer's text, at most maxBytes of it: { text, cut } where cut means more was waiting. */
async function readCapped(res, maxBytes) {
    if (!res.body) return { text: '', cut: false };
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    let cut = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > maxBytes) {
            chunks.push(value.subarray(0, maxBytes - size));
            cut = true;
            await reader.cancel().catch(() => undefined);
            break;
        }
        chunks.push(value);
        size += value.byteLength;
    }
    let text = Buffer.concat(chunks).toString('utf8');
    // Only whole lines: a cut answer ends mid-message, and that message is read next time.
    if (cut) text = text.slice(0, text.lastIndexOf('\n') + 1);
    return { text, cut };
}

/**
 * One read of the topic. `fetch` is passed in so the tests can point it at a stand-in ntfy on this machine. Returns the
 * exit code; `out` gets the count, `err` any problem.
 */
export async function run({
    topicFile = TOPIC_FILE,
    dir = INBOX_DIR,
    fetch: fetchFn = globalThis.fetch,
    out = (line) => console.log(line),
    err = (line) => console.error(line),
    timeoutMs = POLL_TIMEOUT_MS,
    maxBytes = MAX_BYTES,
} = {}) {
    const topic = readTopic(topicFile);
    if (topic.problem) {
        err(`reddit-inbox: ${topic.problem}`);
        return 1;
    }
    const state = loadState(dir);
    if (state.problem) {
        err(`reddit-inbox: ${state.problem}`);
        return 1;
    }

    const ask = new URL(`${topic.url.href}/json`);
    ask.searchParams.set('poll', '1');
    // An id ntfy no longer holds (it keeps 12 hours) reads everything it holds; the seen ids keep that from repeating.
    ask.searchParams.set('since', state.lastId ?? 'all');
    let res;
    try {
        res = await fetchFn(ask.href, {
            method: 'GET',
            headers: { Accept: 'application/x-ndjson' },
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) {
        err(`reddit-inbox: could not read the topic: ntfy ${failure(e)}. Nothing changed; run again later.`);
        return 1;
    }
    if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        err(`reddit-inbox: could not read the topic: ntfy answered HTTP ${res.status}. Nothing changed; run again later.`);
        return 1;
    }
    let answer;
    try {
        answer = await readCapped(res, maxBytes);
    } catch (e) {
        err(`reddit-inbox: could not read the topic: ntfy ${failure(e)} while answering. Nothing changed; run again later.`);
        return 1;
    }

    const newDir = path.join(dir, 'new');
    const doneDir = path.join(dir, 'done');
    fs.mkdirSync(newDir, { recursive: true });
    const seen = new Set(state.seen);
    let lastId = state.lastId;
    let notItems = 0;
    const kept = [];
    for (const line of answer.text.split('\n')) {
        if (!line.trim()) continue;
        let m;
        try {
            m = JSON.parse(line);
        } catch {
            notItems++;
            continue;
        }
        if (m?.event !== 'message') continue; // ntfy's own open / keepalive lines
        if (typeof m.id !== 'string' || !NTFY_ID.test(m.id)) {
            notItems++;
            continue;
        }
        lastId = m.id;
        const item = toInboxItem(m.message);
        if (!item) {
            notItems++;
            continue;
        }
        const name = `${item.id}.json`;
        if (seen.has(item.id) || fs.existsSync(path.join(newDir, name)) || fs.existsSync(path.join(doneDir, name))) {
            seen.add(item.id);
            continue;
        }
        writeAtomic(path.join(newDir, name), `${JSON.stringify(item, null, 2)}\n`);
        seen.add(item.id);
        kept.push(item);
    }
    // The items are written before the state: a run cut off between the two reads them again, and keeps none twice.
    writeAtomic(path.join(dir, 'state.json'), `${JSON.stringify({ v: 1, lastId, seen: [...seen].slice(-SEEN_MAX) }, null, 2)}\n`);

    if (kept.length === 0) out('reddit-inbox: nothing new.');
    else {
        const posts = kept.filter((i) => i.kind === 'post').length;
        const what = [posts && `${posts} post${posts === 1 ? '' : 's'}`, kept.length - posts && `${kept.length - posts} comment${kept.length - posts === 1 ? '' : 's'}`].filter(Boolean).join(', ');
        out(`reddit-inbox: ${kept.length} new (${what}) in ${shownPath(newDir)}/`);
        for (const item of kept) out(`  ${item.id}.json`);
    }
    if (notItems) out(`reddit-inbox: ${notItems} message${notItems === 1 ? '' : 's'} on the topic ${notItems === 1 ? 'was' : 'were'} not an inbox item; skipped.`);
    if (answer.cut) out(`reddit-inbox: the answer was over ${maxBytes} bytes; more is waiting. Run it again.`);
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
    if (process.argv.length > 2) {
        console.error('Usage: node scripts/reddit-inbox.mjs  (no arguments: the topic is read from ~/.config/beanpool/reddit-agent-topic)');
        process.exitCode = 1;
    } else {
        process.exitCode = await run();
    }
}
