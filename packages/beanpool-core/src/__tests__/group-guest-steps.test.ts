import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
    groupEpochCoversExactly, groupKeyCommit, makeGroupEpochRecord, verifyGroupEpochRecord, type GroupEpochRecord,
} from '../group-crypto.js';
import { guestEpochStep, makeGuestEpoch, openGuestEpochKey, readGuestRoster, type GuestRoster } from '../group-guest-steps.js';
import * as core from '../index.js';

// G1b: a guest's phone takes one step from the host's roster (#3197 "What G1b must do with the roster", steps 3 and 4).
// One table over the epoch the roster carries (null / stale / not stale) and who the guest is -> what is sent, each step
// made and checked as the host checks it.

function person(name: string) {
    const seed = sha256(utf8ToBytes(`group-guest-steps.test ${name}`));
    return { seedHex: bytesToHex(seed), pk: bytesToHex(ed25519.getPublicKey(seed)), name };
}
const ana = person('Ana'), ben = person('Ben'), gus = person('Gus'), cara = person('Cara'), stray = person('Stray');
const GROUP = 'grp-seed-library';

/** The host's current epoch 3 over Ana, Ben, Gus and Cara, made by Ana, as the host sends it: no group id, own wraps only. */
const made = makeGroupEpochRecord({
    myEdPrivHex: ana.seedHex, groupId: GROUP, epoch: 3, reason: 'rotate', subject: null, createdAt: '2026-11-16T09:00:00.000Z',
    recipients: [ana.pk, ben.pk, gus.pk, cara.pk],
});
const { groupId: _g, wraps: allWraps, ...hostRecord } = made.record;
const wrapOf = (who: string) => ({ ...allWraps!.find((w) => w.recipient === who)!, wrapper: ana.pk });

function roster(epoch: GuestRoster['epoch'], guests = [gus, cara]): GuestRoster {
    return {
        name: 'Seed Library',
        members: [ana, ben].map((p) => ({ key: p.pk, name: p.name })),
        guests: guests.map((p) => ({ key: p.pk, home: 'a.example', name: p.name })),
        epoch,
    };
}
const notStale = (wraps: string[]) => ({ current: 3, stale: false as const, record: hostRecord as GroupEpochRecord, wraps: wraps.map(wrapOf) });

type Case = { name: string; r: GuestRoster; me: typeof gus; joining?: boolean; want: string; epoch?: number; reason?: string };
const CASES: Case[] = [
    { name: 'null epoch, after the yes', r: roster(null), me: gus, joining: true, want: 'group-epoch', epoch: 1, reason: 'join' },
    { name: 'null epoch, not joining (still the group\'s first: join)', r: roster(null), me: gus, want: 'group-epoch', epoch: 1, reason: 'join' },
    { name: 'stale, after the yes', r: roster({ current: 3, stale: true }), me: gus, joining: true, want: 'group-epoch', epoch: 4, reason: 'join' },
    { name: 'stale, a guest already in', r: roster({ current: 3, stale: true }), me: gus, want: 'group-epoch', epoch: 4, reason: 'rotate' },
    { name: 'not stale, my wrap in it', r: roster(notStale([gus.pk])), me: gus, want: 'group-line', epoch: 3 },
    { name: 'not stale, joining (the key is opened, no epoch made)', r: roster(notStale([gus.pk])), me: gus, joining: true, want: 'group-line', epoch: 3 },
    { name: 'not stale, no wrap for me', r: roster(notStale([cara.pk])), me: gus, want: 'nothing:no-wrap' },
    { name: 'not in the roster (left or removed), stale', r: roster({ current: 3, stale: true }, [cara]), me: gus, want: 'nothing:not-in-roster' },
    { name: 'not in the roster, not stale', r: roster(notStale([cara.pk]), [cara]), me: gus, want: 'nothing:not-in-roster' },
    { name: 'a stranger the roster never named', r: roster(null), me: stray, want: 'nothing:not-in-roster' },
];

describe('guestEpochStep: (null / stale / not stale) x the guest -> what is sent', () => {
    it.each(CASES)('$name', (c) => {
        const read = readGuestRoster(JSON.parse(JSON.stringify(c.r)));
        expect(read).not.toBeNull();
        const step = guestEpochStep(read!, c.me.pk, { joining: c.joining });
        const got = step.send === 'nothing' ? `nothing:${step.why}` : step.send;
        expect(got).toBe(c.want);
        if (step.send === 'group-epoch') {
            expect(step.epoch).toBe(c.epoch);
            expect(step.reason).toBe(c.reason);
            // Exactly the members' and guests' keys, no one else.
            expect(step.recipients).toEqual([...c.r.members.map((m) => m.key), ...c.r.guests.map((g) => g.key)].sort());
            const { payload, groupKey } = makeGuestEpoch(step, GROUP, c.me.pk, c.me.seedHex, '2026-11-16T10:00:00.000Z');
            const record = JSON.parse(payload).epoch as GroupEpochRecord;
            // The host's own checks: its maker is in the roster, the next epoch, wrapped to exactly the roster.
            expect(() => verifyGroupEpochRecord(record, { groupId: GROUP, epoch: step.epoch, activeMembers: step.recipients })).not.toThrow();
            expect(groupEpochCoversExactly(record, step.recipients)).toBe(true);
            expect(record.subject).toBe(step.reason === 'join' ? c.me.pk : null);
            expect(record.keyCommit).toBe(groupKeyCommit(groupKey));
        }
        if (step.send === 'group-line') {
            expect(step.epoch).toBe(c.epoch);
            const key = openGuestEpochKey(step, GROUP, c.me.seedHex);
            expect(bytesToHex(key)).toBe(bytesToHex(made.groupKey));
        }
    });

    it('the table has a row for each epoch state and each way a guest can stand', () => {
        const states = new Set(CASES.map((c) => (c.r.epoch === null ? 'null' : c.r.epoch.stale ? 'stale' : 'not-stale')));
        expect([...states].sort()).toEqual(['not-stale', 'null', 'stale']);
        expect(new Set(CASES.map((c) => c.want))).toEqual(new Set(['group-epoch', 'group-line', 'nothing:no-wrap', 'nothing:not-in-roster']));
    });

    it('a record made for another group does not open as this one\'s', () => {
        const step = guestEpochStep(roster(notStale([gus.pk])), gus.pk);
        if (step.send !== 'group-line') throw new Error('expected a line step');
        expect(() => openGuestEpochKey(step, 'grp-another', gus.seedHex)).toThrow();
    });

    it('reads no roster that is not one', () => {
        for (const bad of [null, 'x', {}, { ...roster(null), members: [{ key: 'nope', name: 'x' }] }, { ...roster(null), epoch: { current: 0, stale: true } },
            { ...roster(null), epoch: { current: 3, stale: false, record: { ...hostRecord, epoch: 2 }, wraps: [] } },
            { ...roster(null), epoch: { current: 3, stale: false, record: hostRecord } }]) {
            expect(readGuestRoster(bad)).toBeNull();
        }
    });

    it('is in the package index for both apps', () => {
        expect(typeof core.guestEpochStep).toBe('function');
        expect(typeof core.readGuestRoster).toBe('function');
        expect(typeof core.makeGuestEpoch).toBe('function');
        expect(typeof core.openGuestEpochKey).toBe('function');
    });
});
