/**
 * Coming back to a half-done join (utils/onboarding-state.ts `resumePlan`), now that there are two doors: an
 * invite, and the global community's sign-in (utils/global-join.ts).
 *
 * The welcome screen itself can't be rendered here (vitest.config.ts); the last tests read its source to check it
 * is wired to what is tested above them.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));

import { resumePlan, type PendingOnboarding } from '../onboarding-state';

const KEY = 'ab'.repeat(32);
const STORED = { publicKey: KEY, privateKey: '07'.repeat(32), callsign: 'Sam', createdAt: '2026-09-26T00:00:00Z' } as any;
const GLOBAL = 'https://global.beanpool.org';

const globalAtDoor: PendingOnboarding = {
    step: 'globalJoin', flow: 'global', inviteCode: '', anchorUrl: GLOBAL, callsign: 'Sam', redeemed: false, freshKey: KEY,
};

describe('resuming the global join', () => {
    it('at the door: back to the door with the SAME key, marked as this join\'s own', () => {
        const plan = resumePlan(globalAtDoor, STORED);
        expect(plan).toMatchObject({ action: 'resume', mode: 'globalJoin', flow: 'global', callsign: 'Sam', anchorUrl: GLOBAL, freshKey: true, redeemed: false });
        if (plan.action !== 'resume') throw new Error('expected resume');
        expect(plan.identity).toBe(STORED);
    });

    it('marks the key as this join\'s only when it is that exact key, so a refusal never takes another', () => {
        const otherKey = { ...STORED, publicKey: 'cd'.repeat(32) };
        expect(resumePlan(globalAtDoor, otherKey)).toMatchObject({ action: 'resume', freshKey: false });
        expect(resumePlan({ ...globalAtDoor, freshKey: undefined }, STORED)).toMatchObject({ action: 'resume', freshKey: false });
        expect(resumePlan({ ...globalAtDoor, freshKey: true as any }, STORED)).toMatchObject({ action: 'resume', freshKey: false });
    });

    it('past the door: the next step, joined, with what the sign-in left protecting the account', () => {
        const joinEnrolment = { enrolled: ['sso' as const], generation: 1, skipped: [], available: 1, enrolledSso: ['google'], threshold: 1, isSingleBlob: true, wordsSealed: true };
        const plan = resumePlan({ ...globalAtDoor, step: 'seedBackup', redeemed: true, freshKey: undefined, joinEnrolment }, STORED);
        expect(plan).toMatchObject({ action: 'resume', mode: 'seedBackup', flow: 'global', redeemed: true, freshKey: false, joinEnrolment });
        if (plan.action !== 'resume') throw new Error('expected resume');
        expect(plan.identity).toBe(STORED);
    });

    it('gives way to an invite that arrives, as any wizard does to a new invite', () => {
        expect(resumePlan(globalAtDoor, STORED, { incomingInvite: 'INV-NEW', paramsInvite: 'INV-NEW' })).toEqual({ action: 'none' });
    });

    it('drops the record when the key never made it onto the phone', () => {
        expect(resumePlan(globalAtDoor, null)).toEqual({ action: 'clear' });
    });
});

describe('resuming an invite join, as before', () => {
    const inviteAtPhoto: PendingOnboarding = { step: 'profileSetup', inviteCode: 'INV-ABC', anchorUrl: 'https://test.beanpool.org', callsign: 'Kim', redeemed: true };

    it('a record from before the global door reads as an invite join, never carrying global fields', () => {
        const plan = resumePlan({ ...inviteAtPhoto, joinEnrolment: { enrolled: [] } as any, freshKey: KEY }, STORED);
        expect(plan).toMatchObject({ action: 'resume', mode: 'profileSetup', flow: 'invite', inviteCode: 'INV-ABC', redeemed: true, freshKey: false, joinEnrolment: null });
        if (plan.action !== 'resume') throw new Error('expected resume');
        expect(plan.identity).toBe(STORED);
    });

    it('at `create` it has not committed to the key yet (Next reuses it)', () => {
        const plan = resumePlan({ ...inviteAtPhoto, step: 'create', redeemed: false }, STORED);
        expect(plan).toMatchObject({ action: 'resume', mode: 'create', flow: 'invite' });
        if (plan.action !== 'resume') throw new Error('expected resume');
        expect(plan.identity).toBeNull();
    });

    it('its own invite arriving again does not stop it; another one does', () => {
        expect(resumePlan(inviteAtPhoto, STORED, { incomingInvite: 'INV-ABC', paramsInvite: 'INV-ABC' })).toMatchObject({ action: 'resume' });
        expect(resumePlan(inviteAtPhoto, STORED, { incomingInvite: 'INV-XYZ', paramsInvite: 'INV-XYZ' })).toEqual({ action: 'none' });
    });

    it('nothing to resume', () => {
        expect(resumePlan(null, STORED)).toEqual({ action: 'none' });
    });
});

describe('the welcome screen', () => {
    const src = () => fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf-8');

    it('resumes through resumePlan, and takes a global record back to the door with its key', () => {
        const s = src();
        expect(s).toMatch(/const plan = resumePlan\(pending, await loadIdentity\(\)/);
        expect(s).toMatch(/if \(plan\.mode === 'globalJoin' && plan\.identity\) \{\s*\/\/[^\n]*\n\s*setGlobalKey\(\{ identity: plan\.identity, createdHere: plan\.freshKey \}\);/);
    });

    it('offers the two doors as two full-width, one-line buttons, and no longer says BeanPool is invite-only', () => {
        const s = src();
        expect(s).toMatch(/numberOfLines=\{1\} adjustsFontSizeToFit minimumFontScale=\{0\.6\}>🎟️ Join with an invite</);
        expect(s).toMatch(/onPress=\{openGlobalDoor\}[^>]*>\s*<Text style=\{styles\.memberBtnText\} numberOfLines=\{1\} adjustsFontSizeToFit minimumFontScale=\{0\.6\}>🌍 Explore BeanPool worldwide</);
        expect(s).not.toMatch(/BeanPool is invite-only/);
        expect(s).toMatch(/No invite\? Explore BeanPool worldwide and find a community near you\./);
    });

    it('signs in at the door and joins through utils/global-join.ts, and never opens the enrolment sheet for it', () => {
        const s = src();
        const start = s.indexOf('async function handleGlobalSignIn(');
        const end = s.indexOf('// --- Copy the OUTGOING account');
        expect(start).toBeGreaterThan(-1);
        const door = s.slice(start, end);
        expect(door).toMatch(/signInAtDoor\(provider, GLOBAL_NODE_URL, key\.identity/);
        expect(door).toMatch(/commitJoinKey\(key, name\)[\s\S]*submitJoin\(GLOBAL_NODE_URL, identity, name, signin\)/);
        expect(door).toMatch(/setEnrolment\(joinEnrolment\)/);
        expect(door).not.toMatch(/setShowSsoSheet|connectAndDeposit|enrolSsoKeeper/);
    });

    it('a refusal at the sign-in never takes a key off the phone: only the join\'s own refusal reaches releaseJoinKey', () => {
        const s = src();
        const signIn = s.slice(s.indexOf('async function handleGlobalSignIn('), s.indexOf('async function handleGlobalJoin('));
        expect(signIn).toMatch(/afterDoorAnswer\(result\.answer, key, [^\n]*, 'signIn'\);/);
        expect(signIn).not.toMatch(/releaseJoinKey/);
        const join = s.slice(s.indexOf('async function handleGlobalJoin('), s.indexOf('async function afterDoorAnswer('));
        expect(join).toMatch(/afterDoorAnswer\(answer, key, identity, 'join'\);/);
        const after = s.slice(s.indexOf('async function afterDoorAnswer('), s.indexOf('async function finishGlobalJoin('));
        expect(after.match(/releaseJoinKey\(/g)).toHaveLength(1);
        expect(after).toMatch(/const removed = via === 'join' \? await releaseJoinKey\(key\) : false;/);
        // Nowhere else on the screen takes a key off for the door.
        expect(s.match(/releaseJoinKey\(/g)).toHaveLength(1);
        expect(s).not.toMatch(/discardUnjoinedIdentity/);
    });

    it('an invite join that reuses the phone\'s key tells the door before it sends the key anywhere', () => {
        const s = src();
        const create = s.slice(s.indexOf('async function handleCreate('), s.indexOf('async function handleConfirmSeed('));
        expect(create).toMatch(/if \(storedIdentity\) await adoptJoinKey\(storedIdentity\.publicKey\);[\s\S]*await redeemInvite\(parsedCode/);
        expect(create.indexOf('adoptJoinKey(')).toBeLessThan(create.indexOf('redeemInvite(parsedCode'));
    });

    it('a shut door offers Try again wherever it is met, and the other refusals for good do not', () => {
        const after = src().slice(src().indexOf('async function afterDoorAnswer('), src().indexOf('async function finishGlobalJoin('));
        expect(after).toMatch(/setGlobalPhase\(next === 'restore' \? 'restore' : answer\.kind === 'door_closed' \? 'unavailable' : 'closed'\);/);
    });
});
