/**
 * The web line checks the proof (several addresses, slice S6; design scratch/fable-design/DESIGN-several-addresses-fable.md
 * §4, §7). At an address that is not the community's main one, the web app says where the main one is (lib/former-address.ts,
 * components/FormerAddressBanner.tsx). It says so only when the main address has proved, from this browser, that it is this
 * community: the same key, at a list number not older than the one this address signs.
 *
 *   1. This address's signed list (`GET /api/node/addresses`, core's checkAddressList): its key and number, and its main.
 *      The page came from this address over TLS, so its key is the one the page trusts (design §3.2, "first contact").
 *   2. The main address's own signed list, by the same key and community, at a number not older than this one's, naming
 *      itself main. A copy of the list from anywhere else proves nothing on its own (design §7, "a copied statement").
 *   3. A fresh proof from the main address: this browser's own nonce, signed by that key for that address (core's
 *      verifyAddressProof builds the bytes from the question asked, never from the answer), naming the number of the list
 *      the main address just served. An address that cannot produce the list its own proof names counts as not answering.
 *
 * Anything else is no line: a list here that is forged or missing (a replaced server signs none), a main that answers with
 * another key, a main at an older take-over count, a proof for another address or another question. The web never moves
 * anyone (a browser keeps a page's key at one address): the line is a plain link, and nothing of this address goes with it.
 * Both reads are public and readable from any origin for GET (apps/server routes/address-list.ts), so no credentials go.
 */

import {
    ADDRESS_LIST_PATH, addressListUrl, addressOf, addressProofUrl, checkAddressList, compareAddressNumbers, newAddressProofNonce,
    verifyAddressProof,
} from '@beanpool/core';

/** One public GET: the status and the parsed body, or null when nothing came back (offline, refused, not JSON). */
export type PublicRead = (url: string) => Promise<{ status: number; json: unknown } | null>;

/** Why the main address was not shown, or where it is. */
export type MainAddressVerdict =
    | { ok: true; main: string; here: string; onList: boolean }
    | {
        ok: false;
        why:
            | 'no-list-here' | 'forged-here' | 'at-main'
            | 'no-list-at-main' | 'forged-at-main' | 'other-key' | 'other-community' | 'older' | 'main-moved'
            | 'no-proof' | 'proof-refused' | 'proof-number';
    };

/** A plain GET with no credentials, never cached: what the two public reads need. */
export const publicRead: PublicRead = async (url) => {
    try {
        const res = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } });
        let json: unknown = null;
        try { json = await res.json(); } catch { /* not JSON */ }
        return { status: res.status, json };
    } catch {
        return null;
    }
};

/**
 * Whether the main address has proved itself this community, seen from `here` (this page's address, any spelling), with
 * this address's list read at `hereListUrl` (this server's, relative to the page). `read` does the GETs (a test passes
 * its own). Never throws.
 */
export async function provedMainAddress(here: string, hereListUrl: string = ADDRESS_LIST_PATH, read: PublicRead = publicRead): Promise<MainAddressVerdict> {
    try {
        const at = addressOf(here);
        const hereRead = await read(hereListUrl);
        if (!hereRead || hereRead.status !== 200) return { ok: false, why: 'no-list-here' };
        const hereCheck = checkAddressList(hereRead.json);
        if (!hereCheck.ok) return { ok: false, why: 'forged-here' };
        const held = hereCheck.signed.list;
        const main = held.main;
        if (at && at === main) return { ok: false, why: 'at-main' };

        const mainRead = await read(addressListUrl(main));
        if (!mainRead || mainRead.status !== 200) return { ok: false, why: 'no-list-at-main' };
        const mainCheck = checkAddressList(mainRead.json);
        if (!mainCheck.ok) return { ok: false, why: 'forged-at-main' };
        const theirs = mainCheck.signed.list;
        if (theirs.peerId !== held.peerId) return { ok: false, why: 'other-key' };
        if (theirs.communityId !== held.communityId) return { ok: false, why: 'other-community' };
        if (compareAddressNumbers(theirs, held) < 0) return { ok: false, why: 'older' };
        if (theirs.main !== main) return { ok: false, why: 'main-moved' };

        const nonce = newAddressProofNonce();
        const proofRead = await read(addressProofUrl(main, nonce));
        if (!proofRead || proofRead.status !== 200) return { ok: false, why: 'no-proof' };
        const verdict = verifyAddressProof(proofRead.json, { peerId: held.peerId, for: main, nonce });
        if (!verdict.ok) return { ok: false, why: 'proof-refused' };
        if (compareAddressNumbers(verdict, theirs) !== 0) return { ok: false, why: 'proof-number' };
        return { ok: true, main, here: at ?? here, onList: !!at && held.addresses.includes(at) };
    } catch {
        return { ok: false, why: 'no-proof' };
    }
}

/** This server's list, as the page reaches it: the detached node's (`bp_node_url`) when one is set, else this page's own. */
export function hereListUrl(nodeApiUrl: string): string {
    return `${nodeApiUrl.replace(/\/+$/, '')}${ADDRESS_LIST_PATH}`;
}
