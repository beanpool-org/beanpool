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
 * - Which is which survives the app being stopped part-way (the wizard's record, `newKey`).
 *
 * The screen cannot be rendered here (see vitest.config.ts): its wiring is read from its source.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));

import { keyMadeForThisJoin, resumePlan, type PendingOnboarding } from '../onboarding-state';
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
