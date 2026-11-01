/**
 * Every place in the app that takes a community off the phone's list tells that community to drop the push token first
 * (utils/account-leaves-phone.ts `forgetCommunityPush`; scratch/fable-design/DESIGN-cross-community-chat-fable.md R2).
 *
 * The token goes to every community the phone keeps now, so a community left on the list by Forget would keep it, and go
 * on putting lines on the lock screen for a member who said goodbye to it. Forget Community used to send nothing. This reads
 * the app's source, finds each `removeSavedNode(` call, and fails on a file with one and no `forgetCommunityPush(`, unless
 * it is a named exception, each with its reason. The behaviour itself is pinned in push-leave.test.ts. Nothing here runs
 * the app.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const NATIVE = path.resolve(__dirname, '../..');
const DIRS = ['app', 'components', 'utils', 'services', 'hooks'];

/** The source without comments, so neither call can be met by a comment. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
            } else if (/\.(ts|tsx)$/.test(entry.name)) {
                out.push(full);
            }
        }
    };
    for (const d of DIRS) walk(path.join(NATIVE, d));
    return out;
}

/** Files that take a community off the list without letting it go, each with why. */
const EXCEPTIONS: Record<string, string> = {
    // Where it is defined.
    'utils/nodes.ts': 'removeSavedNode itself',
    // The community moved: the same node may answer at both addresses, and a DELETE at the old one would take the row the
    // new one needs (acceptAddressFollow carries the alerts choice instead).
    'utils/address-follow.ts': 'a move, not a goodbye',
};

describe('a community taken off the phone is told first', () => {
    const removers = sourceFiles()
        .map((full) => ({ file: path.relative(NATIVE, full), src: code(fs.readFileSync(full, 'utf8')) }))
        .filter(({ src }) => /\bremoveSavedNode\s*\(/.test(src));

    it('finds the paths this is about', () => {
        const files = removers.map((r) => r.file);
        for (const f of ['app/(tabs)/settings.tsx', 'app/(tabs)/people.tsx', 'app/_layout.tsx', 'utils/use-communities.ts']) {
            expect(files).toContain(f);
        }
    });

    it('each goes through forgetCommunityPush, or is a named exception', () => {
        const silent = removers.filter(({ file, src }) => !EXCEPTIONS[file] && !/\bforgetCommunityPush\s*\(/.test(src)).map((r) => r.file);
        expect(silent).toEqual([]);
    });

    it('no exception has gone stale', () => {
        for (const file of Object.keys(EXCEPTIONS)) expect(removers.map((r) => r.file)).toContain(file);
    });

    it('a switch retries only what is due: a phone set to a community it never registered with may be only looking', () => {
        const service = code(fs.readFileSync(path.join(NATIVE, 'services/push-notifications.ts'), 'utf8'));
        expect(service).toMatch(/onCommunitySwitched\(\(\) => \{ void retryDueRegistrations\(/);
        expect(service).toMatch(/stopRetrying\(\);/);
        // A return, a join and a restore catch up with the communities never asked.
        expect(service).toMatch(/retryPushRegistrations\(\): Promise<void> \{\s*return registerWhereMissing\(/);
    });

    it('an address move sends no DELETE and keeps the alerts choice', () => {
        const follow = removers.find((r) => r.file === 'utils/address-follow.ts')!.src;
        expect(follow).toMatch(/\bcarryAlertsOff\s*\(/);
        expect(follow).not.toMatch(/forgetCommunityPush|unregisterPushTokenAt|stopPushAlertsAt/);
    });
});
