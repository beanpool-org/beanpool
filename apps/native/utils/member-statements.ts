/**
 * The member's signed statements that aren't requests: the "Manage" button's Settings sign-in, approving a browser's
 * phone sign-in (pairing), an offline invite ticket, and a leaving account's push leave statement (request binding,
 * @beanpool/core request-signing.ts).
 *
 * The app builds every text it signs from fields it checked itself, and never signs text a node sent. Before this
 * the Manage button signed whatever "challenge" string the node answered with, so a hostile community could have it
 * sign a complete request for another community. Now every statement is format 2, through core's builders:
 * `0xFF ‖ beanpool-…/2\nHOST\n…`, bound to the host the app talks to, and it carries `signedFor: HOST` so the node knows
 * which host's text to check. There is no other form: every server this app talks to reads it (utils/node-version-gate.ts).
 *
 * Each one first refuses, signing nothing, a node address whose authority isn't exactly `host[:port]`
 * (node-url.ts `assertPlainNodeAddress`): on iOS such an address reaches a different host than the one signed for.
 */

import {
    audienceOf, signAdminSignin, signSettingsSignin, buildInviteTicket, signPushLeave, signReEnroll, signStandingAuthorisation,
    signAddressCard, signRelayEnvelope,
    type AddressCard, type RelayEnvelope, type RelayEnvelopeFields, type StandingAuthorisationFields, type StandingStartBody,
} from '@beanpool/core';
import { memberSigner } from './crypto';
import { hallAudienceFor } from './hall-state';
import { assertPlainNodeAddress } from './node-url';

const CHALLENGE_ID_RE = /^[0-9a-f]{64}$/;

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

export interface SignedStatement {
    /** Base64. */
    signature: string;
    /** The host it was signed for, sent as `signedFor`. */
    signedFor: string;
}

/**
 * The Manage button's signature for challenge `challengeId` at the node at `nodeUrl`. Throws
 * {@link UnsignableChallengeError}, having signed nothing, when the node's answer can't be signed safely.
 */
export async function signAdminChallenge(
    nodeUrl: string, chal: { challengeId?: unknown; challenge?: unknown }, privateKeyHex: string,
): Promise<SignedStatement> {
    assertPlainNodeAddress(nodeUrl);
    const { challengeId } = chal;
    const host = audienceOf(nodeUrl);
    if (!host || typeof challengeId !== 'string' || !CHALLENGE_ID_RE.test(challengeId)) throw new UnsignableChallengeError();
    return { signature: await signAdminSignin(nodeUrl, challengeId, memberSigner(privateKeyHex)), signedFor: host };
}

/** Approving (or declining) the browser pairing `pairingId` shown by the node at `nodeUrl`. */
export async function signPairing(
    nodeUrl: string, action: 'approve' | 'decline', pairingId: string, shortCode: string, privateKeyHex: string,
): Promise<SignedStatement> {
    assertPlainNodeAddress(nodeUrl);
    const host = audienceOf(nodeUrl);
    if (!host) throw new Error('Cannot sign in: the node address names no host');
    return { signature: await signSettingsSignin(nodeUrl, action, pairingId, shortCode, memberSigner(privateKeyHex)), signedFor: host };
}

/**
 * An offline invite ticket from `inviter` for the community at `nodeUrl` (this phone's current community), as the
 * `BP-…` code the joiner types. Format 2: it joins only there.
 */
export async function makeOfflineTicket(
    nodeUrl: string, inviter: string, privateKeyHex: string, opts: { intendedFor?: string | null; timestamp?: number; namesEntryId?: string | null } = {},
): Promise<string> {
    assertPlainNodeAddress(nodeUrl);
    const timestamp = opts.timestamp ?? Date.now();
    const sign = memberSigner(privateKeyHex);
    return `BP-${await buildInviteTicket(nodeUrl, inviter, sign, { timestamp, intendedFor: opts.intendedFor || null, namesEntryId: opts.namesEntryId || null })}`;
}

/**
 * The leave statement for this phone's push token at the community at `nodeUrl` (push-leave.ts), signed by the leaving
 * account's key: "`publicKey` no longer wants `token` here", with the phone's stamp `leftAt`.
 */
export async function signPushLeaveStatement(
    nodeUrl: string, publicKey: string, token: string, leftAt: number, privateKeyHex: string,
): Promise<SignedStatement> {
    assertPlainNodeAddress(nodeUrl);
    const host = audienceOf(nodeUrl);
    if (!host) throw new Error('Cannot sign a leave statement: the node address names no host');
    return { signature: await signPushLeave(nodeUrl, publicKey, token, leftAt, memberSigner(privateKeyHex)), signedFor: host };
}

/**
 * A re-key ask's proof of possession (utils/rekey-redeem.ts): core's signReEnroll builds `0xFF ‖ beanpool-re-enroll/2\nHOST\nCODE`
 * from the community's address and the code as the admin's screen spells it, signed by the key the phone wants bound.
 */
export async function signReEnrollStatement(nodeUrl: string, code: string, privateKeyHex: string): Promise<SignedStatement> {
    assertPlainNodeAddress(nodeUrl);
    const host = audienceOf(nodeUrl);
    if (!host) throw new Error('Cannot sign a re-key ask: the node address names no host');
    return { signature: await signReEnroll(nodeUrl, code, memberSigner(privateKeyHex)), signedFor: host };
}

/**
 * A standing deal's authorisation (DESIGN-standing-deals-fable §6; S2), as the web signs it (apps/pwa lib/api.ts
 * signStandingStart): core's signStandingAuthorisation builds the text from the fields the take-up screen chose and signs
 * `0xFF ‖` it. The host is the one this phone's requests to `nodeUrl` are signed for (on the hall laptop, the community's own
 * name: utils/hall-state.ts), never one a node sent. Throws, having signed nothing, for an address that isn't plain.
 */
export async function signStandingStatement(nodeUrl: string, fields: StandingAuthorisationFields, privateKeyHex: string): Promise<StandingStartBody> {
    assertPlainNodeAddress(nodeUrl);
    return signStandingAuthorisation(nodeUrl, fields, memberSigner(privateKeyHex), await hallAudienceFor(nodeUrl));
}

/**
 * The member's relay envelope on an item crossing to another community (messages across communities X3; core relay-envelope.ts):
 * SHA-256 of [beanpool-relay-envelope/1, kind, sender key, sender home, recipient, recipient home, item id, time, payload hash],
 * under its own tag, so it can be taken for no other statement. Core refuses, signing nothing, fields that aren't an
 * envelope's (a home in another spelling, a key that isn't one). The recipient and their home come from a card or an envelope
 * whose signature the phone checked, the home this phone names from its own community's profile.
 */
export async function signRelayEnvelopeStatement(fields: RelayEnvelopeFields, privateKeyHex: string): Promise<RelayEnvelope> {
    return signRelayEnvelope(fields, memberSigner(privateKeyHex));
}

/**
 * The member's address card (core outside-chat.ts): SHA-256 of [beanpool-address-card/1, key, home, name], under its own tag.
 * Core refuses, signing nothing, a name or home it can't carry.
 */
export async function signAddressCardStatement(card: { key: string; home: string; name: string }, privateKeyHex: string): Promise<AddressCard> {
    return signAddressCard(card, memberSigner(privateKeyHex));
}
