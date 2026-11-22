import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCoreChange, isCoreLogLine, type ShapeLogLine } from './community-shape';

// The manager locks exactly what the server locks (followup 15, #3258 review: the Who can join row's pause is an everyday
// change on the server, apps/server config/core-settings.ts isCoreChange). The page's copy of the rule is the server's.

const SERVER_RULE = join(__dirname, '..', '..', '..', 'server', 'src', 'config', 'core-settings.ts');
const OWN_RULE = join(__dirname, 'community-shape.ts');

/** The body of `export function isCoreChange(...)`, without its signature (the types differ: CommunityDoor, string). */
function bodyOf(source: string): string {
    const start = source.indexOf('export function isCoreChange(');
    expect(start).toBeGreaterThan(-1);
    const open = source.indexOf('{', source.indexOf(')', start));
    const end = source.indexOf('\n}\n', open);
    return source.slice(open + 1, end).trim().replace(/isCoreSettingName\b/g, 'isCoreSetting');
}

describe('isCoreChange: the server rule, case by case', () => {
    it('is the server\'s body word for word', () => {
        expect(bodyOf(readFileSync(OWN_RULE, 'utf8'))).toBe(bodyOf(readFileSync(SERVER_RULE, 'utf8')));
    });

    // [setting, to, door stored before, Core?]
    const TABLE: Array<[string, string, string, boolean]> = [
        ['join', 'paused', 'members', false], // pausing
        ['join', 'paused', 'admins', false],
        ['join', 'members', 'members', false], // un-pausing to the door it had
        ['join', 'admins', 'admins', false],
        ['join', 'admins', 'members', true], // a new door (paused before or not)
        ['join', 'members', 'admins', true],
        ['wordsDoor', 'false', 'members', true],
        ['beans', 'false', 'members', true],
        ['knownFloor', 'true', 'members', true],
        ['knownFloor.floor', '50000', 'members', true], // any known-floor line
        ['voucherBudget', '150000', 'members', true],
        ['memberGift', '0', 'members', true],
        ['decisions', 'false', 'members', true],
        ['shareOutside', 'false', 'members', true],
        ['recoveryCopies', 'none', 'members', true],
        ['forum', 'false', 'members', false], // everyday rows that share the Core settings card
        ['knowledge', 'false', 'members', false],
        ['knocks', 'false', 'members', false],
        ['listed', 'false', 'members', false],
    ];
    it.each(TABLE)('%s to %s (door %s): Core %s', (setting, to, door, core) => {
        expect(isCoreChange(setting, to, door)).toBe(core);
    });
});

describe('isCoreLogLine: which Changes lines are Core, by the same rule', () => {
    const by = { kept: 'community_settings_log' as const, at: '2026-11-05T11:00:00.000Z', actor: 'o'.repeat(64), actorCallsign: 'ada', actorRole: 'owner', note: null };
    const line = (id: string, setting: string, from: string | null, to: string | null): ShapeLogLine => ({ ...by, id, setting, from, to });
    const core = (log: ShapeLogLine[]) => log.map((_, i) => isCoreLogLine(log, i));

    it('a pause, and an un-pause back to the door it had, are everyday; a new door is Core', () => {
        // Newest first, as the server sends the log.
        const log = [
            line('6', 'join', 'paused', 'admins'), // un-paused to another door: Core
            line('5', 'join', 'members', 'paused'),
            line('4', 'join', 'paused', 'members'), // un-paused to the door it had
            line('3', 'join', 'members', 'paused'),
            line('2', 'join', 'admins', 'members'), // a new door
            line('1', 'beans', 'on', 'off'),
        ];
        expect(core(log)).toEqual([true, false, false, false, true, true]);
    });

    it('an un-pause whose pause is no longer in the log stays a Core line', () => {
        expect(core([line('2', 'join', 'paused', 'members')])).toEqual([true]);
    });

    it('lines of everyday settings are never Core', () => {
        expect(core([line('2', 'knocks', 'on', 'off'), line('1', 'forum', 'on', 'off')])).toEqual([false, false]);
    });
});
