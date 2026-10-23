// Sending a notice to the team's ntfy topic: the control room's channel (apps/registrar/src/alerts.js), the same
// NTFY_URL / NTFY_TOKEN pair kept here as two Devvit secrets, ntfyUrl and ntfyToken. The topic URL and token are secrets:
// they go in the request and nowhere else — a log line says what happened and the HTTP status, never the address.
// The team's inbox (agent-item.ts) is a second topic on the same host, a third secret (agentNtfyUrl), sent to by the same
// rules: once per item, a bounded send, no redirect, and a failed send tried again only if Reddit delivers the event again.

import { agentMessage, toAgentItem } from './agent-item';
import { quietNames, toNotice, type Notice } from './notice';

/** The hosts a topic may be on. Devvit lets the app fetch only these: devvit.json's permissions.http.domains, the same list. */
export const NTFY_HOSTS = ['ntfy.sh'];
/** How long an item's repeat marker lives: Devvit can deliver one event more than once. */
export const SEEN_S = 7 * 24 * 3600;
/**
 * How long a send may take. A send that stalls must end inside the trigger, or the repeat marker set before it is never
 * taken off and a repeat delivery is skipped for SEEN_S. alerts.js bounds its send to the same topic too.
 */
export const SEND_TIMEOUT_MS = 10_000;

/** The topic URL from the secret, or null when it is unset or not an https topic on an allowed host. */
export function topicUrl(raw: unknown): URL | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let u: URL;
    try {
        u = new URL(raw.trim());
    } catch {
        return null;
    }
    if (u.protocol !== 'https:' || !NTFY_HOSTS.includes(u.hostname) || u.port || u.username || u.password) return null;
    if (!/^\/[-_A-Za-z0-9]{1,64}$/.test(u.pathname) || u.search || u.hash) return null;
    return u;
}

/** One POST to the topic, as ntfy reads it: the body is the message; the headers its title, tag and tap. */
export function ntfyRequest(notice: Notice, topic: URL, token?: unknown): { url: string; init: RequestInit } {
    const headers: Record<string, string> = {
        'Content-Type': 'text/plain; charset=utf-8',
        // A header carries printable ASCII only; the title is our words and a subreddit name, and this keeps it so.
        Title: notice.title.replace(/[^\x20-\x7e]/g, '?'),
        Tags: 'speech_balloon',
        Click: notice.url,
    };
    if (typeof token === 'string' && token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
    // As alerts.js: a redirect is never followed ('manual': a 3xx is a failed send), and a send that stalls gives up.
    return {
        url: topic.href,
        init: { method: 'POST', headers, body: notice.body, redirect: 'manual', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
    };
}

/**
 * One POST of an inbox item: the JSON is the message. No title, tag or tap, since no phone shows it, and `Firebase: no`
 * keeps ntfy.sh from passing it on to Google's push service for Android phones: the fetch script reads the topic itself.
 */
export function agentRequest(message: string, topic: URL): { url: string; init: RequestInit } {
    return {
        url: topic.href,
        init: {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8', Firebase: 'no' },
            body: message,
            redirect: 'manual',
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        },
    };
}

export type Outcome = 'sent' | 'skipped' | 'repeat' | 'no-channel' | 'failed';

/** What delivering needs from Devvit, passed in so the tests can stand in for it. */
export type Deps = {
    setting: (name: 'ntfyUrl' | 'ntfyToken' | 'quietUsernames' | 'agentNtfyUrl') => Promise<unknown>;
    /** Marks the item seen; true the first time. */
    firstTime: (key: string) => Promise<boolean>;
    /** Takes the mark off again, so a repeat delivery can try once more after a failed send. */
    forget: (key: string) => Promise<void>;
    fetch: (url: string, init: RequestInit) => Promise<{ status: number }>;
    log: (line: string) => void;
};

const say = (deps: Deps, line: string) => deps.log(`[reddit-watcher] ${line}`);

async function readQuiet(deps: Deps): Promise<Set<string>> {
    try {
        return quietNames(await deps.setting('quietUsernames'));
    } catch {
        return new Set(); // unread: everyone pings
    }
}

async function readTopic(deps: Deps, name: 'ntfyUrl' | 'agentNtfyUrl'): Promise<URL | null> {
    try {
        return topicUrl(await deps.setting(name));
    } catch {
        return null;
    }
}

/**
 * Marks the item seen under `key`, sends it, and takes the mark off again when the send fails, so a repeat delivery
 * from Reddit can try once more. The request is built only when it is sent, so its deadline starts then. `about`
 * begins each log line.
 */
async function sendOnce(
    deps: Deps,
    key: string,
    kind: string,
    about: string,
    request: () => { url: string; init: RequestInit },
): Promise<Outcome> {
    let marked = false;
    try {
        if (!(await deps.firstTime(key))) {
            say(deps, `${about}a new ${kind}, already told`);
            return 'repeat';
        }
        marked = true;
    } catch {
        // Without the repeat check a ping may come twice; that beats none.
        say(deps, `${about}the repeat check is unavailable; telling the new ${kind} anyway`);
    }
    const { url, init } = request();
    let status = 'unreachable';
    try {
        const res = await deps.fetch(url, init);
        if (res.status >= 200 && res.status < 300) {
            say(deps, `${about}a new ${kind}, told (HTTP ${res.status})`);
            return 'sent';
        }
        status = `HTTP ${res.status}`;
    } catch {
        // the status says it: unreachable
    }
    if (marked) await deps.forget(key).catch(() => undefined);
    say(deps, `${about}a new ${kind}, not told: ntfy ${status}`);
    return 'failed';
}

/** One trigger delivery: its notice, once, to the topic. Never throws. */
export async function deliver(event: unknown, deps: Deps): Promise<Outcome> {
    const quiet = await readQuiet(deps);
    const notice = toNotice(event, quiet);
    if (!notice) {
        say(deps, 'nothing to tell (not a new post or comment, or removed, spam, the team\'s own or AutoModerator\'s)');
        return 'skipped';
    }
    const kind = notice.id.startsWith('t1_') ? 'comment' : 'post';
    const topic = await readTopic(deps, 'ntfyUrl');
    if (!topic) {
        say(deps, `a new ${kind}, not told: ntfyUrl is not set to an https topic on ${NTFY_HOSTS.join(' or ')} (npx devvit settings set ntfyUrl)`);
        return 'no-channel';
    }
    let token: unknown;
    try {
        token = await deps.setting('ntfyToken');
    } catch {
        token = undefined;
    }
    return sendOnce(deps, `seen:${notice.id}`, kind, '', () => ntfyRequest(notice, topic, token));
}

/**
 * One trigger delivery to the team's inbox: its item, once, to the agentNtfyUrl topic, beside the phone's notice and
 * apart from it (its own repeat mark, so one send failing never stops the other). Unset, it does nothing and says
 * nothing. Never sends to the phone's own topic: that one shows each message on a phone. Never throws.
 */
export async function deliverAgent(event: unknown, deps: Deps): Promise<Outcome> {
    let raw: unknown;
    try {
        raw = await deps.setting('agentNtfyUrl');
    } catch {
        raw = undefined;
    }
    if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return 'no-channel';
    const item = toAgentItem(event, await readQuiet(deps));
    if (!item) return 'skipped';
    const kind = item.kind;
    const topic = topicUrl(raw);
    if (!topic) {
        say(deps, `the inbox: a new ${kind}, not told: agentNtfyUrl is not an https topic on ${NTFY_HOSTS.join(' or ')} (npx devvit settings set agentNtfyUrl)`);
        return 'no-channel';
    }
    if ((await readTopic(deps, 'ntfyUrl'))?.href === topic.href) {
        say(deps, `the inbox: a new ${kind}, not told: agentNtfyUrl is the phone's topic; give the inbox a new one (npx devvit settings set agentNtfyUrl)`);
        return 'no-channel';
    }
    const message = agentMessage(item);
    if (!message) {
        say(deps, `the inbox: a new ${kind}, not told: too large for one ntfy message`);
        return 'skipped';
    }
    return sendOnce(deps, `inbox:${item.id}`, kind, 'the inbox: ', () => agentRequest(message, topic));
}
