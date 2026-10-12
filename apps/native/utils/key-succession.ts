/**
 * key-succession — this phone's key confirms that a re-key's old key was this member's (group chats,
 * scratch/global-node/DESIGN-group-chat-line-display-fable.md §5, §6; Marty's picks of 11 Oct 2026).
 *
 * After a re-key the member's old group lines are signed by a key no roster lists any more. The node's link from the old
 * key to the new one is only the node's word, so the NEW key signs, once, that the old key was its own (core
 * makeKeySuccession), the node stores it (POST /api/community/me/key-succession) and serves it with the roster
 * (`formerKeys`), and every member's phone names those old lines by the verified chain (group-line-display.ts).
 *
 * Two moments sign it:
 *   - the new phone, right after its own re-key completes (app/rekey-code.tsx): the member just did it, so no question;
 *   - a later sign-in, when GET /api/community/me lists a re-key to this key with `attested: false` (an admin-path re-key,
 *     or one an older app completed): only after §6's prompt, and "Not me" signs nothing.
 *
 * The date signed is the node's date for the re-key (`rekeyedFrom[].at`), shown in the prompt; the old key is the one
 * the node names. That is the honest limit (§8): a dishonest node could show a member the wrong old key at that moment;
 * the member sees a date, and nothing changes after.
 */
import type { BeanPoolIdentity } from './identity';
import { signedGet, signedPost } from './node-post';
import { makeKeySuccession } from './group-chat-crypto';

/** §6: the prompt at a later sign-in, its buttons, and what "Not me" opens. */
export function keySuccessionPromptText(at: string): string {
    return `This account was re-keyed on ${shortDate(at)}. Confirm it was you, and the messages you sent before then will show under your name again.`;
}
export const KEY_SUCCESSION_PROMPT_YES = 'Yes, that was me';
export const KEY_SUCCESSION_PROMPT_NO = 'Not me';

/** A re-key that replaced some old key with this one, as GET /api/community/me lists it. */
export interface RekeyedFrom {
    pubkey: string;
    at: string;
    attested: boolean;
}

const PUBKEY_HEX = /^[0-9a-f]{64}$/;

/** "3 Oct 2026", the way the details sheet writes dates (group-line-display.ts earlierKeyDetails). */
function shortDate(at: string): string {
    const d = new Date(at);
    if (!Number.isFinite(d.getTime())) return at;
    return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The re-keys to this key the node lists (GET /api/community/me `rekeyedFrom`); [] when it lists none or won't say. */
export async function rekeysToMe(nodeUrl: string, identity: BeanPoolIdentity): Promise<RekeyedFrom[]> {
    try {
        const res = await signedGet(nodeUrl, '/api/community/me', identity);
        if (!res.ok) return [];
        const body = await res.json();
        const rows = Array.isArray(body?.rekeyedFrom) ? body.rekeyedFrom : [];
        return rows.filter((r: any) => r && typeof r.pubkey === 'string' && PUBKEY_HEX.test(r.pubkey) && r.pubkey !== identity.publicKey
            && typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)))
            .map((r: any) => ({ pubkey: r.pubkey, at: r.at, attested: r.attested === true }));
    } catch {
        return [];
    }
}

/** The re-keys to this key nobody has confirmed yet: what §6's prompt asks about at sign-in. */
export async function unattestedRekeys(nodeUrl: string, identity: BeanPoolIdentity): Promise<RekeyedFrom[]> {
    return (await rekeysToMe(nodeUrl, identity)).filter((r) => !r.attested);
}

/**
 * Signs and sends one statement: this key replaced `oldPubkey` at `at`. 'stored' (201), 'already' (409: set before,
 * never changed), or 'refused' (anything else: not this key's re-key, or the node from before §5).
 */
export async function postKeySuccession(nodeUrl: string, identity: BeanPoolIdentity, oldPubkey: string, at: string): Promise<'stored' | 'already' | 'refused'> {
    try {
        const s = makeKeySuccession({ newEdPrivHex: identity.privateKey, oldPubHex: oldPubkey, at });
        const res = await signedPost(nodeUrl, '/api/community/me/key-succession', { oldPubkey: s.pubkey, at: s.at, sig: s.sig }, identity);
        return res.status === 201 ? 'stored' : res.status === 409 ? 'already' : 'refused';
    } catch {
        return 'refused';
    }
}

/**
 * Confirms every re-key to this key the node lists as unconfirmed (or only `only`, when given): right after this phone's
 * own re-key, and after the member says "Yes, that was me". Returns how many were stored.
 */
export async function attestOwnRekeys(nodeUrl: string, identity: BeanPoolIdentity, only?: readonly RekeyedFrom[]): Promise<number> {
    const rows = only ?? await unattestedRekeys(nodeUrl, identity);
    let stored = 0;
    for (const r of rows) {
        if (r.attested) continue;
        if ((await postKeySuccession(nodeUrl, identity, r.pubkey, r.at)) === 'stored') stored++;
    }
    return stored;
}
