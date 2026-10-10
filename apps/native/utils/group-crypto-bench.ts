/**
 * How long the group-chat locks take on this device (group-chat design, scratch/global-node/DESIGN-group-chat-encryption-fable.md
 * §1.7, §15, §17 slice 0; Marty's pick 9: add react-native-quick-crypto on native only if a 200-member rotation takes over
 * about 5 s on an old phone). Development only: the one screen that runs it (app/group-crypto-probe.tsx) loads it inside a
 * __DEV__ branch, so a production bundle never holds it.
 *
 * It calls @beanpool/core's group-crypto exactly as the apps will (makeGroupEpochRecord, openMyGroupKey, sealGroupLine,
 * openGroupLine) on throwaway keys it makes itself: nothing is sent anywhere and nothing is kept. Pure TypeScript with no
 * React Native import, so the same file also runs under Node for the laptop baseline the design's §1.7 numbers came from.
 *
 * Each step reports its first run (cold: on Hermes the first call also compiles the code it reaches) and the median of the
 * runs after it (warm).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import {
    makeGroupEpochRecord, openGroupLine, openMyGroupKey, sealGroupLine, type GroupEpochRecord, type GroupLinePayload, type GroupServedWrap,
} from '@beanpool/core';

export interface GroupCryptoBenchStep {
    name: string;
    runs: number;
    firstMs: number;
    medianMs: number;
    minMs: number;
    maxMs: number;
}

export interface GroupCryptoBenchOptions {
    /** Called after each step, so a screen can show it and yield to the UI between steps. */
    onStep?: (step: GroupCryptoBenchStep) => void | Promise<void>;
    /** Warm runs after the first; default 5 (the 200-member rotation does fewer: max(2, warm / 2)). */
    warm?: number;
}

const GROUP_ID = 'bench-group-0000';

function now(): number {
    const p = (globalThis as { performance?: { now(): number } }).performance;
    return p && typeof p.now === 'function' ? p.now() : Date.now();
}

function uuidV4(): string {
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = bytesToHex(b);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function member(): { privHex: string; pubHex: string } {
    const seed = randomBytes(32);
    return { privHex: bytesToHex(seed), pubHex: bytesToHex(ed25519.getPublicKey(seed)) };
}

function round(ms: number): number {
    return Math.round(ms * 100) / 100;
}

async function step(name: string, warm: number, fn: () => void, opts: GroupCryptoBenchOptions): Promise<GroupCryptoBenchStep> {
    const times: number[] = [];
    for (let i = 0; i <= warm; i++) {
        const t0 = now();
        fn();
        times.push(now() - t0);
    }
    const rest = times.slice(1).sort((a, b) => a - b);
    const result: GroupCryptoBenchStep = {
        name,
        runs: times.length,
        firstMs: round(times[0]),
        medianMs: round(rest.length ? rest[Math.floor(rest.length / 2)] : times[0]),
        minMs: round(Math.min(...times)),
        maxMs: round(Math.max(...times)),
    };
    await opts.onStep?.(result);
    return result;
}

/** A served wrap for one recipient of a full record, as GET …/keys hands it to that member (record without its wraps). */
function servedFor(record: GroupEpochRecord, pubHex: string): { served: GroupEpochRecord; wrap: GroupServedWrap } {
    const w = record.wraps?.find((x) => x.recipient === pubHex);
    if (!w) throw new Error('bench: no wrap for that member');
    const served: GroupEpochRecord = { ...record };
    delete served.wraps;
    return { served, wrap: { epoch: record.epoch, wrapper: record.createdBy, ephPub: w.ephPub, nonce: w.nonce, wrapped: w.wrapped, sig: null } };
}

/** A photo as the apps send one: an 800 px JPEG's data URI, about 100 KB of text. */
function photoDataUri(textBytes: number): string {
    const raw = new Uint8Array(Math.floor(((textBytes - 23) * 3) / 4));
    for (let i = 0; i < raw.length; i += 32 * 1024) raw.set(randomBytes(Math.min(32 * 1024, raw.length - i)), i);
    let bin = '';
    for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
    return `data:image/jpeg;base64,${globalThis.btoa(bin)}`;
}

export async function runGroupCryptoBench(opts: GroupCryptoBenchOptions = {}): Promise<GroupCryptoBenchStep[]> {
    const warm = opts.warm ?? 5;
    const out: GroupCryptoBenchStep[] = [];
    let members: { privHex: string; pubHex: string }[] = [];
    out.push(await step('make 200 member keys (setup, Ed25519 public keys)', 0, () => {
        members = Array.from({ length: 200 }, member);
    }, opts));
    const me = members[0];
    const pubs200 = members.map((m) => m.pubHex);
    const pubs20 = pubs200.slice(0, 20);
    const createdAt = new Date().toISOString();

    let record20: GroupEpochRecord | null = null;
    out.push(await step('rotation, 20 members (make epoch record: 20 wraps + sign)', warm, () => {
        record20 = makeGroupEpochRecord({ myEdPrivHex: me.privHex, groupId: GROUP_ID, epoch: 1, reason: 'start', createdAt, recipients: pubs20 }).record;
    }, opts));
    let record200: GroupEpochRecord | null = null;
    out.push(await step('rotation, 200 members (make epoch record: 200 wraps + sign)', Math.max(2, Math.floor(warm / 2)), () => {
        record200 = makeGroupEpochRecord({ myEdPrivHex: me.privHex, groupId: GROUP_ID, epoch: 1, reason: 'start', createdAt, recipients: pubs200 }).record;
    }, opts));
    if (!record20 || !record200) throw new Error('bench: no record');

    // A member other than the maker opens their own wrap, as served (verify the record header, open, check the commitment).
    const reader = members[7];
    const { served, wrap } = servedFor(record200, reader.pubHex);
    let groupKey: Uint8Array = new Uint8Array(32);
    out.push(await step('open my wrap for one epoch (verify record + open + commit check)', warm, () => {
        groupKey = openMyGroupKey(served, wrap, reader.privHex, { groupId: GROUP_ID, epoch: 1, activeMembers: pubs200 });
    }, opts));

    const line1k = 'Bring a plate to the working bee on Saturday. '.repeat(23).slice(0, 1024);
    for (const [label, text, part, reps] of [
        ['1 KB line', line1k, 'body', warm * 4],
        ['100 KB photo', photoDataUri(100 * 1024), 'attachment', warm],
    ] as const) {
        const messageId = uuidV4();
        const ref = { groupId: GROUP_ID, epoch: 1, senderPubHex: reader.pubHex, messageId, part };
        let payload: GroupLinePayload | null = null;
        out.push(await step(`seal ${label} (message key + sign + encrypt)`, reps, () => {
            payload = sealGroupLine(text, { myEdPrivHex: reader.privHex, groupKey, groupId: GROUP_ID, epoch: 1, messageId, part });
        }, opts));
        out.push(await step(`open + verify ${label}`, reps, () => {
            if (!payload || openGroupLine(payload, ref, groupKey).text !== text) throw new Error('bench: line did not round-trip');
        }, opts));
    }
    return out;
}
