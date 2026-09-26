/**
 * The join wizard's Safety Backup, for a key the phone already had (PR #1205 review 4112404374).
 *
 * handleCreate reuses the phone's key when it has one: an established account joining another community goes through
 * the same wizard, and Safety Backup drew THAT account's 12 words (and "Rather write down 12 words?" revealed them) with
 * no check. An unlocked-phone holder could drive an established account there with any invite they hold.
 *
 * - A key this join made (the invite wizard's createIdentity, or the global door's own key) shows its words as before:
 *   they are the member's own new ones.
 * - A key the phone already had: its words are read only through readWordsBehindLock, when Show passes the lock.
 * - Which is which survives the app being stopped part-way (the wizard's record, `newKey`), and a first redeem that
 *   fails: the record says so as soon as the key is on the phone (review 4112501801).
 * - The phone's own account's words go when the member leaves the step or the screen, so every Show asks the lock again
 *   (review 4112501763).
 *
 * The screen cannot be rendered here (see vitest.config.ts): its wiring is read from its source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The phone's app storage, where the wizard's record lives. */
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => storage.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { storage.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { storage.delete(k); }),
    },
}));

import {
    keyMadeForThisJoin, resumePlan, getPendingOnboarding, setPendingOnboarding, clearPendingOnboarding, recordJoinKeyMade,
    type PendingOnboarding,
} from '../onboarding-state';
import type { BeanPoolIdentity } from '../identity';

const KEY = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const STORED: BeanPoolIdentity = { publicKey: KEY, privateKey: '07'.repeat(32), callsign: 'Kim', createdAt: '' };
const INVITE_AT_BACKUP: PendingOnboarding = {
    step: 'seedBackup', inviteCode: 'INV-ABC', anchorUrl: 'https://node.example', callsign: 'Kim', redeemed: true,
};
const GLOBAL = 'https://global.beanpool.org';
const GLOBAL_AT_DOOR: PendingOnboarding = {
    step: 'globalJoin', flow: 'global', inviteCode: '', anchorUrl: GLOBAL, callsign: 'Kim', redeemed: false, freshKey: KEY,
};

describe('keyMadeForThisJoin: whose 12 words Safety Backup shows', () => {
    it('a key the invite wizard made is new', () => {
        expect(keyMadeForThisJoin({ ...INVITE_AT_BACKUP, newKey: KEY }, KEY)).toBe(true);
    });

    it("the global door's own key is new, while the door's record says so", () => {
        expect(keyMadeForThisJoin(GLOBAL_AT_DOOR, KEY)).toBe(true);
        // An invite record can't make a key the door's (adoptJoinKey takes freshKey away when an invite join uses it).
        expect(keyMadeForThisJoin({ ...INVITE_AT_BACKUP, freshKey: KEY }, KEY)).toBe(false);
    });

    it('an invite join the door is holding (`before`) still knows the key it made', () => {
        expect(keyMadeForThisJoin({ ...GLOBAL_AT_DOOR, freshKey: undefined, before: { ...INVITE_AT_BACKUP, newKey: KEY } }, KEY)).toBe(true);
    });

    it("a key the phone already had is not: no mark, another key's mark, or no record", () => {
        expect(keyMadeForThisJoin(INVITE_AT_BACKUP, KEY)).toBe(false);
        expect(keyMadeForThisJoin({ ...INVITE_AT_BACKUP, newKey: OTHER }, KEY)).toBe(false);
        expect(keyMadeForThisJoin({ ...GLOBAL_AT_DOOR, freshKey: OTHER }, KEY)).toBe(false);
        expect(keyMadeForThisJoin(null, KEY)).toBe(false);
        expect(keyMadeForThisJoin({ ...INVITE_AT_BACKUP, newKey: '' }, '')).toBe(false);
    });
});

describe('the wizard resumed after the app was stopped', () => {
    it('knows a key it made from its record', () => {
        expect(resumePlan({ ...INVITE_AT_BACKUP, newKey: KEY }, STORED)).toMatchObject({ action: 'resume', newKey: true });
        expect(resumePlan({ ...GLOBAL_AT_DOOR, step: 'seedBackup', redeemed: true, freshKey: undefined, newKey: KEY }, STORED))
            .toMatchObject({ action: 'resume', flow: 'global', newKey: true });
    });

    it("treats the phone's key as the phone's account when the record doesn't say this join made it", () => {
        expect(resumePlan(INVITE_AT_BACKUP, STORED)).toMatchObject({ action: 'resume', newKey: false });
        expect(resumePlan({ ...INVITE_AT_BACKUP, newKey: OTHER }, STORED)).toMatchObject({ action: 'resume', newKey: false });
    });
});

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const welcome = () => code(fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf-8'));
/** From `start` to the first `end` after it. */
function slice(s: string, start: string, end: string): string {
    const from = s.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThan(-1);
    const to = s.indexOf(end, from + start.length);
    expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
    return s.slice(from, to);
}
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("welcome.tsx: Safety Backup's words", () => {
    const backup = () => slice(welcome(), "if (mode === 'seedBackup' && pendingIdentity) {", "if (mode === 'onboardingGuide' && pendingIdentity) {");
    const showBehindLock = () => slice(welcome(), 'async function handleShowPendingWords() {', '\n    }\n');

    it('are new only when this join made the key', () => {
        expect(welcome()).toContain('const pendingWordsAreNew = !!pendingIdentity && pendingNewKey === pendingIdentity.publicKey;');
    });

    it("are read as the step opens only for a key this join made; the phone's own account's are not read at all", () => {
        const s = welcome();
        const effect = slice(s, 'useEffect(() => {\n        let cancelled = false;\n        if (!pendingWordsAreNew) {', '}, [pendingIdentity, pendingWordsAreNew]);');
        const refused = effect.indexOf('setPendingWords(null);\n            return;');
        const read = effect.indexOf('getMnemonic(pendingIdentity)');
        expect(refused).toBeGreaterThan(-1);
        expect(read).toBeGreaterThan(refused);
        // That effect is the only read of the pending account's words.
        expect(count(s, 'getMnemonic(pendingIdentity)')).toBe(1);
    });

    it("the phone's own account's words come only through the lock, and one that answers after the step moved on shows nothing", () => {
        const body = showBehindLock();
        const asked = body.indexOf("await readWordsBehindLock(account, 'Confirm your security to view your recovery phrase.')");
        const refused = body.indexOf('if (!words || pendingIdentityRef.current !== account) return;');
        const kept = body.indexOf('setPendingWords(words)');
        expect(body).toContain('const account = pendingIdentity;');
        expect(asked).toBeGreaterThan(-1);
        expect(refused).toBeGreaterThan(asked);
        expect(kept).toBeGreaterThan(refused);
        // Words enter state nowhere else: the new key's read (`w`) and this.
        expect(welcome().match(/setPendingWords\((?!null\)|w\)|words\))/g)).toBeNull();
        expect(count(welcome(), 'setPendingWords(words)')).toBe(1);
    });

    it("the step draws the phone's own account's words only once the lock let them through, from a button that asks it", () => {
        const s = backup();
        expect(s).toContain('!(pendingWordsAreNew ? protection.showWords || revealWords : !!pendingWords) ? (');
        expect(s).toContain('onPress={pendingWordsAreNew ? () => setRevealWords(true) : handleShowPendingWords}');
    });

    it('Copy copies the words the step shows, never a fresh read', () => {
        const copy = slice(welcome(), 'async function handleCopySeed() {', '\n    }\n');
        expect(copy).toContain('const words = pendingWords;');
        expect(copy).not.toContain('getMnemonic');
    });
});

/**
 * PR #1205 review 4112501763. Once the phone's own account's words had passed the lock, they stayed drawn after the member
 * left the step: the welcome screen stays mounted through the whole wizard, and nothing put them away but a change of
 * account. How it Works → "← Back to Backup", or in the global flow ← Back → photo → Next, only change the step, so
 * whoever next picked up the phone got the 12 words and Copy with no lock. Settings puts its words away the same way.
 */
describe("welcome.tsx: Safety Backup's words for a key the phone already had go when the member leaves", () => {
    const putAway = () => slice(welcome(), 'const putPendingWordsAway = useCallback(() => {', '}, []);');
    const showBehindLock = () => slice(welcome(), 'async function handleShowPendingWords() {', '\n    }\n');

    it('putting them away moves the turn on and takes the words out of state, for a key this join did not make', () => {
        const body = putAway();
        expect(body).toContain('pendingWordsTurnRef.current += 1;');
        expect(body).toContain('if (!pendingWordsAreNewRef.current) setPendingWords(null);');
        // Read at the moment it runs, not from the render that made the callback.
        expect(welcome()).toMatch(/const pendingWordsAreNewRef = useRef\(pendingWordsAreNew\);\s*pendingWordsAreNewRef\.current = pendingWordsAreNew;/);
    });

    it('leaving Safety Backup puts them away: Next to How it Works, the global flow\'s ← Back to the photo, any other step', () => {
        expect(welcome()).toMatch(/useEffect\(\(\) => \{\s*if \(mode !== 'seedBackup'\) putPendingWordsAway\(\);/);
    });

    it('leaving the welcome screen puts them away too', () => {
        expect(welcome()).toMatch(
            /useFocusEffect\(useCallback\(\(\) => \(\) => \{\s*putPendingWordsAway\(\);\s*putOutgoingWordsAway\(\);\s*\}, \[putPendingWordsAway, putOutgoingWordsAway\]\)\);/,
        );
    });

    it('so every Show asks the lock again, and one that answers after the member left shows nothing', () => {
        const body = showBehindLock();
        const turn = body.indexOf('const turn = pendingWordsTurnRef.current;');
        const asked = body.indexOf("await readWordsBehindLock(account, 'Confirm your security to view your recovery phrase.')");
        const left = body.indexOf('if (turn !== pendingWordsTurnRef.current) return;');
        const kept = body.indexOf('setPendingWords(words)');
        expect(turn).toBeGreaterThan(-1);
        expect(asked).toBeGreaterThan(turn);
        expect(left).toBeGreaterThan(asked);
        expect(kept).toBeGreaterThan(left);
    });

    it("the way back to Safety Backup changes only the step: it draws nothing the lock hasn't just let through", () => {
        const guideBack = slice(welcome(), "updatePendingOnboarding({ step: 'seedBackup' }).catch(() => {});", '}}');
        expect(guideBack).toContain("setMode('seedBackup');");
        expect(guideBack).not.toContain('setPendingWords');
    });
});

describe('welcome.tsx: every way into the wizard says whether it made the key', () => {
    it("an invite join: made when the phone had no key, or when the phone's key is one this join made earlier", () => {
        const s = welcome();
        const create = slice(s, 'async function handleCreate() {', '\n    }\n');
        const recordRead = create.indexOf('const joinRecord = storedIdentity ? await getPendingOnboarding() : null;');
        const adopted = create.indexOf('await adoptJoinKey(storedIdentity.publicKey)');
        expect(recordRead).toBeGreaterThan(-1);
        // Read before adoptJoinKey takes the door's mark off the record.
        expect(adopted).toBeGreaterThan(recordRead);
        expect(create).toContain('const keyIsNew = !storedIdentity || keyMadeForThisJoin(joinRecord, storedIdentity.publicKey);');
        expect(create).toMatch(/setPendingIdentity\(identity\);\s*setPendingNewKey\(keyIsNew \? identity\.publicKey : null\);/);
        expect(create).toMatch(/setPendingOnboarding\(\{[^}]*\.\.\.\(keyIsNew \? \{ newKey: identity\.publicKey \} : \{\}\),/);
    });

    it("the global door: made when the door made it", () => {
        const s = welcome();
        const finish = slice(s, 'async function finishGlobalJoin(', '\n    }\n');
        expect(finish).toContain('const keyIsNew = key.createdHere || keyMadeForThisJoin(await getPendingOnboarding(), joined.publicKey);');
        expect(finish.indexOf('const keyIsNew')).toBeLessThan(finish.indexOf('await setPendingOnboarding({'));
        expect(finish).toMatch(/setPendingOnboarding\(\{[^}]*\.\.\.\(keyIsNew \? \{ newKey: identity\.publicKey \} : \{\}\),/);
        expect(finish).toMatch(/setPendingIdentity\(identity\);\s*setPendingNewKey\(keyIsNew \? identity\.publicKey : null\);/);
        expect(s).toContain('await finishGlobalJoin(await joinedUnderNodeName(GLOBAL_NODE_URL, answer, identity), answer.enrolment, key);');
    });

    it('a resumed wizard: from its record', () => {
        expect(welcome()).toMatch(/setPendingIdentity\(plan\.identity\);\s*setPendingNewKey\(plan\.newKey \? plan\.identity\.publicKey : null\);/);
    });

    it('no account reaches Safety Backup without one of those', () => {
        const s = welcome();
        // setPendingIdentity with an account: the three above. Every other call puts it away.
        expect(s.match(/setPendingIdentity\((?!null\))/g)).toHaveLength(3);
        expect(count(s, 'setPendingNewKey(')).toBe(3);
    });
});

/**
 * PR #1205 review 4112501801. handleCreate saves the key it makes before it redeems the invite, but wrote the record that
 * says the key is new only once the redeem had worked. A redeem that throws (offline, a 5xx, a captive portal, a node that
 * doesn't confirm) or an app stopped before its answer left the new key on the phone with no record, and the next Next
 * took it for the phone's own account: the member's own new words went behind the lock.
 *
 * The record now says so as soon as the key is on the phone, before the redeem, and still only for the key that Next made.
 */
describe('a first Next whose redeem fails: the key it made is still the member\'s new one', () => {
    const MADE: BeanPoolIdentity = { publicKey: 'ef'.repeat(32), privateKey: '09'.repeat(32), callsign: 'Kim', createdAt: '' };
    const JOIN = { inviteCode: 'INV-ABC', anchorUrl: 'https://node.example', callsign: 'Kim' };
    const offline = async () => { throw new Error('Relay Node Offline'); };
    const works = async () => {};

    /**
     * Next on "Your Name" (welcome.tsx handleCreate): its key and record steps, in its order, with the real record
     * functions; the order is pinned against the screen's source below. `phone.key` is the key stored on the phone,
     * `redeem` stands for redeemInvite. Returns `keyIsNew`: whether Safety Backup takes the key as the member's new one
     * (its words drawn with no lock) or as the phone's own account (its words only through the lock).
     * adoptJoinKey is left out: it only ever touches a record of the global door's.
     */
    async function next(phone: { key: BeanPoolIdentity | null }, redeem: () => Promise<void>): Promise<boolean> {
        const storedIdentity = phone.key;
        const joinRecord = storedIdentity ? await getPendingOnboarding() : null;
        // createIdentity: the key is on the phone first.
        const identity = storedIdentity ? { ...storedIdentity, callsign: JOIN.callsign } : (phone.key = MADE);
        if (!storedIdentity) await recordJoinKeyMade(JOIN, identity.publicKey);
        const keyIsNew = !storedIdentity || keyMadeForThisJoin(joinRecord, storedIdentity.publicKey);
        await redeem();
        await setPendingOnboarding({ step: 'profileSetup', ...JOIN, redeemed: true, ...(keyIsNew ? { newKey: identity.publicKey } : {}) });
        return keyIsNew;
    }

    beforeEach(() => storage.clear());

    it('a redeem that throws, then Next again: the words are the member\'s own, shown with no lock', async () => {
        const phone = { key: null as BeanPoolIdentity | null };
        await expect(next(phone, offline)).rejects.toThrow('Relay Node Offline');
        expect(phone.key).toBe(MADE);

        expect(await next(phone, works)).toBe(true);
        const record = await getPendingOnboarding();
        expect(record).toMatchObject({ step: 'profileSetup', redeemed: true, newKey: MADE.publicKey });
        // And after a restart past that point.
        expect(resumePlan(record, MADE)).toMatchObject({ action: 'resume', newKey: true });
    });

    it('the app stopped between the key and the redeem, then started again: back at Next, and the key is still new', async () => {
        const phone = { key: null as BeanPoolIdentity | null };
        // The redeem never answers: the app is stopped while it waits.
        next(phone, () => new Promise<void>(() => {})).catch(() => {});
        await vi.waitFor(async () => expect(await getPendingOnboarding()).not.toBeNull());

        // The gatekeeper sees a record and keeps the phone in the wizard; the welcome screen resumes at Next with the
        // name and invite, not yet redeemed, and without committing to the key (handleCreate reads it on Next).
        const plan = resumePlan(await getPendingOnboarding(), MADE);
        expect(plan).toMatchObject({
            action: 'resume', mode: 'create', flow: 'invite', callsign: 'Kim', inviteCode: 'INV-ABC', anchorUrl: 'https://node.example',
            redeemed: false, identity: null, newKey: true,
        });

        expect(await next(phone, works)).toBe(true);
    });

    it('an established account joining another community: still behind the lock, whether its first redeem works or not', async () => {
        const phone = { key: STORED as BeanPoolIdentity | null };
        await expect(next(phone, offline)).rejects.toThrow();
        // Nothing was written for a key the phone already had.
        expect(await getPendingOnboarding()).toBeNull();
        expect(await next(phone, works)).toBe(false);
        expect(await getPendingOnboarding()).not.toHaveProperty('newKey');
        expect(resumePlan(await getPendingOnboarding(), STORED)).toMatchObject({ action: 'resume', newKey: false });

        // The same with an earlier invite join's record on the phone.
        await setPendingOnboarding({ ...INVITE_AT_BACKUP, step: 'create', redeemed: false });
        expect(await next(phone, works)).toBe(false);
    });

    it('once the wizard is finished, its key joining another community is the phone\'s own account: behind the lock', async () => {
        const phone = { key: null as BeanPoolIdentity | null };
        await expect(next(phone, offline)).rejects.toThrow();
        expect(await next(phone, works)).toBe(true);
        // The wizard's finish (and a wipe, and a restore) end the record, as they always have.
        await clearPendingOnboarding();
        expect(await next(phone, works)).toBe(false);
    });

    it('the early record: at Next, not redeemed, naming only the key just made, with what the resume reads', async () => {
        await recordJoinKeyMade(JOIN, MADE.publicKey);
        expect(await getPendingOnboarding()).toEqual({
            step: 'create', inviteCode: 'INV-ABC', anchorUrl: 'https://node.example', callsign: 'Kim', redeemed: false, newKey: MADE.publicKey,
        });
        // It replaces an invite join's record whose key is gone (the phone had none, or Next would not have made one).
        await setPendingOnboarding({ ...INVITE_AT_BACKUP, avatar: 'bundled:fox', newKey: OTHER });
        await recordJoinKeyMade(JOIN, MADE.publicKey);
        expect(await getPendingOnboarding()).toEqual({
            step: 'create', inviteCode: 'INV-ABC', anchorUrl: 'https://node.example', callsign: 'Kim', redeemed: false, newKey: MADE.publicKey,
        });
        // No key, no record.
        storage.clear();
        await recordJoinKeyMade(JOIN, '');
        expect(await getPendingOnboarding()).toBeNull();
    });

    it("never writes over the global door's record, nor the invite join the door holds (`before`)", async () => {
        const door: PendingOnboarding = { ...GLOBAL_AT_DOOR, freshKey: OTHER, joinsOut: 1, before: { ...INVITE_AT_BACKUP, newKey: OTHER } };
        await setPendingOnboarding(door);
        await recordJoinKeyMade(JOIN, MADE.publicKey);
        expect(await getPendingOnboarding()).toEqual(door);
        // Which leaves a retry asking the lock: never a key ungated that the record doesn't name.
        expect(keyMadeForThisJoin(await getPendingOnboarding(), MADE.publicKey)).toBe(false);
    });
});

describe('welcome.tsx: Next writes that record once the key it made is on the phone, before the redeem', () => {
    it('after createIdentity, before redeemInvite, only for a key Next made', () => {
        const create = slice(welcome(), 'async function handleCreate() {', '\n    }\n');
        const made = create.indexOf(': await createIdentity(callsign.trim());');
        const recorded = create.indexOf(
            'if (!storedIdentity) await recordJoinKeyMade({ inviteCode: parsedCode, anchorUrl: nodeUrl, callsign: callsign.trim() }, identity.publicKey);',
        );
        const redeemed = create.indexOf('await redeemInvite(parsedCode, identity.callsign, identity);');
        expect(made).toBeGreaterThan(-1);
        expect(recorded).toBeGreaterThan(made);
        expect(redeemed).toBeGreaterThan(recorded);
        // The key it reads as new is decided as before: the record it read before this write, for a stored key.
        expect(create.indexOf('const joinRecord = storedIdentity ? await getPendingOnboarding() : null;')).toBeLessThan(made);
        // Nowhere else writes it.
        expect(count(welcome(), 'recordJoinKeyMade(')).toBe(1);
    });
});
