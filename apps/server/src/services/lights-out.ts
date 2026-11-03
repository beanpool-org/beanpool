/**
 * Lights-out: the owner's switch for the hall (design scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §2.1, §2.7,
 * §3.5, §3.6, §4; slice H1).
 *
 * When the internet and the phone network are down, the community's record is on a laptop in the hall and members reach it
 * by its number on the hall Wi-Fi (http://192.168.8.1:8080). The switch is what lets them:
 *   - the plain port answers a phone straight from the hall Wi-Fi (direct-lan-source.ts) as it always did, instead of a 301
 *     to https, on a server that holds a certificate of its own (plain-http-gate.ts). A public source, and anything that came
 *     through a tunnel or proxy, is unchanged;
 *   - /api/community/health and /api/community/info say so (`lightsOut`, {@link publicLightsOut}), which the phone's banner
 *     and the hall page read;
 *   - GET /hall shows the poster (routes/lights-out.ts);
 *   - a server whose record came from a backup raises its identity epoch, once (§2.1 item 3), so every phone that reaches it
 *     takes the hall's record whole and the old server, seeing the higher epoch at the community's name, goes read-only;
 *   - address changes are refused (§2.7): a change made in the hall would send every phone to a dead address on return.
 *
 * Who may flip it: an owner, with the fresh proof (admin-auth.ts requireFreshProof: the phone's Manage within 90 s, or the
 * admin password with a current authenticator code; never a token, an admin, a break-glass code or an assistant), an owner's
 * own signed request from the app (routes/lights-out.ts), or the laptop's shell (`beanpool lights-out`, lights-out-command.ts).
 * Never a standby: a standby takes over first. Never automatic (§2.1 "Never automatic").
 *
 * The switch lives in local-config.json (`lightsOut`), never in the database, and is left out of every copy: a backup file's
 * node_config.json (LEFT_OUT_OF_BACKUPS), the stager's copy, the take-over bundle (its fixed field list) and anything a
 * standby pulls. So a hall laptop's "on" can never come back to life on the rented server.
 *
 * What it never changes: who may do what, the money rules, request binding (the phone signs for the community's name, not
 * the number: §2.3), the 5-minute window and the nonces, the standby's refusal to move Beans.
 */

import path from 'node:path';
import type Koa from 'koa';
import { getLocalConfig, updateLocalConfig, type LightsOutRecord } from '../config/local-config.js';
import { getNodeRole } from '../state-engine.js';
import { primaryAddress, isLocalNetworkHost, isLoopbackHost, normalizeAddress } from '../engine/own-addresses.js';
import { ownIdentityEpoch, forgetSyncEpochHeaderValue } from './identity-epoch.js';
import { logger } from '../logger.js';
import { writeFileAtomic } from '../write-file-atomic.js';
import { LIGHTS_OUT_ANSWER_FILE, takeLightsOutRequest, type LightsOutAnswer, type LightsOutRequest } from './lights-out-files.js';
export { LIGHTS_OUT_ANSWER_FILE, LIGHTS_OUT_REQUEST_FILE, takeLightsOutAnswer, writeLightsOutRequest } from './lights-out-files.js';

/** Who flipped it, for the log and Settings. */
export type LightsOutBy = 'owner-key' | 'password' | 'shell';

/** The refusal §2.7 gives an address change while the switch is on. */
export const NOT_WHILE_LIGHTS_OUT = 'Not while the lights are out. Turn lights-out off first, once the internet is back.';
export const NOT_ON_A_STANDBY = 'A standby cannot open the hall. Take over as the main server first, then turn lights-out on.';

/**
 * The address-change routes refused while on (§2.7): claiming or releasing a name, Take offline, changing the public
 * address, confirming or removing an address. Reads (`/check`) and a tunnel restart are not changes.
 */
export const ADDRESS_CHANGE_PATHS: readonly string[] = [
    '/api/local/admin/public-address/claim', '/api/local/admin/public-address/offline', '/api/local/admin/public-address/own',
    '/api/local/admin/public-address/release-name', '/api/local/admin/public-address/rotate', '/api/local/admin/public-address/update',
    '/api/local/admin/app-addresses/confirm', '/api/local/admin/app-addresses/remove',
];

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

function record(): LightsOutRecord | null {
    const r = getLocalConfig().lightsOut;
    return r && typeof r === 'object' ? r : null;
}

/** Whether the switch is on here. A standby is never on, whatever its file says (it cannot have been switched there). */
export function lightsOutOn(): boolean {
    return record()?.on === true && getNodeRole() !== 'backup';
}

/**
 * The hall address an owner gave: `http://<a local-network number or .local/.lan name>[:port]`, nothing else (no path, no
 * user, no https: a hall laptop has no certificate a phone trusts). Null when it is none of those.
 */
export function hallAddressOf(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const raw = input.trim();
    if (!raw || raw.length > 80) return null;
    let u: URL;
    try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`); } catch { return null; }
    if (u.protocol !== 'http:' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
    const host = normalizeAddress(u.host);
    if (!host || isLoopbackHost(host)) return null;
    if (!isLocalNetworkHost(host) && !host.endsWith('.lan')) return null;
    return `http://${u.host.toLowerCase()}`;
}

/** Where members' phones go home to: the community's main address, https. Null when it has none (a LAN-only community). */
export function homeAddress(): string | null {
    const p = primaryAddress();
    return p ? `https://${p}` : null;
}

/**
 * How old the hall's record is (§3.5): a restored server's backup's made-at; a promoted standby's last good copy; null on a
 * server that was always the main server (the banner then says only that the internet is down). Whichever came last of a
 * restore and a take-over decides; the epoch this switch raised itself is not a take-over.
 */
export function recordAsOfNow(): string | null {
    const c = getLocalConfig();
    const restored = c.restoredCopy && typeof c.restoredCopy === 'object' ? c.restoredCopy : null;
    const raisedAt = record()?.raised?.at ?? null;
    const tookOverAt = c.identityEpochSince && c.identityEpochSince !== raisedAt ? c.identityEpochSince : null;
    const restoredAt = restored ? Date.parse(restored.at) : NaN;
    if (restored && (!tookOverAt || !(Date.parse(tookOverAt) > restoredAt))) return validIso(restored.madeAt);
    if (tookOverAt) return validIso(c.lastPromotionAudit?.copy?.lastCopy?.generatedAt ?? null);
    return null;
}

function validIso(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * §2.1 item 3: a server whose record came from a backup raises its epoch when the switch goes on, as a take-over does: the
 * file's epoch (or this server's, whichever is higher) + 1, `since` now. Not for a server that took over after its last
 * restore (its take-over raised it already), not for one never restored, and never twice for one restore.
 */
function raiseEpochForRestoredCopy(now: string): { raised: boolean; epoch: number; why: string } {
    const c = getLocalConfig();
    const restored = c.restoredCopy && typeof c.restoredCopy === 'object' ? c.restoredCopy : null;
    const own = ownIdentityEpoch();
    if (!restored) return { raised: false, epoch: own.epoch, why: 'never restored from a backup' };
    const prior = record()?.raised ?? null;
    if (prior && prior.for === restored.at) return { raised: false, epoch: own.epoch, why: 'raised already for this restore' };
    const tookOverAt = c.identityEpochSince && c.identityEpochSince !== prior?.at ? Date.parse(c.identityEpochSince) : NaN;
    if (Number.isFinite(tookOverAt) && tookOverAt > Date.parse(restored.at)) {
        return { raised: false, epoch: own.epoch, why: 'took over after the restore: its take-over raised it' };
    }
    const fileEpoch = Number.isSafeInteger(restored.epoch) && restored.epoch > 0 ? restored.epoch : 0;
    const epoch = Math.max(own.epoch, fileEpoch) + 1;
    updateLocalConfig({ identityEpoch: epoch, identityEpochSince: now, identityReplaced: null });
    forgetSyncEpochHeaderValue();
    return { raised: true, epoch, why: 'restored from a backup' };
}

/** A fingerprint of everything members wrote here, so OFF can tell whether anyone wrote in the hall (the stand-down offer). */
let hallWritesNoted = false;

export interface LightsOutStatus {
    on: boolean;
    since: string | null;
    address: string | null;
    recordAsOf: string | null;
    home: string | null;
    epoch: number;
    epochSince: string | null;
    /** Whether members wrote anything here since it last went on. */
    hallWrites: boolean;
    /** Off, after a hall with no writes, on a server that took over or was restored: "Stand down" is offered (§3.6 case 2). */
    standDown: StandDownOffer | null;
    standby: boolean;
}

export interface StandDownOffer {
    offered: true;
    /** The steps, in the order an owner takes them (Settings shows them; H4 and the manual carry the words). */
    steps: string[];
}

/** §3.6 case 2: nobody traded in the hall, and this server is a copy (restored or took over): go back to being the standby. */
function standDownOffer(r: LightsOutRecord | null): StandDownOffer | null {
    if (!r || r.on || !r.since || r.hallWrites) return null;
    const c = getLocalConfig();
    const isCopy = !!(c.restoredCopy || c.identityEpochSince);
    if (!isCopy) return null;
    return {
        offered: true,
        steps: [
            'Nobody wrote anything on this laptop while the hall was open, so the rented server can stay the community.',
            'Stop this laptop\'s node, set NODE_ROLE=backup in its .env and start it again.',
            'On the rented server: Settings, Replication Access, make a pairing code. On this laptop\'s shell: beanpool pair.',
            'Members\' phones go home by themselves.',
        ],
    };
}

export function lightsOutStatus(): LightsOutStatus {
    const r = record();
    const epoch = ownIdentityEpoch();
    const on = lightsOutOn();
    return {
        on,
        since: r?.since ?? null,
        address: r?.address ?? null,
        recordAsOf: on ? (r?.recordAsOf ?? null) : recordAsOfNow(),
        home: homeAddress(),
        epoch: epoch.epoch,
        epochSince: epoch.since,
        hallWrites: !!r?.hallWrites,
        standDown: standDownOffer(r),
        standby: getNodeRole() === 'backup',
    };
}

/**
 * What /api/community/health and /api/community/info carry (the fields H2 reads): always present, so a phone can tell a node
 * that knows lights-out from one that doesn't (absent). Public: nothing in it is a secret, and a stranger on the hall Wi-Fi
 * can read the poster anyway.
 */
export function publicLightsOut(): { on: boolean; since: string | null; address: string | null; recordAsOf: string | null; home: string | null; epoch: number } {
    const s = lightsOutStatus();
    return { on: s.on, since: s.on ? s.since : null, address: s.on ? s.address : null, recordAsOf: s.on ? s.recordAsOf : null, home: s.home, epoch: s.epoch };
}

export type SwitchOutcome =
    | { ok: true; status: LightsOutStatus; changed: boolean; epochRaised: boolean }
    | { ok: false; status: 400 | 403; error: string };

/**
 * Turn the switch on or off. `address` is the hall address the owner confirmed (hallAddressOf), or null. "On" twice is "on"
 * (the first `since` is kept; a new address replaces the old). Logged as a SECURITY line.
 */
export function setLightsOut(on: boolean, opts: { address?: unknown; by: LightsOutBy; actor?: string | null }): SwitchOutcome {
    if (getNodeRole() === 'backup') return { ok: false, status: 403, error: NOT_ON_A_STANDBY };
    let address: string | null = null;
    if (opts.address !== undefined && opts.address !== null && opts.address !== '') {
        address = hallAddressOf(opts.address);
        if (!address) {
            return { ok: false, status: 400, error: 'The hall address is the laptop\'s number on the hall Wi-Fi, like http://192.168.8.1:8080.' };
        }
    }
    const now = new Date().toISOString();
    const before = record();
    const who = opts.by === 'shell' ? 'the server\'s shell' : opts.by === 'password' ? 'the admin password' : `an owner's key${opts.actor ? ` (${opts.actor.slice(0, 12)}…)` : ''}`;
    if (on) {
        const wasOn = lightsOutOn();
        const raise = raiseEpochForRestoredCopy(now);
        const next: LightsOutRecord = {
            on: true,
            since: wasOn && before?.since ? before.since : now,
            address: address ?? (wasOn ? before?.address ?? null : null),
            recordAsOf: null,
            home: homeAddress(),
            by: opts.by,
            offAt: null,
            hallWrites: wasOn ? !!before?.hallWrites : false,
            raised: raise.raised ? { for: getLocalConfig().restoredCopy!.at, at: now, epoch: raise.epoch } : (before?.raised ?? null),
        };
        // After the raise: the raise's own `since` is never read as a take-over.
        updateLocalConfig({ lightsOut: next });
        next.recordAsOf = recordAsOfNow();
        updateLocalConfig({ lightsOut: next });
        if (!wasOn) hallWritesNoted = false;
        logger.security('ADMIN', `[LightsOut] Lights-out ON by ${who}${next.address ? ` at ${next.address}` : ''}: the plain port answers the hall Wi-Fi; `
            + (raise.raised ? `identity epoch raised to ${raise.epoch} (${raise.why}).` : `identity epoch unchanged at ${raise.epoch} (${raise.why}).`));
        return { ok: true, status: lightsOutStatus(), changed: !wasOn, epochRaised: raise.raised };
    }
    const wasOn = before?.on === true;
    if (before) updateLocalConfig({ lightsOut: { ...before, on: false, offAt: wasOn ? now : before.offAt ?? null } });
    if (wasOn) {
        logger.security('ADMIN', `[LightsOut] Lights-out OFF by ${who}: the plain port is back to its usual rule`
            + `${before?.hallWrites ? '; members wrote in the hall, so this copy is the community now' : '; nobody wrote in the hall'}.`);
    }
    return { ok: true, status: lightsOutStatus(), changed: wasOn, epochRaised: false };
}

/** A member's write answered 2xx while the switch is on: noted once, so OFF knows the hall copy holds something new. */
export function noteHallWrite(): void {
    if (hallWritesNoted) return;
    const r = record();
    if (!r?.on) return;
    hallWritesNoted = true;
    if (!r.hallWrites) updateLocalConfig({ lightsOut: { ...r, hallWrites: true } });
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Koa middleware on the app (after the split-brain guard): while the switch is on, the address changes of §2.7 are refused
 * (409), and the first member write answered 2xx is noted (the stand-down offer). Members' writes are every POST, PUT,
 * PATCH or DELETE under /api/ but the owners' and operators' own (/api/local/, /api/manager/), as the split-brain guard
 * counts them.
 */
export async function lightsOutGuard(ctx: Koa.Context, next: Koa.Next): Promise<void> {
    if (!MUTATING.has(ctx.method)) return next();
    const p = ctx.path.toLowerCase().replace(/\/+$/, '');
    if (ADDRESS_CHANGE_PATHS.includes(p) && lightsOutOn()) {
        ctx.status = 409;
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { error: NOT_WHILE_LIGHTS_OUT, code: 'lights_out' };
        return;
    }
    await next();
    if (ctx.status >= 200 && ctx.status < 300 && p.startsWith('/api/') && !p.startsWith('/api/local/') && !p.startsWith('/api/manager/')
        && !p.startsWith('/api/node/owner/lights-out') && lightsOutOn()) {
        try { noteHallWrite(); } catch { /* a note never fails a member's write */ }
    }
}

/** Called by the restore (routes/backup.ts) once a backup replaced this server's record: what lights-out reads later. */
export function noteRestoredCopy(madeAt: string | null, epoch: unknown): void {
    const n = Number(epoch);
    updateLocalConfig({ restoredCopy: { at: new Date().toISOString(), madeAt: validIso(madeAt), epoch: Number.isSafeInteger(n) && n > 0 ? n : 0 } });
}

// ── The shell: `beanpool lights-out on|off|status` (lights-out-command.ts) ─────────────────────────────────────────
//
// The pattern of `beanpool pair`: the command leaves data/lights-out-request.json, the running node takes it within ~2 s
// and answers in data/lights-out-answer.json. Whoever runs it holds the data folder already, more than any session.

/** The lines `beanpool lights-out status` prints. */
export function statusLines(s: LightsOutStatus): string[] {
    const lines = [s.on ? `Lights-out is ON${s.since ? ` since ${s.since}` : ''}.` : 'Lights-out is off.'];
    if (s.on) lines.push(s.address ? `The hall address: ${s.address}` : 'No hall address was given: phones type the laptop\'s number.');
    if (s.recordAsOf) lines.push(`The record is as of ${s.recordAsOf}.`);
    if (s.home) lines.push(`Home, when the internet is back: ${s.home}`);
    lines.push(`Identity epoch: ${s.epoch}.`);
    if (s.standDown) lines.push(...s.standDown.steps);
    if (s.standby) lines.push('This server is a standby: take over as the main server before turning lights-out on.');
    return lines;
}

export function answerLightsOutRequest(req: LightsOutRequest): LightsOutAnswer {
    if (req.action === 'status') return { v: 1, id: req.id, ok: true, lines: statusLines(lightsOutStatus()) };
    const out = setLightsOut(req.action === 'on', { address: req.address, by: 'shell' });
    if (!out.ok) return { v: 1, id: req.id, ok: false, lines: [`Nothing was changed. ${out.error}`] };
    return { v: 1, id: req.id, ok: true, lines: statusLines(out.status) };
}

let watchTimer: ReturnType<typeof setInterval> | null = null;

/** The node's 2 s look for data/lights-out-request.json, on every role (a standby answers with its refusal). */
export function startLightsOutRequestWatch(dir = dataDir(), everyMs = 2000): void {
    if (watchTimer) return;
    watchTimer = setInterval(() => {
        const req = takeLightsOutRequest(dir);
        if (!req) return;
        let answer: LightsOutAnswer;
        try { answer = answerLightsOutRequest(req); } catch (e: any) { answer = { v: 1, id: req.id, ok: false, lines: [`The node could not do it (${e?.message || e}).`] }; }
        try { writeFileAtomic(path.join(dir, LIGHTS_OUT_ANSWER_FILE), JSON.stringify(answer), { mode: 0o600 }); } catch (e: any) { console.warn(`[LightsOut] ${e?.message || e}`); }
    }, everyMs);
    watchTimer.unref?.();
}

export function stopLightsOutRequestWatch(): void {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
}
