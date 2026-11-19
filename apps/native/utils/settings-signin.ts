/**
 * Settings → "Manage this community from a computer": an owner, admin or moderator scans the QR on their node's /settings page in a browser,
 * and — after the phone's own unlock — signs that browser in with their member key. Like WhatsApp Web.
 *
 *   1. The scan is read with @beanpool/core's parseSettingsSigninQr and must name THIS app's node: a code from any
 *      other node is refused with both names shown, never approved.
 *   2. The node is asked about the pairing (GET …/pairing/<id>): its short code must match the one in the QR, and
 *      it says which browser asked ("Firefox on Windows") so the owner can notice a computer that isn't theirs.
 *   3. The owner confirms, then the phone's unlock — the same gate as Manage (requireDeviceUnlock, fails closed).
 *   4. The approval: the member key signs `0xFF ‖ beanpool-settings-signin/2\n<host>\napprove\n<id>\n<code>`, bound
 *      to the host the phone sends it to and sent with `signedFor: <host>` (request binding, member-statements.ts),
 *      so a node that relays another community's pairing gets a signature that community refuses. A node older than
 *      request binding gets the old `beanpool-settings-signin:v1:approve:<id>:<code>`. The node checks the live role
 *      and its 2FA code, and signs in only the browser that showed the code — it holds a secret this phone never
 *      sees. Nothing comes back to the phone but "done".
 *
 * Server: apps/server/src/settings-signin-pairing.ts. Page: apps/manager/src/components/auth/PhoneSignIn.tsx.
 */

import { parseSettingsSigninQr, isSameNode, nodeOrigin, type SettingsSigninQr } from '@beanpool/core';
import type { BeanPoolIdentity } from './identity';
import { requireDeviceUnlock } from './node-admin';
import { signAssistantApproval, signPairing } from './member-statements';
import type { AssistantTicks } from '@beanpool/core';
import { buildSignedHeaders } from './crypto';
import { plainOriginOf } from './node-url';
import { heldAddress, type ProveAtScan } from './pair-device-target';
import { communityRecordOf, type CommunityRecord } from './community-index';

export type ScanResult =
    /** `prove`: the community's key is known, so the code's address proves at the scan (pair-device-target.ts provedAtScan). */
    | { kind: 'ok'; qr: SettingsSigninQr; prove?: ProveAtScan }
    | { kind: 'wrong-node'; scannedHost: string; appHost: string }
    | { kind: 'not-signin' }
    | { kind: 'malformed' }
    | { kind: 'no-node' };

function host(url: string): string {
    const o = nodeOrigin(url);
    return o ? o.replace(/^https?:\/\//, '') : url;
}

/**
 * Is this a sign-in code for the community this app is on? Its address, or another its own signed list names (addresses
 * S5, §3.6: the phone's own spelling of it, from the list it keeps, is where the approval goes). `prove` says the screen
 * must prove the address at the scan before anything is asked or signed.
 */
export function readSigninScan(text: unknown, appNodeUrl: string | null, recordOf: (address: string) => CommunityRecord | null = communityRecordOf): ScanResult {
    const parsed = parseSettingsSigninQr(text);
    if (!parsed.ok) return { kind: parsed.reason };
    if (!appNodeUrl) return { kind: 'no-node' };
    const own = plainOriginOf(appNodeUrl);
    if (!isSameNode(parsed.nodeUrl, appNodeUrl)) {
        const scanned = plainOriginOf(parsed.nodeUrl);
        const held = scanned && own ? heldAddress(scanned, [own], recordOf) : null;
        if (!held) return { kind: 'wrong-node', scannedHost: host(parsed.nodeUrl), appHost: host(appNodeUrl) };
        return { kind: 'ok', qr: { nodeUrl: held.origin, pairingId: parsed.pairingId, shortCode: parsed.shortCode }, ...(held.prove ? { prove: held.prove } : {}) };
    }
    const prove = own ? heldAddress(own, [own], recordOf)?.prove : undefined;
    return { kind: 'ok', qr: { nodeUrl: parsed.nodeUrl, pairingId: parsed.pairingId, shortCode: parsed.shortCode }, ...(prove ? { prove } : {}) };
}

export function scanProblemMessage(r: Exclude<ScanResult, { kind: 'ok' }>): { title: string; message: string } {
    switch (r.kind) {
        case 'wrong-node':
            return {
                title: 'A different community',
                message: `This code is for ${r.scannedHost}. Your phone uses ${r.appHost}. Open Settings at ${r.appHost} and scan again, or move your phone first.`,
            };
        case 'no-node':
            return { title: 'Not connected', message: 'Connect to your community first.' };
        case 'malformed':
            return { title: "Can't read that code", message: 'It looks like a sign-in code but part of it is missing. Get a new code on the computer and scan again.' };
        case 'not-signin':
        default:
            return { title: 'Not a sign-in code', message: "That isn't a BeanPool Settings sign-in code. On the computer, open your community's Settings and choose “Sign in with your phone”." };
    }
}

/** "K7F 3QX", as the computer shows it. */
export function formatShortCode(code: string): string {
    return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

const pairingPath = (id: string) => `/api/local/admin/auth/pairing/${id}`;

/**
 * The assistant behind a consent code: its own name (anyone can register any name), where what it reads goes, and what the
 * computer's page asks it may do beyond reading (its two ticks): this screen shows them and the approval signs them.
 */
export interface AgentAsking { name: string; sendsTo: string; asks: AssistantTicks }

const HOST_SHAPE = /^[a-z0-9.\-:[\]]{1,253}$/i;

/** The node's `agent`, or null: a host that isn't a host shape is not shown (nor approved: the screen would mislead). */
export function readAgent(v: unknown): AgentAsking | null {
    if (!v || typeof v !== 'object') return null;
    const a = v as { name?: unknown; sendsTo?: unknown; asks?: unknown };
    if (typeof a.sendsTo !== 'string' || !HOST_SHAPE.test(a.sendsTo)) return null;
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    const name = typeof a.name === 'string' ? a.name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 60) : '';
    const asks = (a.asks && typeof a.asks === 'object' ? a.asks : {}) as { canPost?: unknown; canModerate?: unknown };
    return { name, sendsTo: a.sendsTo.toLowerCase(), asks: { canPost: asks.canPost === true, canModerate: asks.canModerate === true } };
}

export type PairingLookup =
    | {
        kind: 'ok'; browser: string; expiresAt: number;
        /** From the node, relative, so this phone's clock can be wrong. Null from a node older than these. */
        expiresInSeconds: number | null;
        askedSecondsAgo: number | null;
        /** The computer's address as the node saw it — learned from the node, never from the QR. */
        fromAddress: string | null;
        /** The node saw this phone's lookup come from the computer's network. */
        sameNetwork: boolean;
        /** The node could compare both addresses and they differ: the computer is on another network (the loud line). */
        otherNetwork: boolean;
        /**
         * An AI assistant asking to connect for you (admin MCP S2), not a computer signing in: the name it gave itself and
         * the host its answers go to. Null for a Settings sign-in.
         */
        agent: AgentAsking | null;
    }
    | { kind: 'gone'; message: string }
    | { kind: 'error'; message: string };

/** The node's view of the pairing. Refuses a QR whose short code the node does not recognise. */
export async function lookupPairing(qr: SettingsSigninQr, identity?: BeanPoolIdentity | null): Promise<PairingLookup> {
    try {
        const url = `${qr.nodeUrl}${pairingPath(qr.pairingId)}`;
        // Signed as the app signs a GET: the node tells only a member who could approve where the computer asked from.
        // A lookup it can't sign still goes, unsigned, and shows the rest.
        const signed = identity
            ? await buildSignedHeaders('GET', url, '', identity.privateKey, identity.publicKey).catch(() => ({}))
            : {};
        const res = await fetch(url, { headers: { Accept: 'application/json', ...signed } });
        const body = await res.json().catch(() => ({})) as {
            shortCode?: unknown; browser?: unknown; expiresAt?: unknown; error?: unknown;
            expiresInSeconds?: unknown; askedSecondsAgo?: unknown; fromAddress?: unknown; sameNetwork?: unknown; otherNetwork?: unknown; agent?: unknown;
        };
        if (res.ok) {
            if (body.shortCode !== qr.shortCode) {
                return { kind: 'gone', message: "The code on the computer doesn't match this QR. Get a new code on the computer and scan again." };
            }
            return {
                kind: 'ok',
                browser: typeof body.browser === 'string' && body.browser ? body.browser : 'A browser',
                expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : 0,
                expiresInSeconds: seconds(body.expiresInSeconds),
                askedSecondsAgo: seconds(body.askedSecondsAgo),
                fromAddress: typeof body.fromAddress === 'string' && body.fromAddress && body.fromAddress !== 'unknown' ? body.fromAddress.slice(0, 64) : null,
                sameNetwork: body.sameNetwork === true,
                otherNetwork: body.otherNetwork === true && body.sameNetwork !== true,
                agent: readAgent(body.agent),
            };
        }
        const message = typeof body.error === 'string' ? body.error : `The node did not answer (${res.status}).`;
        return res.status === 404 || res.status === 410 ? { kind: 'gone', message } : { kind: 'error', message };
    } catch (e: any) {
        return { kind: 'error', message: e?.message || 'Could not reach the node.' };
    }
}

const seconds = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** The approval sheet's heading: name the trick, so a story ("scan this to verify your account") gets a No. */
export const SIGNIN_QUESTION = 'Did you just open Settings on a computer?';
export const SIGNIN_WARNING = 'If someone sent you this code, tap No.';

/** The sheet for an AI assistant's consent: the question, the warning, and what it is, the name never alone. */
export const AGENT_QUESTION = 'Did you just add this community to an AI assistant?';
export const AGENT_WARNING = "If someone sent you this code, or you don't know where it sends, tap No.";

export function agentLines(a: AgentAsking): string[] {
    return [
        a.name ? `Assistant: “${a.name}” (the name it gave itself)` : 'Assistant: no name given',
        `Sends what it reads to: ${a.sendsTo}`,
        'It reads health, backups, totals, reports and join requests as you. If you are an owner, it can also take a backup and post Offers, Needs, events and polls for you, at once, with no approval. Anything else it can only suggest, and nothing changes until you approve.',
        ...asksLines(a.asks),
    ];
}

/** What the computer's page asks the assistant may do (its ticks): the approval covers exactly these. */
export function asksLines(asks: AssistantTicks): string[] {
    const lines: string[] = [];
    if (asks.canPost) lines.push('Ticked on the computer: May post for me. An owner\'s assistant posts Offers, Needs, events and polls as you, at once.');
    if (asks.canModerate) lines.push('Ticked on the computer: May take down posts for me, at once.');
    if (!lines.length) lines.push('Nothing ticked on the computer: it posts nothing and takes nothing down.');
    return lines;
}

/** The loud line when the node saw the computer on another network than this phone (risk 2). */
export const OTHER_NETWORK_WARNING = 'The computer is on a different network from this phone. If it is not your own computer, in front of you, tap No.';

/** "1:35 left" */
export function formatTimeLeft(secondsLeft: number): string {
    const s = Math.max(0, Math.ceil(secondsLeft));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
}

function ago(s: number): string {
    if (s < 60) return `Asked ${s} ${s === 1 ? 'second' : 'seconds'} ago`;
    return `Asked ${Math.floor(s / 60)} min ${s % 60} s ago`;
}

/**
 * What the sheet says about the computer: the browser, how long ago it asked (plus the seconds the sheet has been
 * open), and the address it asked from, with "same network as this phone" only when the node saw both on one network.
 */
export function computerLines(look: Extract<PairingLookup, { kind: 'ok' }>, openSeconds: number): string[] {
    const lines = [`Computer: ${look.browser}`];
    if (look.askedSecondsAgo !== null) lines.push(ago(look.askedSecondsAgo + Math.max(0, Math.floor(openSeconds))));
    if (look.fromAddress) lines.push(`From ${look.fromAddress}${look.sameNetwork ? ' (same network as this phone)' : ''}`);
    return lines;
}

/** After the approval, on a node with number matching. */
export function confirmDigitsLine(code: string): string {
    return `On the computer, type ${code}`;
}

/** "123 456": six digits in two groups, as the eye reads them across a desk. The computer takes them with or without the space. */
export function formatDigits(code: string): string {
    return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** Under the digits: the one move left to someone who sent the QR is to ask for them (4171995285). */
export const DIGITS_PRIVATE = 'Never read them out or send them to anyone: type them yourself, on the computer you just opened.';

/** How long the computer has to type the digits (PAIRING_CONFIRM_TTL_MS on the node), counted from the approval. */
export const DIGITS_SHOWN_MS = 30_000;

/** The digits' Done button: held until the computer's time is up, so a habit tap can't hide them before they're typed. */
export function digitsDone(msLeft: number): { enabled: boolean; label: string } {
    if (msLeft <= 0) return { enabled: true, label: 'Done' };
    return { enabled: false, label: `Done (0:${String(Math.ceil(msLeft / 1000)).padStart(2, '0')})` };
}

/**
 * The approval (or decline) request: POST …/pairing/<id>/<action>, JSON { memberPubkey, signature[, signedFor][, totpCode] }.
 * Signed for the host it is POSTed to (`qr.nodeUrl`, which readSigninScan has checked is this app's node).
 */
export async function buildSigninRequest(
    action: 'approve' | 'decline', qr: SettingsSigninQr, identity: BeanPoolIdentity, totpCode?: string, agentShown = false, ticks?: AssistantTicks,
): Promise<{ url: string; init: RequestInit }> {
    // An assistant's approval names the ticks this screen showed (risk 3); a sign-in and any decline do not.
    const signed = action === 'approve' && agentShown && ticks
        ? await signAssistantApproval(qr.nodeUrl, qr.pairingId, qr.shortCode, ticks, identity.privateKey)
        : await signPairing(qr.nodeUrl, action, qr.pairingId, qr.shortCode, identity.privateKey);
    return {
        url: `${qr.nodeUrl}${pairingPath(qr.pairingId)}/${action}`,
        init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                memberPubkey: identity.publicKey,
                signature: signed.signature,
                ...(signed.signedFor ? { signedFor: signed.signedFor } : {}),
                ...(action === 'approve' && totpCode ? { totpCode: totpCode.trim() } : {}),
                // This app shows the node's six digits, so the computer must type them (number matching, risk 2).
                ...(action === 'approve' ? { confirm: 'six-digits' } : {}),
                // This screen showed an AI assistant's name, where it sends and what it asks to do (the node refuses an
                // assistant's approval without them, and grants only the ticks signed here).
                ...(action === 'approve' && agentShown ? { agentShown: true, ...(ticks ? { ticks: { canPost: ticks.canPost === true, canModerate: ticks.canModerate === true } } : {}) } : {}),
            }),
        },
    };
}

export type ApproveOutcome =
    | { kind: 'approved'; confirmCode?: string }
    | { kind: 'no-device-lock' }
    | { kind: 'unlock-failed' }
    | { kind: 'totp-required'; wrongCode: boolean; continueWith: (code: string) => Promise<ApproveOutcome> }
    | { kind: 'refused'; message: string }
    | { kind: 'error'; message: string };

/**
 * The "Sign in" press: the phone's unlock first — nothing is signed or sent without it — then the approval.
 * When the node wants its 2FA code, `continueWith` retries without asking for the unlock again (and is only
 * reachable after it succeeded), as in manageNode.
 */
export async function approveComputerSignin(opts: {
    qr: SettingsSigninQr;
    identity: BeanPoolIdentity;
    communityName: string;
    /** The sheet showed lookupPairing's `agent`: this approval connects that assistant. */
    agentShown?: boolean;
    /** The ticks the sheet showed for that assistant (its `asks`): the approval signs them. */
    ticks?: AssistantTicks;
}): Promise<ApproveOutcome> {
    const unlock = await requireDeviceUnlock(opts.communityName);
    if (unlock === 'no-device-lock') return { kind: 'no-device-lock' };
    if (unlock !== 'ok') return { kind: 'unlock-failed' };

    const attempt = async (totpCode?: string): Promise<ApproveOutcome> => {
        try {
            const { url, init } = await buildSigninRequest('approve', opts.qr, opts.identity, totpCode, opts.agentShown === true, opts.ticks);
            const res = await fetch(url, init);
            const body = await res.json().catch(() => ({})) as { success?: boolean; totpRequired?: boolean; error?: string; reason?: string; confirmCode?: unknown };
            if (res.ok && body.success) {
                return typeof body.confirmCode === 'string' && /^\d{6}$/.test(body.confirmCode)
                    ? { kind: 'approved', confirmCode: body.confirmCode }
                    : { kind: 'approved' };
            }
            if (body.totpRequired) return { kind: 'totp-required', wrongCode: !!totpCode, continueWith: attempt };
            if (body.reason === 'not-admin') return { kind: 'refused', message: `You are not an owner, admin or moderator of ${opts.communityName}, so you can't open its Settings.` };
            if (res.status === 403 || res.status === 404 || res.status === 409 || res.status === 410 || res.status === 426) {
                return { kind: 'refused', message: body.error || 'The node refused the sign-in.' };
            }
            if (res.status === 429) return { kind: 'error', message: body.error || 'Too many attempts. Wait a minute and try again.' };
            return { kind: 'error', message: body.error || `The node did not answer (${res.status}).` };
        } catch (e: any) {
            return { kind: 'error', message: e?.message || 'Could not reach the node.' };
        }
    };
    return attempt();
}

/** "No, that's not me": ends the pairing so the computer stops waiting. Best effort. */
export async function declineComputerSignin(qr: SettingsSigninQr, identity: BeanPoolIdentity): Promise<void> {
    try {
        const { url, init } = await buildSigninRequest('decline', qr, identity);
        await fetch(url, init);
    } catch { /* the code expires in two minutes anyway */ }
}
