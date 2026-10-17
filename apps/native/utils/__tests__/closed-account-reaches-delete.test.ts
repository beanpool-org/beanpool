/**
 * A member whose account the community in use closed (403 `account_closed`: removed, or deleted by its owner) can still
 * reach Delete account (PR #2098's deciding review, BLOCKING 4302678596).
 *
 * Settings → Account Deletion & Sign Out → Permanently Delete Account is the phone's only way to send
 * `POST /api/member/purge`, the one request a community still takes from a closed key (server https-server.ts
 * `isOwnDeleteAccount`), and the only way left to erase the profile a removal keeps there (Marty's card
 * removed-member-delete, 2026-09-27). P1 diverted a closed account to the not-recognised screen's closed page from every
 * other screen, Settings included, so the delete was gone. Now the root guard leaves a closed account on Settings, the
 * closed page leads there (node-mismatch-reconnect-render.test.ts), and Settings opens the delete itself. That the
 * community takes the delete from a closed key, and the phone finishes it, is measured against a real node in
 * global-entry-e2e.test.ts (step 4).
 *
 * The root layout and Settings cannot be rendered here (see delete-leaves-one-community-screens.test.ts): their wiring is
 * read from their source.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLOSED_ACCOUNT_DELETE, notRecognisedStays } from '../mismatch-plan';

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

describe('the root guard: where a refused key may stay (notRecognisedStays)', () => {
    it('a closed account stays on Settings, the way to Delete account; every other tab goes to the closed page', () => {
        expect(notRecognisedStays('closed', ['(tabs)', 'settings'])).toBe(true);
        for (const at of [['(tabs)'], ['(tabs)', 'index'], ['(tabs)', 'market'], ['(tabs)', 'people'], ['(tabs)', 'chats'], ['profile-setup'], []]) {
            expect(notRecognisedStays('closed', at), at.join('/')).toBe(false);
        }
    });

    it('a stranger is diverted from Settings as before: it has no account there to delete', () => {
        expect(notRecognisedStays('stranger', ['(tabs)', 'settings'])).toBe(false);
        expect(notRecognisedStays('stranger', ['(tabs)', 'market'])).toBe(false);
    });

    it('neither is diverted off the not-recognised screen or the screens it leads to', () => {
        for (const answer of ['stranger', 'closed'] as const) {
            for (const root of ['node-mismatch', 'welcome', 'recover-identity', 'join-global']) {
                expect(notRecognisedStays(answer, [root]), `${answer} on ${root}`).toBe(true);
            }
        }
    });

    it('app/_layout.tsx asks it for both answers before it diverts', () => {
        const layout = source('_layout.tsx');
        const closed = slice(layout, "if (recognition === 'closed') {", 'return;');
        expect(closed).toContain("if (!notRecognisedStays('closed', segments as string[]))");
        expect(closed).toContain("router.replace('/node-mismatch')");
        const stranger = slice(layout, "if (recognition === 'stranger') {", "router.replace('/node-mismatch')");
        expect(stranger).toContain("if (!notRecognisedStays('stranger', segments as string[]))");
    });
});

describe('Settings opens Delete account where the closed page sends it', () => {
    it('the closed page goes to Settings, section delete', () => {
        expect(CLOSED_ACCOUNT_DELETE).toEqual({ pathname: '/(tabs)/settings', params: { section: 'delete' } });
    });

    it("section 'delete' opens Account Deletion & Sign Out at Permanently Delete Account, and asks the plan as its button does", () => {
        const s = source('(tabs)/settings.tsx');
        const branch = slice(s, "} else if (params.section === 'delete') {", '} else {');
        expect(branch).toContain("setMode('wipe');");
        expect(branch).toContain("setPurgeConfirm('');");
        expect(branch).toContain("setWipeType('purge');");
        expect(branch).toContain('askDeletePlan();');
        // The same three steps as the Permanently Delete Account button: the panel waits for the plan, then deletes it.
        const button = slice(s, "setPurgeConfirm('');\n                                        setWipeType('purge');", '}}');
        expect(button).toContain('askDeletePlan();');
    });
});
