/**
 * Profile S1 (scratch/fable-design/DESIGN-per-community-profile-fable.md §4), review of #2596, pass 1 of 114c4954:
 * the Settings card's picture follows the community like its name does. The card draws `own.avatarUrl` (the hook's
 * read of this community's row) and, where that holds none, `avatar` — the loader's state. "Row read, no photo" and
 * "no row at all" are both a null `own.avatarUrl`, so the card falls through to `avatar`; if the loader leaves `avatar`
 * alone where the new community holds no row, it keeps the community before's photo while the header shows the preset.
 * The name has the same rule ("Assign unconditionally") and `showCommunityName` assigns it every load.
 *
 * Settings is a 3,000-line screen the suites do not draw, so this reads the loader's source as the neighbouring
 * pins do (avatar-value.test.ts).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const settings = () => code(fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/settings.tsx'), 'utf-8'));

/** The body of `loadProfileForCurrentNode`, up to its dependency list. */
const loader = () => {
    const src = settings();
    const start = src.indexOf('const loadProfileForCurrentNode = React.useCallback(async () => {');
    const end = src.indexOf('}, [identity?.publicKey, identity?.privateKey, identity?.callsign, resolveCommunityLabel, setIdentity]);', start);
    expect(start, 'the loader is where this pin expects it').toBeGreaterThan(-1);
    expect(end, 'the loader ends where this pin expects it').toBeGreaterThan(start);
    return src.slice(start, end);
};

describe("the Settings card's picture follows the community the phone is on", () => {
    it('the loader assigns the displayed picture on every load, whether or not this community holds a row for you', () => {
        const body = loader();
        // One assignment, and it is not inside the `if (profile)` or the `else if (canonical)` branch: a community with no
        // row (a first sync, a membersOnDemand community before the own card lands, a guest visit) would otherwise keep
        // the previous community's photo, because nothing else on the screen resets it but the picker.
        const assigns = body.match(/\bsetAvatar\(/g) ?? [];
        expect(assigns).toHaveLength(1);
        expect(body).toContain('if (!edited.avatar) setAvatar(');
        const assignAt = body.indexOf('setAvatar(');
        const branchAt = body.indexOf('if (profile) {');
        expect(branchAt, 'the row/canonical branches are where this pin expects them').toBeGreaterThan(-1);
        expect(assignAt).toBeLessThan(branchAt);
    });

    it("what it assigns is this community's row photo, else the phone-wide copy, else nothing — never the value held before", () => {
        const body = loader();
        expect(body).toMatch(/if \(!edited\.avatar\) setAvatar\(cleaned \|\| canonical\?\.avatar \|\| null\);/);
        // `cleaned` reads the row if there is one (the literal strings 'null' and 'undefined' a bad sync once stored are no photo).
        expect(body).toMatch(/const cleaned = \(profile\?\.avatar_url && profile\.avatar_url !== 'null' && profile\.avatar_url !== 'undefined' && profile\.avatar_url\.trim\(\) !== ''\) \? profile\.avatar_url : null;/);
    });

    it('a photo the member is picking is still never overwritten by a load', () => {
        const src = settings();
        expect(src).toContain('editedRef.current.avatar = true;');
        expect(loader()).toContain('const edited = editedRef.current;');
        expect(loader()).not.toMatch(/(?<!if \(!edited\.avatar\) )setAvatar\(/);
    });
});
