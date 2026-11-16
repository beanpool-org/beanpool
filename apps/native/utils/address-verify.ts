/**
 * The phone verifies its community's addresses and follows by itself (scratch/fable-design/DESIGN-several-addresses-
 * fable.md §3.2 to §3.5, slice S4; decided by Marty 16 Nov, all six picks). It replaces the follow card and its copy
 * carry, and the fallback card (§9 S4): a change of address writes the record's `using` and the phone's address, and
 * nothing else moves, because the community's file and saved things are kept under the record's id (S3).
 *
 * When (§3.3). The address in use is asked for a proof (core's `GET /api/node/proof`, a fresh nonce, the bytes built from
 * the address dialled) at app open and then at most hourly while it answers, once a minute while it doesn't (Home's line
 * asks every minute it is in view: components/AddressLine.tsx). The list is read only when a proof names a newer one, or
 * before the first is kept. A listed address the phone has not proved is asked once when the list names it; the main,
 * while it is not the address in use, at each round (the phone goes there only on a fresh proof), again after 5 minutes
 * and then hourly when it gives no answer; a refused address at most once a day; and, on the main, the address proved
 * longest ago once a day, so a take-over is seen. Everything listed is asked at once
 * when the address in use answers as something else, is off the list, or has not answered for the 2 Nov card's time.
 *
 * What counts (the invariant, PR #3236 round 2). The phone moves only on a FRESH proof (this round's, or one inside the
 * wait before that address is asked again, with no unanswered ask since: address-decide.ts PROOF_FRESH_MS) or by the
 * member's own act. Only what says so is "answers as something else" and starts a day's refusal: a 404 (no proof route),
 * the server's 421 (not on its list), its 503 `replaced`, or an answer that parsed and is not a good proof. A timeout, no
 * connection, a 429 (the gateway's per-address limit, shared behind one household or carrier), any other status and a
 * body that didn't parse say nothing about who answers: not answering. A member's switch while a round is out wins
 * (round 3, the invariant): every step that removes or writes (a second record's copy, its rows, its record, the record
 * write, the move, the rows following) reads the anchor again immediately before it. Once the member has moved, nothing
 * goes and the round keeps only what it learned about the addresses, moving nothing; a copy, saved row or record that
 * holds the anchor never goes; and an address another record holds is never written into this one (records never cross).
 *
 * Who the community is. A record with no key takes it from the first read: the key the phone kept from its first
 * statement at that address (address-follow.ts keepCommunityIdentity), else the list the address serves over TLS, as a
 * first contact is trusted today (§3.2). From then on every list must be that key's (core chooseAddressList), and an
 * older list or number is never taken (§7).
 *
 * What it does: utils/address-decide.ts decides; here it is written. Proved and refused addresses and the highest count go
 * into the record; a move writes `using`, then the phone's address (reconnect.ts switchPhoneTo, no carry: the file is the
 * same), then the saved rows follow to it (nodes.ts followSavedRow, last: a copy opened during the move saves the old
 * address again), and Home shows the one line once (takeAddressLine). A
 * second record of the same community, at an address this one just proved, goes with its copy and row first (Marty's
 * pick 5: the phone keeps the copy it is on; no conversion code); one that holds another key is left alone, and that
 * address is not used.
 *
 * Not here (later slices, named in the PR): the banner and the stop when the address in use answers as something else and
 * there is nowhere proved to go (§3.5: `refuse` is recorded, nothing more yet); links, codes and the directory (S5); the
 * worldwide community (followableOrigin leaves it out), an http address (no key on a home network) and the hall (its own
 * check and number) are never verified here.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    addressListUrl, addressOf, addressProofUrl, chooseAddressList, compareAddressNumbers, readAddressList, verifyAddressProof,
    type SignedAddressList,
} from '@beanpool/core';
import { decideAddress, PROOF_FRESH_MS, type AddressAnswer, type AddressLineKind } from './address-decide';
import { followableOrigin, keptIdentityAt } from './address-follow';
import { addressSpelling, communityKeyOf, communityRecordOf, recordHolds, type CommunityRecord } from './community-index';
import { changeCommunityRecords, communityRecordsReady } from './community-record';
import { whileCommunityMoves, type CommunityMoveHeld } from './community-move-lock';

const ANCHOR_STORE_KEY = 'beanpool_anchor_url';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The 2 Nov card's timings (DESIGN-dns-robustness-fable.md §3.2): 5 minutes of failed tries; a gap of an hour starts again. */
export const SILENT_DUE_MS = 5 * MINUTE;
const TRIES_GAP_MS = HOUR;
const ASK_TIMEOUT_MS = 8_000;

export interface VerifyDeps {
    /**
     * A public GET: its status and JSON, or null for no answer (no connection, a timeout). `unparsed`: an answer came, but its
     * body was not JSON (a cut connection, a proxy's page); `body` is then null.
     */
    get(url: string): Promise<{ status: number; body: unknown; unparsed?: true } | null>;
    nonce(): string;
    now(): number;
    anchor(): Promise<string | null>;
    /** The phone is in the hall (utils/hall-state.ts): its number has its own check and is never on the list. */
    inHall(): Promise<boolean>;
    /**
     * The phone's address goes from `from` to `to`, the same community and file (reconnect.ts switchPhoneTo, no carry). The
     * stores still kept by address (S3's second part) that the old move took along go too: a guest visit's mark and alerts
     * turned off (push-alerts-off.ts carryAlertsOff: no DELETE, the same server answers at both).
     */
    moveTo(from: string, to: string, held: CommunityMoveHeld): Promise<void>;
    /** The saved rows of the community `using` belongs to become one row at `using` (nodes.ts followSavedRow). */
    followRow(using: string): Promise<void>;
    /** A second record of the same community: the copy kept under its id goes (community-cache.ts removeCommunityCaches). */
    removeCopy(id: string): Promise<void>;
    /** Its saved rows `isGone` picks go, and the record of each (nodes.ts takeOffSavedList, the one way a row comes off). */
    takeOffSavedList(address: string, isGone: (url: unknown) => boolean): Promise<void>;
}

async function getJson(url: string): Promise<{ status: number; body: unknown; unparsed?: true } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
    try {
        const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
        const text = await res.text().catch(() => null);
        try {
            return { status: res.status, body: JSON.parse(text ?? '') };
        } catch {
            return { status: res.status, body: null, unparsed: true };
        }
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function defaultDeps(): Promise<VerifyDeps> {
    const [Crypto, { readHall }, { switchPhoneTo }, nodes, { removeCommunityCaches }, { carryAlertsOff }] = await Promise.all([
        import('expo-crypto'), import('./hall-state'), import('./reconnect'), import('./nodes'), import('./community-cache'), import('./push-alerts-off'),
    ]);
    return {
        get: getJson,
        nonce: () => Array.from(Crypto.getRandomBytes(16), (b) => b.toString(16).padStart(2, '0')).join(''),
        now: () => Date.now(),
        anchor: async () => AsyncStorage.getItem(ANCHOR_STORE_KEY),
        inHall: async () => !!(await readHall().catch(() => null)),
        moveTo: async (from, to, held) => {
            if (await nodes.isGuestNode(from).catch(() => false)) await nodes.markGuestNode(to);
            await switchPhoneTo(to, undefined, held);
            await carryAlertsOff(from, to);
        },
        followRow: nodes.followSavedRow,
        removeCopy: (id) => removeCommunityCaches([id]),
        takeOffSavedList: (address, isGone) => nodes.takeOffSavedList(address, isGone),
    };
}

async function depsWith(injected?: Partial<VerifyDeps>): Promise<VerifyDeps> {
    const keys: (keyof VerifyDeps)[] = ['get', 'nonce', 'now', 'anchor', 'inHall', 'moveTo', 'followRow', 'removeCopy', 'takeOffSavedList'];
    return keys.every((k) => injected?.[k]) ? (injected as VerifyDeps) : { ...(await defaultDeps()), ...injected };
}

const originOf = (address: string) => `https://${address}`;

const codeOf = (body: unknown): unknown => (body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined);

/**
 * What one answer to a proof says, as decide reads it (the file's comment, "What counts"). Only what says so answers as
 * something else: no proof route (404), not on that server's list (its 421 `not_listed`), a replaced server (its 503
 * `replaced`), or a proof that parsed and is not good (another key, address or nonce, a bad signature, not a proof): no
 * downgrade (§7). Everything else is not answering: no answer, a 429, any other status, a body that didn't parse.
 */
export function answerToProof(
    answer: { status: number; body: unknown; unparsed?: true } | null, question: { peerId: string; for: string; nonce: string },
): AddressAnswer {
    if (!answer) return { kind: 'silent' };
    if (answer.status === 404) return { kind: 'other-key', why: 'status 404' };
    if (answer.status === 421 && codeOf(answer.body) === 'not_listed') return { kind: 'other-key', why: 'status 421' };
    if (answer.status === 503 && codeOf(answer.body) === 'replaced') return { kind: 'other-key', why: 'status 503 replaced' };
    if (answer.status !== 200 || answer.unparsed) return { kind: 'silent' };
    const verdict = verifyAddressProof(answer.body, question);
    return verdict.ok ? { kind: 'proved', epoch: verdict.epoch, seq: verdict.seq } : { kind: 'other-key', why: verdict.why };
}

/** One proof asked of `address` for the community's key, as decide reads it. */
async function prove(address: string, peerId: string, deps: VerifyDeps): Promise<AddressAnswer> {
    const nonce = deps.nonce();
    const answer = await deps.get(addressProofUrl(address, nonce)).catch(() => null);
    return answerToProof(answer, { peerId, for: address, nonce });
}

/** This run's last ask of each address: when, how many in a row gave no answer, and whether it answered. */
const asked = new Map<string, { at: number; silent: number }>();
let running: Promise<void> | null = null;
/** The first round since the app started is at app open. */
let opening = true;

/** Tests only: forget this run's asks, mid-run (a cold start is this, then a round with `atOpen`). */
export function forgetAddressChecks(): void {
    asked.clear();
    running = null;
    opening = false;
}

/**
 * Verify the address in use and follow by itself (the file's comment). `atOpen`: the app's open or its return to the
 * front, when the address in use is asked whatever the last ask was and no answer at all makes the switch due at once.
 * One round at a time. Never throws.
 */
export function verifyAddressInUse(opts: { atOpen?: boolean } = {}, injected?: Partial<VerifyDeps>): Promise<void> {
    if (running) return running;
    const atOpen = !!opts.atOpen || opening;
    opening = false;
    running = round(atOpen, injected)
        .catch((e) => console.warn('[addresses] Could not verify the community\'s addresses; nothing changed', e))
        .finally(() => { running = null; });
    return running;
}

async function round(atOpen: boolean, injected?: Partial<VerifyDeps>): Promise<void> {
    const deps = await depsWith(injected);
    const anchor = await deps.anchor();
    const from = followableOrigin(anchor);
    const usingAddress = from ? addressOf(from) : null;
    if (!anchor || !from || !usingAddress || await deps.inHall()) return;
    await communityRecordsReady();
    const record = communityRecordOf(anchor);
    if (!record) return;
    const now = deps.now();
    const last = asked.get(usingAddress);
    const age = last ? now - last.at : -1;
    if (!atOpen && last && age >= 0 && age < (last.silent ? MINUTE : HOUR)) return;

    // Who the community is: the record's key, else what the phone first verified here, else the first list (over TLS).
    let kept: SignedAddressList | null = record.list ? readAddressList(record.list) : null;
    let peerId = record.peerId ?? (await keptIdentityAt(from).catch(() => null))?.peerId ?? null;
    if (!peerId) {
        const first = await deps.get(addressListUrl(usingAddress)).catch(() => null);
        const list = first?.status === 200 ? readAddressList(first.body) : null;
        // An older server (no list), or one that doesn't list where it was reached: works as today, follows nothing.
        if (!list || !list.list.addresses.includes(usingAddress)) { asked.set(usingAddress, { at: now, silent: 0 }); return; }
        peerId = list.list.peerId;
        kept = list;
    }
    if (kept && kept.list.peerId !== peerId) kept = null;
    const communityId = kept?.list.communityId ?? record.communityId ?? null;

    const answers: Record<string, AddressAnswer> = { [usingAddress]: await prove(usingAddress, peerId, deps) };
    const own = answers[usingAddress];
    // Before any list of the community is kept, only a good proof goes on: a server from before lists and proofs (404), or
    // one that knows none of its names (421 for every address), works as today and follows nothing (§3.1). Nothing is
    // written, so its address is never refused for being older. Once a list is kept, a missing proof is no downgrade (§7).
    if (!kept && own.kind !== 'proved') { asked.set(usingAddress, { at: now, silent: own.kind === 'silent' ? (last?.silent ?? 0) + 1 : 0 }); return; }
    if (own.kind === 'proved' && (!kept || compareAddressNumbers(own, kept.list) > 0)) {
        // The proof names a newer list: it must come from the same address, at least that new (§2.3).
        const offered = await deps.get(addressListUrl(usingAddress)).catch(() => null);
        // A list that didn't arrive whole (no answer, another status, a body that didn't parse) says nothing: not answering.
        const choice = offered?.status === 200 && !offered.unparsed ? chooseAddressList(offered.body, { peerId, kept, communityId }) : null;
        if (choice?.action === 'replace' && compareAddressNumbers(choice.signed.list, own) >= 0) kept = choice.signed;
        else if (choice?.action === 'refuse') answers[usingAddress] = { kind: 'other-key', why: `list ${choice.why}` };
        else if (!kept || compareAddressNumbers(kept.list, own) < 0) answers[usingAddress] = { kind: 'silent' };
    }
    const silentNow = answers[usingAddress].kind === 'silent';
    asked.set(usingAddress, { at: now, silent: silentNow ? (last?.silent ?? 0) + 1 : 0 });

    // The run of failed tries at the address in use (the 2 Nov card's timings).
    const s = record.silent;
    const goesOn = !!s && now - s.last >= 0 && now - s.last <= TRIES_GAP_MS;
    const silent = silentNow
        ? { since: goesOn ? s!.since : now, last: now, ...((goesOn && s!.due) || atOpen ? { due: true as const } : {}) }
        : undefined;
    const silentDue = !!silent && (silent.due === true || now - silent.since >= SILENT_DUE_MS);

    const listed = kept?.list.addresses ?? [];
    const main = kept?.list.main ?? null;
    const epochHeld = record.epoch ?? 0;
    const askAll = answers[usingAddress].kind === 'other-key' || silentDue || (!!kept && !listed.includes(usingAddress));
    // The once-a-day ask on the main: the address proved longest ago (off the main, the main is asked at each round).
    const daily = listed.filter((a) => a !== usingAddress).sort((a, b) => (record.proved[originOf(a)]?.at ?? 0) - (record.proved[originOf(b)]?.at ?? 0))[0];
    const others = listed.filter((a) => {
        if (a === usingAddress) return false;
        const holder = communityRecordOf(originOf(a));
        // Another community's record at that address (another key): never asked here, never used.
        if (holder && holder !== record && holder.peerId && holder.peerId !== peerId) return false;
        const p = record.proved[originOf(a)];
        const refusedAt = record.refused[originOf(a)]?.at;
        if (refusedAt !== undefined && now - refusedAt >= 0 && now - refusedAt < DAY) return false;
        const m = asked.get(a);
        const waited = !m || now - m.at < 0 || now - m.at >= (m.silent <= 1 ? PROOF_FRESH_MS : HOUR);
        if (askAll) return true;
        if (!waited) {
            // Not asked again inside the wait. When its last ask got no answer it is still not answering: an older proof of it
            // is no reason to go there (PR #3236 review: the phone went back to a main that had just failed to answer).
            if (m && m.silent > 0) answers[a] = { kind: 'silent' };
            return false;
        }
        // The main, whenever it is not the address in use: the phone goes there only on a fresh proof.
        return !p || a === main || (a === daily && now - p.at >= DAY);
    });
    await Promise.all(others.map(async (a) => {
        answers[a] = await prove(a, peerId!, deps);
        asked.set(a, { at: now, silent: answers[a].kind === 'silent' ? (asked.get(a)?.silent ?? 0) + 1 : 0 });
    }));

    const proved: Record<string, { at: number; epoch?: number }> = {};
    for (const [origin, p] of Object.entries(record.proved)) {
        const a = addressOf(origin);
        if (a) proved[a] = p;
    }
    const decision = decideAddress({
        using: usingAddress, main, listed, mainSeen: record.mainSeen ? addressOf(record.mainSeen) : null, epoch: epochHeld,
        proved, answers, silentDue, now,
    });

    // From here each step removes or writes, and they run under the one move lock (community-move-lock.ts), which the
    // member's own switch holds from before it closes the copy until the new address is written: a switch started but not
    // yet written finishes first, and this round then reads where it landed (the S4 leftover race, closed in S5). The lock
    // is held for these local steps only, never for a network ask.
    await whileCommunityMoves(async (held) => {
        // Each step still reads the anchor again immediately before it (PR #3236 round 3: the
        // file's comment, "What counts"). The member's own switch wins over this round.
        const memberMoved = async () => (await deps.anchor()) !== anchor || await deps.inHall();
        // The copy, rows and record that hold the anchor (as the anchor read just before shows it) are never a duplicate's.
        const holdsAnchor = (r: CommunityRecord) => recordHolds(r, anchor) || addressSpelling(communityKeyOf(anchor)) === addressSpelling(r.id);

        // A second record of the same community at an address just proved goes first, so that address keys to this record: its
        // copy, then its saved rows with the record (Marty's pick 5: the phone keeps the copy it is on). The record in use is
        // known by its id: any record write rebuilds the index, so the object read at the round's start is not the one read now
        // (round 3's self-check: a community joined while the proofs were out made the record in use its own duplicate).
        for (const a of decision.proved) {
            const holder = communityRecordOf(originOf(a));
            if (!holder || holder.id === record.id || (holder.peerId && holder.peerId !== peerId)) continue;
            if (await memberMoved()) break;
            if (holdsAnchor(holder)) continue;
            console.warn(`[addresses] ${originOf(a)} is ${from}'s community too: this phone keeps the copy it is on, and the other one goes`);
            await deps.removeCopy(holder.id);
            if (await memberMoved()) break;
            // Never a row of the record that holds the anchor. Each row's record goes after its row (nodes.ts takeOffSavedList),
            // and that step reads the anchor itself, inside its write, and keeps the record that holds it (community-record.ts
            // forgetCommunityRecord).
            const anchored = communityRecordOf(anchor);
            await deps.takeOffSavedList(holder.id, (url) => typeof url === 'string' && recordHolds(holder, url)
                && addressSpelling(url) !== addressSpelling(anchor) && !(anchored && recordHolds(anchored, url)));
        }

        // The record write reads the anchor inside the write itself. When the member moved, what was learned about the addresses
        // is kept, and nothing about the community in use is written. An address another record holds is that record's: its
        // proof is not written here, and the phone never goes there (records never cross).
        const written: { stays: boolean; to: string | null } = { stays: true, to: null };
        await changeCommunityRecords(async (records) => {
            const r = records.find((x) => x.id === record.id);
            if (!r) return null;
            const stays = await memberMoved();
            const elsewhere = (address: string) => records.some((x) => x.id !== r.id && recordHolds(x, originOf(address)));
            const to = decision.to && !stays && !elsewhere(decision.to) ? originOf(decision.to) : null;
            const standsOnMain = !stays && main !== null && (to ? decision.to : usingAddress) === main && !decision.drop.includes(main);
            written.stays = stays;
            written.to = to;
            const nextProved = { ...r.proved };
            const nextRefused = { ...r.refused };
            for (const a of decision.proved) {
                if (elsewhere(a)) continue;
                nextProved[originOf(a)] = { at: now, epoch: decision.epoch };
                delete nextRefused[originOf(a)];
            }
            for (const a of decision.drop) {
                delete nextProved[originOf(a)];
                const answer = answers[a];
                nextRefused[originOf(a)] = { at: now, why: answer?.kind === 'other-key' ? answer.why : 'older' };
            }
            const learned: CommunityRecord = {
                ...r, peerId: peerId!, ...(communityId ? { communityId } : {}), epoch: decision.epoch, proved: nextProved, refused: nextRefused,
                ...(kept ? { list: kept } : {}),
            };
            if (stays) return records.map((x) => (x === r ? learned : x));
            const line = to && decision.line ? { kind: decision.line, from: r.using, to, at: now } : r.line;
            const next: CommunityRecord = {
                ...learned, using: to ?? r.using, ...(standsOnMain ? { mainSeen: originOf(main!) } : {}),
                ...(silent && !to ? { silent } : { silent: undefined }), ...(line ? { line } : {}),
            };
            return records.map((x) => (x === r ? next : x));
        });
        const { stays, to } = written;
        if (stays) return;
        if (to && await memberMoved()) {
            // The member switched while the record was written: put back where the record was going, and the line, and stay.
            await changeCommunityRecords((records) => records.map((x) => (x.id === record.id && x.using === to
                ? { ...x, using: record.using, line: x.line?.at === now ? record.line : x.line } : x)));
            return;
        }
        const at = to ?? anchor;
        try {
            if (to) {
                asked.set(decision.to!, { at: now, silent: 0 });
                console.log(`[addresses] ${from} → ${to} (${decision.action}${decision.line ? `, ${decision.line}` : ''})`);
                await deps.moveTo(anchor, to, held);
            }
        } finally {
            // The rows last: switchPhoneTo closes the copy before it writes the new address, and a copy opened in between saves
            // the address it read, the old one, again (db.ts openAndMakeCopy; measured on the emulator, 16 Nov). Only while the
            // phone is where the round left it: after the member's own switch (or a move that never set the address) the rows
            // stay as they are, so the row at the anchor never goes.
            const followed = await (async () => (await deps.anchor()) === at && !(await deps.inHall()))().catch(() => false);
            if (followed) await deps.followRow(at).catch((e) => console.warn('[addresses] The saved row could not follow', e));
        }
    });
}

/** The line Home shows once, for the community in use: taken off its record as it is read. Null for none. */
export async function takeAddressLine(anchor: string | null): Promise<{ kind: AddressLineKind; from: string; to: string } | null> {
    if (!anchor) return null;
    await communityRecordsReady();
    const record = communityRecordOf(anchor);
    const line = record?.line;
    if (!record || !line) return null;
    try {
        await changeCommunityRecords((records) => records.map((r) => (r.id === record.id ? { ...r, line: undefined } : r)));
    } catch {
        return null;
    }
    // Home shows only the community in use, at the address in use: a line about a move to another address is taken, unshown.
    if (addressSpelling(line.to) !== addressSpelling(anchor)) return null;
    return { kind: line.kind, from: line.from, to: line.to };
}
