/**
 * Lights-out H2: the hall door (scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §2.4, §2.5, §3.6).
 *
 * When the internet is down, an owner runs the community on a laptop in the town hall and turns lights-out on there
 * (H1). Members join the hall's Wi-Fi and scan the poster, `beanpool://hall?at=192.168.8.1:8080&for=byron.beanpool.org`,
 * or type the laptop's number (app/hall.tsx). Then, in this order:
 *
 *   1. The phone checks the laptop is its own community, before it signs anything for it: the laptop's signed statement
 *      (GET /api/node/identity-epoch) must name the same node key and community id the phone kept for its own address
 *      (utils/address-follow.ts keptCommunityIdentity), with no fewer take-overs; and the laptop must sign a nonce the
 *      phone just made (GET /api/attest?nonce=) with that same key. The statement is public, so a copied statement on a
 *      stranger's laptop passes the first half; only the community's own node key passes the second. Both are plain
 *      GETs: nothing the member's key signed goes to a laptop that fails.
 *   2. The phone remembers the hall (utils/hall-state.ts: the number, the community's NAME it signs for, the address it
 *      came from), then moves to the number with its copy carried (utils/reconnect.ts switchPhoneTo with `carryFrom`:
 *      the community's file, its DM pins and group-chat keys and sync cursors, whole or not at all). The name signed for
 *      is the host of the phone's own address before the move: never the `for` the poster or the laptop names. That
 *      name may be the community's other one (Byron: the poster says byron.beanpool.org, phones saved under
 *      mullum.beanpool.org stay there), so it never stops the check: step 1 decides.
 *   3. While there, the node's health (`lightsOut`, H1) drives one banner (components/HallBanner.tsx): the record's age.
 *   4. Home again: the node's health says `lightsOut.on: false` and the phone checks its own address the same way
 *      (statement, same key, no fewer take-overs than it kept before the hall) and carries the copy back. If the laptop
 *      no longer answers, the phone asks its own address by itself, at most once an hour, and offers the move with one
 *      card. The address it goes back to is always the one it came from, never one a node named.
 *
 * Nothing here runs unless the member opened the door: a phone that never did makes no request a day-zero phone doesn't.
 * A node without `lightsOut` in its health (an old one) shows nothing and moves nobody.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { audienceOf, ed25519KeyOfPeerId, formatDate, t } from '@beanpool/core';
import {
    fetchIdentityStatement, keptCommunityIdentity, sameCommunity, type CommunityIdentity,
} from './address-follow';
import { clearHall, readHall, writeHall, type HallRecord } from './hall-state';
import type { HallLink } from './hall-link';
import { isPlainNodeAddress, plainOriginOf } from './node-url';
import type { CopyCarry } from './community-copy-carry';

// The poster's link and the typed number (kept light for app/+native-intent.ts).
export { hallAddressOf, hallRouteFor, hallRouteFromSystemPath, parseHallLink, type HallLink } from './hall-link';

/** Where a node signs a nonce with its node key (apps/server routes/public-address.ts). */
export const ATTEST_PATH = '/api/attest';
/** What the node key signs in front of the nonce, per protocol (apps/server services/registrar-client.ts PROTOCOLS). */
const ATTEST_TAGS: Record<string, string> = { v1: 'beanpool-node-attest/v1', v2: 'beanpool-node-attest/v2' };
const CHECK_TIMEOUT_MS = 8_000;
/** The laptop is gone: the phone asks its own address by itself at most this often (design §2.5, as the follow card). */
export const HOME_TRY_MS = 60 * 60 * 1000;

// ─── The check: this laptop is my community ─────────────────────────────────────────────────

function hexBytes(hex: string): Uint8Array | null {
    if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Whether `body` (GET /api/attest's answer: `{ pubkey, nonce, timestamp, signature, proto? }`) is the node key of
 * `peerId` signing `nonce`: the key named is that PeerId's, the nonce is the one sent, and the signature (strict RFC
 * 8032) is over `<tag>\n<nonce>\n<timestamp>`. The timestamp is not compared with the phone's clock: the nonce is fresh.
 */
export function attestationProves(body: unknown, nonce: string, peerId: string): boolean {
    if (!body || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    const key = ed25519KeyOfPeerId(peerId);
    const named = typeof b.pubkey === 'string' && b.pubkey.length === 64 ? hexBytes(b.pubkey) : null;
    const sig = typeof b.signature === 'string' && b.signature.length === 128 ? hexBytes(b.signature) : null;
    const proto = b.proto === undefined ? 'v1' : b.proto;
    const tag = typeof proto === 'string' && Object.hasOwn(ATTEST_TAGS, proto) ? ATTEST_TAGS[proto] : null;
    if (!key || !named || !sig || !tag || !sameBytes(key, named) || b.nonce !== nonce) return false;
    if (!Number.isSafeInteger(b.timestamp) || (b.timestamp as number) < 0) return false;
    try {
        return ed25519.verify(sig, new TextEncoder().encode(`${tag}\n${nonce}\n${b.timestamp}`), key, { zip215: false });
    } catch {
        return false;
    }
}

export interface HallDeps {
    /** The phone's community address, as stored. */
    anchor(): Promise<string | null>;
    /** What the phone kept of its community at `origin` (utils/address-follow.ts). */
    kept(origin: string): Promise<CommunityIdentity | null>;
    /** The signed statement at `origin`, verified, or null. Unsigned GET. */
    statement(origin: string): Promise<CommunityIdentity | null>;
    /** GET `origin`/api/attest?nonce=, the JSON answer or null. Unsigned. */
    attest(origin: string, nonce: string): Promise<unknown>;
    /** A fresh nonce: 32 hex characters from the phone's random source. */
    nonce(): string;
    /** GET `origin`/api/community/health, the JSON answer or null. Unsigned. */
    health(origin: string): Promise<unknown>;
    /** The existing switch with the copy carried (utils/reconnect.ts switchPhoneTo). */
    switchTo(url: string, carryFrom: string): Promise<CopyCarry | null | void>;
    now(): number;
}

export type LaptopCheck =
    | 'same'
    /** The laptop gave no signed statement (not on the hall Wi-Fi, iPhone Local Network off, wrong number). */
    | 'no-answer'
    /** Its statement names another node key or community. */
    | 'not-same'
    /** The same community with fewer take-overs than this phone has seen: an older copy of it. */
    | 'older'
    /** Its statement is the community's, but it couldn't sign the nonce with the community's key: not its server. */
    | 'not-proved'
    /** This phone has nothing kept to check against. */
    | 'nothing-kept';

/**
 * Whether the laptop at `at` is the community the phone kept at `home` (the file's step 1). Plain GETs only; nothing the
 * member's key signs. With nothing kept for `home`, the home is asked once (the drill, while the internet works); with
 * still nothing, 'nothing-kept': the phone can't tell the community from a stranger.
 */
export async function checkHallLaptop(at: string, home: string, deps: HallDeps): Promise<LaptopCheck> {
    let kept = await deps.kept(home).catch(() => null);
    if (!kept) kept = await deps.statement(home).catch(() => null);
    if (!kept) return 'nothing-kept';
    const there = await deps.statement(at).catch(() => null);
    if (!there) return 'no-answer';
    if (there.peerId !== kept.peerId || there.communityId !== kept.communityId) return 'not-same';
    if (!sameCommunity(kept, there)) return 'older';
    const nonce = deps.nonce();
    const answer = await deps.attest(at, nonce).catch(() => null);
    return attestationProves(answer, nonce, kept.peerId) ? 'same' : 'not-proved';
}

// ─── The move into the hall ─────────────────────────────────────────────────────────────────

export type EnterResult =
    | { kind: 'moved'; carried: CopyCarry | null }
    /** Already on this laptop. */
    | { kind: 'here' }
    /** The laptop is another community (its statement names another key), and the poster named another name. */
    | { kind: 'other-community'; named: string; home: string }
    /** No community on this phone to bring to the hall. */
    | { kind: 'no-community' }
    | { kind: 'refused'; why: Exclude<LaptopCheck, 'same'> };

// ─── A move under way ───────────────────────────────────────────────────────────────────────
//
// While the copy is carried (into the hall or home), the anchor and the hall record disagree on purpose: enterHall keeps
// the record before the move, and the carry writes the address last (community-copy-carry.ts step 3). A banner tick in
// that window must not read the disagreement as "the phone left the hall another way" and forget the record (the phone
// would then sign for the number at the number, with no way home), nor start a second move home.

/** Moves under way, and how many have started this run (a tick that saw a move start or end while it read judges nothing). */
let moving = 0;
let movesStarted = 0;

async function whileMoving<T>(move: () => Promise<T>): Promise<T> {
    moving++;
    movesStarted++;
    try {
        return await move();
    } finally {
        moving--;
    }
}

/** No move is under way, and none started since `seen` was read. */
function stillSettled(seen: number): boolean {
    return moving === 0 && movesStarted === seen;
}

/**
 * Open the hall door: check the laptop, then move to it with the copy (the file's steps 1 and 2). The check decides,
 * whatever name the poster gives: a community with two names (Byron's phones saved under mullum.beanpool.org, its
 * poster naming byron.beanpool.org) is the same node key, and the nonce proof is what tells it from a stranger. The
 * audience kept is always the phone's own address's host, never the poster's; the poster's name is only said back when
 * the laptop turns out to be another community. A phone already on a hall laptop goes from that laptop's home, so a
 * second laptop (a new number) is checked against the same community.
 */
export async function enterHall(link: HallLink, deps: HallDeps): Promise<EnterResult> {
    const anchor = await deps.anchor().catch(() => null);
    const current = anchor && isPlainNodeAddress(anchor) ? plainOriginOf(anchor) : null;
    if (!current) return { kind: 'no-community' };
    const hall = await readHall();
    const inHall = !!hall && hall.at === current;
    const home = inHall ? hall!.home : current;
    const audience = audienceOf(home);
    if (!audience) return { kind: 'no-community' };
    if (link.at === current) return { kind: 'here' };
    if (link.at === home) return { kind: 'here' };
    const verdict = await checkHallLaptop(link.at, home, deps);
    if (verdict === 'not-same' && link.for && link.for !== audience) {
        return { kind: 'other-community', named: link.for, home: audience };
    }
    if (verdict !== 'same') return { kind: 'refused', why: verdict };
    // Kept before the move, so the first signed request at the number is already for the community's name.
    const record: HallRecord = { at: link.at, for: audience, home, since: new Date(deps.now()).toISOString() };
    return whileMoving(async () => {
        await writeHall(record);
        try {
            const carried = await deps.switchTo(link.at, current);
            forgetHallRun();
            return { kind: 'moved', carried: carried ?? null };
        } catch (e) {
            // Nothing moved (the carry says so and leaves the phone where it was): the hall the phone was in, if any, stays.
            if (inHall && hall) await writeHall(hall);
            else await clearHall();
            throw e;
        }
    });
}

// ─── While in the hall, and the way home ────────────────────────────────────────────────────

/** What the node's health says of lights-out (H1: `lightsOut` in GET /api/community/health), or null for no such field. */
export interface LightsOutField {
    on: boolean;
    recordAsOf: string | null;
    /** The community's main address (H1 homeAddress). Read, never gone to: the phone goes back to its own (hall.home). */
    home: string | null;
}

export function lightsOutOf(health: unknown): LightsOutField | null {
    const lo = health && typeof health === 'object' ? (health as { lightsOut?: unknown }).lightsOut : undefined;
    if (!lo || typeof lo !== 'object') return null;
    const f = lo as Record<string, unknown>;
    if (typeof f.on !== 'boolean') return null;
    const recordAsOf = typeof f.recordAsOf === 'string' && Number.isFinite(Date.parse(f.recordAsOf)) ? f.recordAsOf : null;
    const home = typeof f.home === 'string' && f.home ? f.home : null;
    return { on: f.on, recordAsOf, home };
}

/** What the banner shows (components/HallBanner.tsx). */
export type HallView =
    /** On the hall laptop with lights-out on: the record's age when the node knows it. */
    | { kind: 'in-hall'; recordAsOf: string | null }
    /** The laptop no longer answers and the phone's own address does: the one card. */
    | { kind: 'home-answers'; host: string }
    /** The phone just went home by itself (the switch went off). */
    | { kind: 'back-home'; host: string };

/** This run's memory: the last record time, the last home try, and a move home to say once. */
let run: { recordAsOf: string | null; homeTriedAt: number | null; homeAnswers: boolean; backHome: string | null } = {
    recordAsOf: null, homeTriedAt: null, homeAnswers: false, backHome: null,
};

/** Forget this run's hall memory (tests; a new move). */
export function forgetHallRun(): void {
    run = { recordAsOf: null, homeTriedAt: null, homeAnswers: false, backHome: null };
}

/** The "back home" line was read: it goes. */
export function dismissBackHome(): void {
    run.backHome = null;
}

/** Whether the phone's own address is its community, as it was before the hall: same key, no fewer take-overs. */
async function homeIsSame(hall: HallRecord, deps: HallDeps): Promise<boolean> {
    const kept = await deps.kept(hall.home).catch(() => null);
    const there = await deps.statement(hall.home).catch(() => null);
    return !!kept && !!there && sameCommunity(kept, there);
}

/** 'moving': another move (into the hall or home) is under way; nothing was done. */
export type HomeResult = 'moved' | 'not-same' | 'not-in-hall' | 'moving';

/**
 * Go back to the address the phone came from (`hall.home`), the copy carried back. Checked first (statement at the
 * address, the kept identity, no fewer take-overs). The hall record goes only once the phone is home. One move at a
 * time: a tap on the card while a tick is already carrying the copy home does nothing.
 */
export async function goHome(deps: HallDeps): Promise<HomeResult> {
    if (moving > 0) return 'moving';
    return whileMoving(async () => {
        const hall = await readHall();
        const anchor = await deps.anchor().catch(() => null);
        const current = anchor && isPlainNodeAddress(anchor) ? plainOriginOf(anchor) : null;
        if (!hall || current !== hall.at) return 'not-in-hall';
        if (!(await homeIsSame(hall, deps))) return 'not-same';
        await deps.switchTo(hall.home, hall.at);
        await clearHall();
        forgetHallRun();
        run.backHome = audienceOf(hall.home);
        return 'moved';
    });
}

/**
 * One look while in the hall (the banner's tick: at its start, each return to the app, and each minute while shown).
 * Asks nothing at all when the phone is not on a hall laptop. A hall record the phone has left by another way (a switch in
 * Settings) is forgotten. While a move is under way (or one started while this tick read), nothing is judged: the record
 * and the address disagree until the carry has written the address.
 */
export async function hallTick(deps: HallDeps): Promise<HallView | null> {
    if (moving > 0) return null;
    const seen = movesStarted;
    const hall = await readHall();
    if (!hall) return run.backHome ? { kind: 'back-home', host: run.backHome } : null;
    const anchor = await deps.anchor().catch(() => null);
    const current = anchor && isPlainNodeAddress(anchor) ? plainOriginOf(anchor) : null;
    if (current !== hall.at) {
        if (stillSettled(seen)) await clearHall();
        return null;
    }
    const health = await deps.health(hall.at).catch(() => null);
    if (health) {
        run.homeAnswers = false;
        const lo = lightsOutOf(health);
        // A node that says nothing of lights-out (one from before H1) shows nothing and moves nobody.
        if (!lo) return null;
        if (lo.on) {
            run.recordAsOf = lo.recordAsOf;
            return { kind: 'in-hall', recordAsOf: lo.recordAsOf };
        }
        // The switch is off: the phone goes back to the address it came from (hall.home), checked by its statement. The
        // node's `home` is never a destination and needn't be the phone's own name: a community with two names (Byron)
        // gives its main name while phones saved under the other stay there. A `home` naming another community is never
        // asked, let alone followed.
        if (!stillSettled(seen)) return null;
        const moved = await goHome(deps).catch(() => 'not-same' as const);
        return moved === 'moved' ? { kind: 'back-home', host: hall.for } : null;
    }
    // The laptop gave no answer: the phone's own address, at most once an hour.
    const now = deps.now();
    if (run.homeTriedAt === null || now - run.homeTriedAt >= HOME_TRY_MS || now < run.homeTriedAt) {
        run.homeTriedAt = now;
        run.homeAnswers = await homeIsSame(hall, deps).catch(() => false);
    }
    if (run.homeAnswers) return { kind: 'home-answers', host: hall.for };
    return { kind: 'in-hall', recordAsOf: run.recordAsOf };
}

// ─── Words ──────────────────────────────────────────────────────────────────────────────────

/** "Tue 3 Nov, 14:02" in the member's language, or null for a time that can't be read. */
export function recordTime(iso: string | null): string | null {
    const ms = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    return `${formatDate(d, 'weekday-day-month')}, ${formatDate(d, 'time')}`;
}

/** The banner's lines: the first always, the second when there is one. */
export function hallBannerLines(view: HallView): { title: string; detail: string | null } {
    if (view.kind === 'in-hall') {
        const when = recordTime(view.recordAsOf);
        return {
            title: t("No internet. You're on the hall laptop."),
            detail: when ? t('The record is as of {when}. Trades made since then on the old server are not here.', { when }) : null,
        };
    }
    if (view.kind === 'home-answers') return { title: t('{host} answers again. Go back to it?', { host: view.host }), detail: null };
    return { title: t("The internet is back: you're on {host} again.", { host: view.host }), detail: null };
}

/** Why the door didn't open, said plainly; `ios` adds the Local Network line to a laptop that didn't answer. */
export function hallRefusalText(result: Exclude<EnterResult, { kind: 'moved' } | { kind: 'here' }>, ios: boolean): string {
    switch (result.kind) {
        case 'other-community':
            return t("This laptop is for {named}. Your phone's community is {home}, so nothing has changed.", { named: result.named, home: result.home });
        case 'no-community':
            return t('This phone has no community to bring to the hall yet. Join with an invite or your 12 words first.');
        case 'refused':
            switch (result.why) {
                case 'no-answer':
                    return ios
                        ? t("The laptop didn't answer. Check you are on the hall Wi-Fi. On an iPhone, BeanPool needs Local Network: Settings → BeanPool → Local Network.")
                        : t("The laptop didn't answer. Check you are on the hall Wi-Fi and the number is right.");
                case 'nothing-kept':
                    return t("This phone hasn't checked who its community is yet, so it can't check the laptop. Ask an owner for help.");
                case 'older':
                    return t('That laptop has an older copy of your community than the one your phone last used, so nothing has changed.');
                case 'not-same':
                case 'not-proved':
                default:
                    return t("That laptop isn't your community's server, so nothing has changed.");
            }
    }
}

// ─── The real dependencies ──────────────────────────────────────────────────────────────────

async function getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
        const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
        return res.ok ? await res.json().catch(() => null) : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export async function defaultHallDeps(): Promise<HallDeps> {
    const [{ switchPhoneTo }, { anchorUrl }, Crypto] = await Promise.all([
        import('./reconnect'), import('./node-post'), import('expo-crypto'),
    ]);
    return {
        anchor: anchorUrl,
        kept: keptCommunityIdentity,
        statement: (origin) => fetchIdentityStatement(origin),
        attest: (origin, nonce) => getJson(`${origin}${ATTEST_PATH}?nonce=${encodeURIComponent(nonce)}`),
        nonce: () => Array.from(Crypto.getRandomBytes(16), (b) => b.toString(16).padStart(2, '0')).join(''),
        health: (origin) => getJson(`${origin}/api/community/health`),
        switchTo: switchPhoneTo,
        now: () => Date.now(),
    };
}

/** The deps with some replaced (tests). */
export async function hallDepsWith(injected?: Partial<HallDeps>): Promise<HallDeps> {
    const keys: (keyof HallDeps)[] = ['anchor', 'kept', 'statement', 'attest', 'nonce', 'health', 'switchTo', 'now'];
    return keys.every((k) => injected?.[k]) ? (injected as HallDeps) : { ...(await defaultHallDeps()), ...injected };
}
