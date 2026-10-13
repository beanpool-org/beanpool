// Who a platform says a token belongs to, and whether that is the channel the member claimed (#1830).
//
// A "verified account" badge means THIS node asked the platform which account the member signed in
// to, and the platform named the account on the channel row. The phone never tells the node who it
// is: the relay (`routes/channels.ts`, `/api/member/pulse/oauth-exchange`) exchanges the code, calls
// `readPlatformIdentity` with the token still in its local variable, matches with `matchIdentity`,
// and forgets the token. Nothing here stores a token or keeps an identity anywhere but the two
// columns on the member's own channel row.
//
// ## Matching is exact
//
// The old check was a substring of the URL path (`'/@' + username`), so `art` and `artbyjan`
// verified `@artbyjane` (#1822 finding 3). Here a handle matches only another handle after the same
// fold (`===`), and a YouTube channel id only the same id byte for byte. A row with no identity of
// that kind (a short link, a `/watch` link, a Facebook page) is not verifiable at all.
//
// ## Facebook is never verified
//
// A Facebook channel is a Page, and proving one needs `pages_show_list`, which the Pulse runbook
// forbids requesting. Its chip stays a plain claim, so `channelIdentityFromRow` has no Facebook case.

import https from 'node:https';

export type IdentityPlatform = 'tiktok' | 'instagram' | 'youtube' | 'soundcloud';

/** What the platform said: a stable id that survives a rename, and the handle as it stands now. */
export interface PlatformIdentity {
    accountId: string;
    /** Folded (see `foldHandle`). Null only for a YouTube channel with no @handle. */
    handle: string | null;
}

/** What the channel row claims. A YouTube `/channel/UC…` row carries an id instead of a handle. */
export type ChannelIdentity = { kind: 'handle'; handle: string } | { kind: 'id'; id: string };

/** An identity call that did not name an account. `hint` is member-facing copy; nothing identifying. */
export class IdentityUnavailable extends Error {
    constructor(public hint: string) {
        super(hint);
        this.name = 'IdentityUnavailable';
    }
}

const HANDLE_SHAPE = /^[a-z0-9._-]{1,100}$/;

/** Lowercase, strip ONE leading `@`, and refuse anything that is not handle-shaped. */
export function foldHandle(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const folded = raw.trim().toLowerCase().replace(/^@/, '');
    return HANDLE_SHAPE.test(folded) ? folded : null;
}

const YT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

const IDENTITY_HOSTS: Record<IdentityPlatform, string[]> = {
    tiktok: ['tiktok.com', 'm.tiktok.com'],
    instagram: ['instagram.com'],
    youtube: ['youtube.com', 'm.youtube.com'],
    soundcloud: ['soundcloud.com', 'm.soundcloud.com'],
};

/**
 * The identity the stored row claims, or null when the row has none a platform could confirm.
 *
 * Read from the URL path (the handle column is derived from it by `normaliseChannelInput`), and
 * refused when the handle column disagrees with the path, so the chip can never show a name the
 * match did not cover. Short links (`vm.tiktok.com/…`, `youtu.be/…`), `/watch`, `/c/` and `/user/`
 * names, and every Facebook form have no identity here.
 */
export function channelIdentityFromRow(platform: string, url: string | null, handle: string | null): ChannelIdentity | null {
    if (!url || !(platform in IDENTITY_HOSTS)) return null;
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!IDENTITY_HOSTS[platform as IdentityPlatform].includes(host)) return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    const seg0 = segments[0] || '';
    const storedHandle = handle ? handle.toLowerCase().replace(/^@/, '') : null;

    const byHandle = (raw: string): ChannelIdentity | null => {
        const h = foldHandle(raw);
        if (!h) return null;
        if (storedHandle !== null && storedHandle !== h) return null;
        return { kind: 'handle', handle: h };
    };

    switch (platform as IdentityPlatform) {
        case 'tiktok':
        case 'youtube':
            if (seg0.startsWith('@') && segments.length === 1) return byHandle(seg0);
            if (platform === 'youtube' && seg0 === 'channel' && segments.length === 2 && YT_CHANNEL_ID.test(segments[1])) {
                if (handle !== null && handle !== segments[1]) return null;
                return { kind: 'id', id: segments[1] };
            }
            return null;
        case 'instagram':
        case 'soundcloud':
            if (segments.length === 1 && !seg0.startsWith('@')) return byHandle(seg0);
            return null;
    }
    return null;
}

/**
 * Does the platform's answer name the channel's account? Exact only.
 *
 * `knownAccountId` is the stable id an earlier connect stored on this row: a member who renamed
 * their account keeps the badge on a reconnect, because the platform still names the same account.
 */
export function matchIdentity(claimed: ChannelIdentity, found: PlatformIdentity, knownAccountId?: string | null): boolean {
    if (knownAccountId && found.accountId === knownAccountId) return true;
    if (claimed.kind === 'id') return found.accountId === claimed.id;
    return found.handle !== null && found.handle === claimed.handle;
}

// ── Outbound calls ──────────────────────────────────────────────────────────────────────────────

export interface PlatformResponse { status: number; json: any }
export interface PlatformRequestOptions { form?: Record<string, string>; bearer?: string }
export type PlatformRequest = (method: 'GET' | 'POST', url: string, opts?: PlatformRequestOptions) => Promise<PlatformResponse>;

/** IPv4-pinned (some hosts have no working IPv6 route to the platforms), 10 s timeout. */
const httpsPlatformRequest: PlatformRequest = (method, urlStr, opts) => new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const data = opts?.form ? new URLSearchParams(opts.form).toString() : undefined;
    const headers: Record<string, string | number> = { Accept: 'application/json' };
    if (opts?.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    if (data !== undefined) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request(url, { method, family: 4, headers, timeout: 10000 }, (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => {
            let json: any;
            try { json = JSON.parse(body); } catch { json = { error: body || `HTTP ${res.statusCode}` }; }
            resolve({ status: res.statusCode || 200, json });
        });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
});

let platformRequestImpl: PlatformRequest = httpsPlatformRequest;

/** Every call to TikTok or Instagram goes through here. */
export function platformRequest(method: 'GET' | 'POST', url: string, opts?: PlatformRequestOptions): Promise<PlatformResponse> {
    return platformRequestImpl(method, url, opts);
}

/** Suites install a fake platform; null restores the real one. */
export function setPlatformRequestForTests(fn: PlatformRequest | null): void {
    platformRequestImpl = fn ?? httpsPlatformRequest;
}

const INSTAGRAM_ROLE_HINT =
    'Instagram did not say which account this is. While the BeanPool Pulse app is in review, only accounts added as Instagram Testers can connect.';

function stringId(value: unknown): string | null {
    if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
    return null;
}

/**
 * Ask the platform who the access token belongs to. One call; only the id and username fields.
 *
 * `tokenAccountId` is the id the token response itself carried (Instagram's `user_id`), kept as
 * the stable id where the design says so. Throws `IdentityUnavailable` on any answer that does not
 * name an account; never falls back to a display name.
 */
export async function readPlatformIdentity(
    platform: 'tiktok' | 'instagram', accessToken: string, tokenAccountId?: unknown,
): Promise<PlatformIdentity> {
    if (platform === 'tiktok') {
        let res: PlatformResponse;
        try {
            res = await platformRequestImpl('GET', 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,username', { bearer: accessToken });
        } catch {
            throw new IdentityUnavailable('TikTok could not be reached to confirm the account. Try again.');
        }
        const user = res.json?.data?.user;
        const errCode = res.json?.error?.code;
        const accountId = stringId(user?.open_id);
        const handle = foldHandle(user?.username);
        if (res.status >= 400 || (errCode && errCode !== 'ok') || !accountId || !handle) {
            throw new IdentityUnavailable('TikTok did not say which account this is. Connect again and allow BeanPool to read your profile.');
        }
        return { accountId, handle };
    }

    let res: PlatformResponse;
    try {
        res = await platformRequestImpl('GET', `https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${encodeURIComponent(accessToken)}`);
    } catch {
        throw new IdentityUnavailable('Instagram could not be reached to confirm the account. Try again.');
    }
    const handle = foldHandle(res.json?.username);
    const accountId = stringId(tokenAccountId) ?? stringId(res.json?.id);
    if (res.status >= 400 || res.json?.error || !accountId || !handle) {
        throw new IdentityUnavailable(INSTAGRAM_ROLE_HINT);
    }
    return { accountId, handle };
}
