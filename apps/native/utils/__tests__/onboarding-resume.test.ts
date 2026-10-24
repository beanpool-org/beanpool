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

import { claimInFlight, keyMadeForThisJoin, resumePlan, type PendingOnboarding } from '../onboarding-state';

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

describe('resuming a claim that made the account (DESIGN-account-without-global §2.2)', () => {
    const ORIGIN = 'https://beans.example.org';
    const claimOut: PendingOnboarding = {
        step: 'claim', flow: 'claim', inviteCode: '', anchorUrl: ORIGIN, callsign: 'Ada', redeemed: false,
        freshKey: KEY, joinsOut: 1, claimCodeId: '0a1b2c3d',
    };

    it('its answer not in: back to the claim screen, at its address and code id, with the same key, marked as the claim\'s own', () => {
        const plan = resumePlan(claimOut, STORED);
        expect(plan).toMatchObject({
            action: 'resume', mode: 'claim', flow: 'claim', anchorUrl: ORIGIN, callsign: 'Ada', redeemed: false,
            freshKey: true, newKey: true, claimCodeId: '0a1b2c3d', joinDoor: null,
        });
        if (plan.action !== 'resume') throw new Error('expected resume');
        expect(plan.identity).toBe(STORED);
        // The guard holds the claim screen for it (auth-return.ts claimOut).
        expect(claimInFlight(claimOut)).toBe(true);
    });

    it('the claim in: the wizard\'s steps, words member, its key new, the community\'s name for the owner\'s card', () => {
        for (const step of ['profileSetup', 'seedBackup', 'onboardingGuide', 'ownerCard'] as const) {
            const record: PendingOnboarding = {
                step, flow: 'claim', inviteCode: '', anchorUrl: ORIGIN, callsign: 'Ada', redeemed: true,
                newKey: KEY, joinDoor: 'words', communityName: 'Bean\u202eTown',
            };
            const plan = resumePlan(record, STORED);
            expect(plan, step).toMatchObject({ action: 'resume', mode: step, flow: 'claim', newKey: true, joinDoor: 'words', claimCodeId: null });
            // Cleaned again as it is read: the record comes back from storage like any input.
            if (plan.action === 'resume') expect(plan.communityName).toBe('BeanTown');
            expect(claimInFlight(record)).toBe(false);
        }
    });

    it('the claim\'s own key is a key this join made (no lock before its words); another key is not', () => {
        expect(keyMadeForThisJoin(claimOut, KEY)).toBe(true);
        expect(keyMadeForThisJoin(claimOut, 'cd'.repeat(32))).toBe(false);
    });

    it('a record at an address the app would not claim at, or a step that is not a claim\'s, is dropped', () => {
        expect(resumePlan({ ...claimOut, anchorUrl: 'http://8.8.8.8' }, STORED)).toEqual({ action: 'clear' });
        expect(resumePlan({ ...claimOut, anchorUrl: 'javascript:alert(1)' }, STORED)).toEqual({ action: 'clear' });
        expect(resumePlan({ ...claimOut, step: 'create' }, STORED)).toEqual({ action: 'clear' });
        expect(resumePlan({ ...claimOut, step: 'globalJoin' }, STORED)).toEqual({ action: 'clear' });
        // A claim's steps belong to no other flow.
        expect(resumePlan({ ...globalAtDoor, step: 'claim' }, STORED)).toEqual({ action: 'clear' });
        expect(resumePlan({ ...globalAtDoor, step: 'ownerCard' }, STORED)).toEqual({ action: 'clear' });
        // A bad code id is left out, never sent on.
        const plan = resumePlan({ ...claimOut, claimCodeId: '../../x' }, STORED);
        expect(plan).toMatchObject({ action: 'resume', mode: 'claim', claimCodeId: null });
    });

    it('gives way to an invite that arrives, and drops a record with no key behind it', () => {
        expect(resumePlan(claimOut, STORED, { incomingInvite: 'INV-NEW', paramsInvite: 'INV-NEW' })).toEqual({ action: 'none' });
        expect(resumePlan(claimOut, null)).toEqual({ action: 'clear' });
    });

    it('at its own step, a record that no longer marks the stored key as the claim\'s is dropped, never handed back (#2433 review)', () => {
        // Another join took the key over (door-key.ts adoptJoinKey takes `freshKey` and `joinsOut` away)…
        const { freshKey: _fresh, joinsOut: _out, ...adopted } = claimOut;
        expect(resumePlan(adopted, STORED)).toEqual({ action: 'clear' });
        // …or the phone holds another key than the one the claim made, or the mark is no key at all.
        expect(resumePlan(claimOut, { ...STORED, publicKey: 'cd'.repeat(32) })).toEqual({ action: 'clear' });
        expect(resumePlan({ ...claimOut, freshKey: true as any }, STORED)).toEqual({ action: 'clear' });
        // The guard leaves the claim screen alone for it until welcome drops it: a claim at another address by the same
        // key may be out on that screen (node-claim.test, "a held claim's key, claiming another address").
        expect(claimInFlight(adopted)).toBe(true);
        // Past the claim's own step the record is the wizard's, mark or none, as before.
        expect(resumePlan({ ...adopted, step: 'profileSetup', redeemed: true }, STORED)).toMatchObject({ action: 'resume', mode: 'profileSetup', flow: 'claim' });
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

    it('hands a claim whose answer is not in back to the claim screen, with no code (never kept)', () => {
        const s = src();
        expect(s).toMatch(/if \(plan\.mode === 'claim'\) \{[^}]*router\.replace\(claimRouteFor\(\{ node: plan\.anchorUrl, nodeRefused: false, codeId: plan\.claimCodeId, code: null \}\)\);\s*return;/);
    });

    it('resumes through resumePlan, and takes a global record back to the door with its key', () => {
        const s = src();
        expect(s).toMatch(/const plan = resumePlan\(pending, await loadIdentity\(\)/);
        expect(s).toMatch(/if \(plan\.mode === 'globalJoin' && plan\.identity\) \{\s*\/\/[^\n]*\n\s*setGlobalKey\(\{ identity: plan\.identity, createdHere: plan\.freshKey \}\);/);
    });

    // One line in English at the floor's width, shrinking first; a second line for a longer language, which one line
    // can't hold even at 0.6 (21 of the 24 other languages: utils/__tests__/language-switch-render.test.ts).
    it('offers the two doors as two full-width buttons of at most two lines, and no longer says BeanPool is invite-only', () => {
        // The doors are drawn by components/WelcomeDoors.tsx (DESIGN-global-entry §B.3).
        const s = src() + fs.readFileSync(path.resolve(__dirname, '../../components/WelcomeDoors.tsx'), 'utf-8');
        expect(s).toMatch(/numberOfLines=\{2\} adjustsFontSizeToFit minimumFontScale=\{0\.6\}>\{t\('🎟️ Join with an invite'\)\}</);
        expect(s).toMatch(/onPress=\{openGlobalDoor\}[^>]*>\s*<Text style=\{styles\.memberBtnText\} numberOfLines=\{2\} adjustsFontSizeToFit minimumFontScale=\{0\.6\}>\{t\('🌍 Explore BeanPool worldwide'\)\}</);
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
        // With the screen's notice for the backstop's second sheet (V5: a door that refuses the vault's ticket).
        expect(door).toMatch(/commitJoinKey\(key, name\)[\s\S]*submitJoin\(GLOBAL_NODE_URL, identity, name, signin, \{ onSignInAgain: setDoorNotice, work: doorWork\.runFor\('sign-in'\) \}\)/);
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
