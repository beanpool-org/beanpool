/**
 * The member's signed statements that aren't requests: the "Manage" button's Settings sign-in, approving a browser's
 * phone sign-in (pairing), and an offline invite ticket (request binding, @beanpool/core request-signing.ts).
 *
 * The app builds every text it signs from fields it checked itself, and never signs text a node sent. Before this
 * the Manage button signed whatever "challenge" string the node answered with, so a hostile community could have it
 * sign a complete request for another community. Now:
 *
 *   - A node that says `requestSigning: 2` gets format 2 through core's builders: `0xFF ‖ beanpool-…/2\nHOST\n…`,
 *     bound to the host the app talks to, and the statement carries `signedFor: HOST` so the node knows which host's
 *     text to check.
 *   - A node whose info answered without it (older than #1219) gets the old form, rebuilt here from the checked
 *     fields. The Manage button signs the old challenge only when it is exactly the shape main's server makes
 *     (`beanpool-admin-auth:<the same 64-hex id>:<13-digit ms, near now>`), which can never be a request; anything
 *     else is refused and nothing is signed.
 *
 * Each one first refuses, signing nothing, a node address whose authority isn't exactly `host[:port]`
 * (node-url.ts `assertPlainNodeAddress`): on iOS such an address reaches a different host than the one signed for.
 */

import {
    audienceOf, signAdminSignin, signSettingsSignin, buildInviteTicket, utf8Bytes, toBase64, type Signer,
} from '@beanpool/core';
import { memberSigner } from './crypto';
import { requestSigningFormatFor } from './request-signing-version';
import { assertPlainNodeAddress } from './node-url';

const CHALLENGE_ID_RE = /^[0-9a-f]{64}$/;

/** How far the old server's challenge time may be from this phone's clock (its challenges live 60 s). */
export const OLD_CHALLENGE_CLOCK_SLACK_MS = 5 * 60_000;

/** Why nothing was signed. Shown as is. */
export const UNSIGNABLE_CHALLENGE_MESSAGE =
    "This community's server asked BeanPool to sign something that isn't a sign-in, so nothing was signed. " +
    'Try again later, or ask the community’s owner to update its server.';

export class UnsignableChallengeError extends Error {
    constructor() {
        super(UNSIGNABLE_CHALLENGE_MESSAGE);
        this.name = 'UnsignableChallengeError';
    }
}

/**
 * Whether `challenge` is exactly an old server's sign-in challenge for `challengeId` (apps/server
 * admin-key-auth.ts `createAdminChallenge` before request binding): `beanpool-admin-auth:<id>:<Date.now()>`, with the
 * same 64-hex id and a 13-digit millisecond time within {@link OLD_CHALLENGE_CLOCK_SLACK_MS} of now. No line break,
 * nothing before or after, so it can't be read as a request anywhere.
 */
export function isOldAdminChallenge(challenge: unknown, challengeId: unknown, now: number = Date.now()): boolean {
    if (typeof challenge !== 'string' || typeof challengeId !== 'string' || !CHALLENGE_ID_RE.test(challengeId)) return false;
    const m = /^beanpool-admin-auth:([0-9a-f]{64}):(\d{13})$/.exec(challenge);
    if (!m || m[1] !== challengeId) return false;
    return Math.abs(Number(m[2]) - now) <= OLD_CHALLENGE_CLOCK_SLACK_MS;
}

export interface SignedStatement {
    /** Base64. */
    signature: string;
    /** The host it was signed for, sent as `signedFor`. Absent in the old form. */
    signedFor?: string;
}

/**
 * The Manage button's signature for challenge `challengeId` at the node at `nodeUrl`. Throws
 * {@link UnsignableChallengeError}, having signed nothing, when the node's answer can't be signed safely.
 */
export async function signAdminChallenge(
    nodeUrl: string, chal: { challengeId?: unknown; challenge?: unknown }, privateKeyHex: string, now: number = Date.now(),
): Promise<SignedStatement> {
    assertPlainNodeAddress(nodeUrl);
    const { challengeId, challenge } = chal;
    if (await requestSigningFormatFor(nodeUrl) === 2) {
        const host = audienceOf(nodeUrl);
        if (!host || typeof challengeId !== 'string' || !CHALLENGE_ID_RE.test(challengeId)) throw new UnsignableChallengeError();
        return { signature: await signAdminSignin(nodeUrl, challengeId, memberSigner(privateKeyHex)), signedFor: host };
    }
    if (!isOldAdminChallenge(challenge, challengeId, now)) throw new UnsignableChallengeError();
    return { signature: await oldFormSignature(challenge as string, memberSigner(privateKeyHex)) };
}

/** The old pairing text. Must match pairingMessage() in the server's settings-signin-pairing.ts before request binding. */
export function oldPairingText(action: 'approve' | 'decline', pairingId: string, shortCode: string): string {
    return `beanpool-settings-signin:v1:${action}:${pairingId}:${shortCode}`;
}

/** Approving (or declining) the browser pairing `pairingId` shown by the node at `nodeUrl`. */
export async function signPairing(
    nodeUrl: string, action: 'approve' | 'decline', pairingId: string, shortCode: string, privateKeyHex: string,
): Promise<SignedStatement> {
    assertPlainNodeAddress(nodeUrl);
    if (await requestSigningFormatFor(nodeUrl) === 2) {
        const host = audienceOf(nodeUrl);
        if (!host) throw new Error('Cannot sign in: the node address names no host');
        return { signature: await signSettingsSignin(nodeUrl, action, pairingId, shortCode, memberSigner(privateKeyHex)), signedFor: host };
    }
    return { signature: await oldFormSignature(oldPairingText(action, pairingId, shortCode), memberSigner(privateKeyHex)) };
}

/**
 * An offline invite ticket from `inviter` for the community at `nodeUrl` (this phone's current community), as the
 * `BP-…` code the joiner types. Format 2 joins only there; the old form, for an older node, is the `{i, t, f}` JSON
 * builds before it made.
 */
export async function makeOfflineTicket(
    nodeUrl: string, inviter: string, privateKeyHex: string, opts: { intendedFor?: string | null; timestamp?: number } = {},
): Promise<string> {
    assertPlainNodeAddress(nodeUrl);
    const timestamp = opts.timestamp ?? Date.now();
    const sign = memberSigner(privateKeyHex);
    if (await requestSigningFormatFor(nodeUrl) === 2) {
        return `BP-${await buildInviteTicket(nodeUrl, inviter, sign, { timestamp, intendedFor: opts.intendedFor || null })}`;
    }
    const payload = JSON.stringify({ i: inviter, t: timestamp, f: opts.intendedFor || undefined });
    const s = await oldFormSignature(payload, sign);
    return `BP-${toBase64(utf8Bytes(JSON.stringify({ p: toBase64(utf8Bytes(payload)), s })))}`;
}

/** The old forms are plain UTF-8, which never starts with the 0xFF every format-2 signature does. */
async function oldFormSignature(text: string, sign: Signer): Promise<string> {
    return toBase64(await sign(utf8Bytes(text)));
}
