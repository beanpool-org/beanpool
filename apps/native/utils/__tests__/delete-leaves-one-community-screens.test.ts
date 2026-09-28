/**
 * Settings' Permanently Delete Account and the not-recognised screen's delete follow utils/delete-here.ts: the node
 * deletes the account at this community, and the key leaves the phone only at the member's last community (Marty,
 * 2026-09-29). The behaviour itself is in delete-leaves-one-community.test.ts.
 *
 * The screens cannot be rendered here (see vitest.config.ts): their wiring is read from their source.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const source = (rel: string) => code(fs.readFileSync(path.resolve(__dirname, '../../app', rel), 'utf-8'));
/** From `start` to the first `end` after it. */
function slice(s: string, start: string, end: string): string {
    const from = s.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThan(-1);
    const to = s.indexOf(end, from + start.length);
    expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
    return s.slice(from, to);
}

describe('Settings: Permanently Delete Account follows the plan', () => {
    const settings = () => source('(tabs)/settings.tsx');
    const purge = () => slice(settings(), 'async function handleNodePurge() {', '\n    }\n');

    it('deletes through deleteAccountHere with the plan the member confirmed, and wipes nothing itself', () => {
        const body = purge();
        expect(body).toContain('const plan = deletePlan;');
        expect(body).toContain('if (!plan) return;');
        expect(body).toContain('await deleteAccountHere(identity, plan);');
        expect(body).not.toContain('signOutOfThisPhone(');
        expect(body).not.toContain('purgeAccountOnNode(');
        // The phone's lock before the confirmation, as before.
        expect(body.indexOf("await authenticateUser('Confirm authentication to permanently purge your account from the node.')"))
            .toBeLessThan(body.indexOf('Alert.alert(\n            "Permanent Node Purge"'));
    });

    it('the key goes from the screen only when the phone was wiped; leaving one community keeps it', () => {
        const body = purge();
        const wiped = slice(body, "case 'wiped':", 'return;');
        expect(wiped).toContain('setIdentity(null);');
        expect(body.split('setIdentity(null)').length - 1).toBe(1);
        const left = slice(body, "case 'left':", 'return;');
        expect(left).toContain("router.replace('/welcome');");
        const failed = slice(body, "case 'not-deleted':", 'return;');
        expect(failed).toContain('deleteFailedLine(');
    });

    it('the confirmation says what stays, and the button waits for the other communities\' answers', () => {
        const s = settings();
        expect(purge()).toContain('keepsKeyLine(plan, words)');
        expect(purge()).toContain('lastCommunityLine(plan, words)');
        expect(s).toContain('const purgeBlocked = advancedLoading || !isPurgeInputValid || !deletePlan;');
        expect(s).toContain('disabled={purgeBlocked}');
        // The plan is asked as the member opens the delete.
        const open = slice(s, "setWipeType('purge');", '}}');
        expect(open).toContain('askDeletePlan();');
    });
});

describe('node-mismatch: its delete takes the key only when no saved community keeps it', () => {
    const screen = () => source('node-mismatch.tsx');
    const start = () => slice(screen(), 'async function handleStartWipe() {', '\n    }\n');

    it('asks the other saved communities before the lock, and a community that keeps the key stops the delete', () => {
        const body = start();
        const asked = body.indexOf('await otherCommunitiesKeeping(nodeUrl, identity.publicKey)');
        const kept = body.indexOf('if (keeping.length > 0) {');
        const stopped = body.indexOf('setKeptBy(keeping);\n                return;');
        const lock = body.indexOf('readWordsBehindLock(');
        expect(asked).toBeGreaterThan(-1);
        expect(kept).toBeGreaterThan(asked);
        expect(stopped).toBeGreaterThan(kept);
        expect(lock).toBeGreaterThan(stopped);
        expect(body.indexOf('authenticateUser(')).toBeGreaterThan(stopped);
        // A check that failed removes nothing.
        const failed = slice(body, '} catch (e) {', '} finally {');
        expect(failed).toContain('return;');
    });

    it('offers to switch to the communities that keep the key, and no delete meanwhile', () => {
        const s = screen();
        const kept = slice(s, '{keptBy && keptBy.length > 0 && !showWipe && (', '{!showWipe ? (');
        expect(kept).toContain('stillKeptLine(keptBy)');
        expect(kept).toContain('onPick={switchToNode}');
        expect(kept).not.toContain('handleStartWipe');
        expect(slice(s, '{!showWipe ? (', ') : (')).toContain('!keptBy?.length && (');
    });
});
