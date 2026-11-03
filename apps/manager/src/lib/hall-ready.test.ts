import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    COPY_AMBER_AFTER_MS, DOWNLOAD_AMBER_AFTER_MS, DRILL_AMBER_AFTER_MS, HALL_KIT_PAGE, HALL_NOTES_EVENT, IMAGE_AMBER_AFTER_MS, WORDS_AMBER_AFTER_MS,
    agoWords, apkLine, codeLine, copyLine, dayWords, downloadLine, drillLine, imageLine, ownersLine, readApkState, readHallNotes, readySummary, writeHallNote,
} from './hall-ready';
import type { OwnerWordsCheck, StandbyHealthBanner, TakeoverStatus } from './node-client';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Standby = StandbyHealthBanner['standbys'][number];
const standby = (over: Partial<Standby> = {}): Standby => ({
    id: 's1', label: 'The standby at 203.0.113.9', lastPullAt: NOW - MIN, lastCopyAt: NOW - 2 * MIN, lastExactAt: NOW - 2 * MIN, healthy: true, paired: 'this', ...over,
});
const health = (...standbys: Standby[]): StandbyHealthBanner => ({ incident: null, standbys });

describe('agoWords', () => {
    it('says minutes, hours and days in plain words', () => {
        expect(agoWords(NOW - 10_000, NOW)).toBe('just now');
        expect(agoWords(NOW - MIN, NOW)).toBe('1 minute ago');
        expect(agoWords(NOW - 2 * MIN, NOW)).toBe('2 minutes ago');
        expect(agoWords(NOW - 5 * HOUR, NOW)).toBe('5 hours ago');
        expect(agoWords(NOW - 3 * DAY, NOW)).toBe('3 days ago');
    });
});

describe('the standby line: last copy, from the main server\'s standby watch (standby-health)', () => {
    it('reads the last copy off the standby: "Last copy 2 minutes ago" and ok, and names the standby so the owner can check it is the laptop', () => {
        const l = copyLine(health(standby()), true, NOW);
        expect(l.state).toBe('ok');
        expect(l.text).toBe('Last copy 2 minutes ago.');
        expect(l.hint).toBe('The standby at 203.0.113.9. Check that this is the laptop.');
    });

    it('goes amber when the newest copy is older than a day (the design\'s rule), and not before', () => {
        expect(copyLine(health(standby({ lastCopyAt: NOW - COPY_AMBER_AFTER_MS })), true, NOW).state).toBe('ok');
        const stale = copyLine(health(standby({ lastCopyAt: NOW - COPY_AMBER_AFTER_MS - MIN })), true, NOW);
        expect(stale.state).toBe('amber');
        // From a day on the line carries the day as well as the age: "24 hours ago (3 Nov 2026)".
        expect(stale.text).toMatch(/^Last copy 24 hours ago \(.+\)\.$/);
        expect(stale.hint).toMatch(/older than a day/);
    });

    it('is amber, not ok, for a standby that has never copied, and says so', () => {
        const l = copyLine(health(standby({ lastCopyAt: null })), true, NOW);
        expect(l.state).toBe('amber');
        expect(l.text).toBe('The standby has not made a copy yet.');
    });

    it('is amber with the pairing steps pointed to when no standby has ever reported', () => {
        const l = copyLine(health(), true, NOW);
        expect(l.state).toBe('amber');
        expect(l.text).toBe('No standby has copied this server yet.');
        expect(l.hint).toMatch(/steps are just below/);
    });

    it('a fresh copy from a standby that needs attention, or is paired with another server, is not a tick', () => {
        const sick = copyLine(health(standby({ healthy: false })), true, NOW);
        expect(sick.state).toBe('amber');
        expect(sick.hint).toMatch(/needs attention/);
        const other = copyLine(health(standby({ paired: 'other' })), true, NOW);
        expect(other.state).toBe('amber');
        expect(other.hint).toMatch(/not paired with this server/);
        const none = copyLine(health(standby({ paired: 'none' })), true, NOW);
        expect(none.state).toBe('amber');
    });

    it('a node from before the pairing display (no `paired`) is judged on the copy and the health alone', () => {
        const s = standby();
        delete s.paired;
        expect(copyLine(health(s), true, NOW).state).toBe('ok');
    });

    it('with several standbys, a good one speaks for the line and every standby has its own row', () => {
        const l = copyLine(health(
            standby({ id: 'old', label: 'Standby aaaaaa', lastCopyAt: NOW - 9 * DAY }),
            standby({ id: 'new', label: 'Standby bbbbbb', lastCopyAt: NOW - 3 * MIN }),
        ), true, NOW);
        expect(l.state).toBe('ok');
        expect(l.text).toBe('Last copy 3 minutes ago.');
        expect(l.rows).toHaveLength(2);
        expect(l.rows![0]).toMatch(/^Standby aaaaaa: last copy 9 days ago \(.+\)$/);
        expect(l.rows![1]).toBe('Standby bbbbbb: last copy 3 minutes ago');
    });

    it('with several standbys and none good, the freshest speaks and the line is amber', () => {
        const l = copyLine(health(
            standby({ id: 'a', label: 'Standby aaaaaa', lastCopyAt: NOW - 9 * DAY }),
            standby({ id: 'b', label: 'Standby bbbbbb', lastCopyAt: NOW - 3 * DAY }),
        ), true, NOW);
        expect(l.state).toBe('amber');
        expect(l.text).toMatch(/^Last copy 3 days ago \(.+\)\.$/);
    });

    it('is "cannot tell", never ok, for an admin (the node tells only owners) and for a node that watches no standby', () => {
        const admin = copyLine(null, false, NOW);
        expect(admin.state).toBe('unknown');
        expect(admin.text).toMatch(/Only an owner/);
        expect(copyLine(health(standby()), false, NOW).state).toBe('unknown');
        expect(copyLine(null, true, NOW).state).toBe('unknown');
        expect(copyLine(undefined, true, NOW).state).toBe('unknown');
    });
});

describe('the image line: the owner\'s note of the laptop\'s pull', () => {
    it('is amber with no note, and never ticked', () => {
        const l = imageLine({}, NOW);
        expect(l.state).toBe('amber');
        expect(l.text).toBe('Not noted yet.');
        expect(l.hint).toMatch(/docker compose pull/);
        expect(l.hint).toMatch(/docker compose up -d/);
    });
    it('tells the owner to recreate the standby after a pull: a pull alone leaves it on the old image and its copies stop', () => {
        const old = imageLine({ imagePulledAt: NOW - IMAGE_AMBER_AFTER_MS - MIN }, NOW);
        expect(old.hint).toMatch(/docker compose pull and then docker compose up -d/);
    });
    it('is ok within 60 days, amber after, and names the date as the owner\'s own note', () => {
        const ok = imageLine({ imagePulledAt: NOW - IMAGE_AMBER_AFTER_MS }, NOW);
        expect(ok.state).toBe('ok');
        expect(ok.text).toMatch(/as you noted in this browser/);
        expect(imageLine({ imagePulledAt: NOW - IMAGE_AMBER_AFTER_MS - MIN }, NOW).state).toBe('amber');
        expect(imageLine({ imagePulledAt: NOW - 3 * DAY }, NOW).state).toBe('ok');
    });
});

describe('the recovery code line: its number and date', () => {
    const status = (over: Partial<TakeoverStatus> = {}): TakeoverStatus => ({
        state: 'sealed', message: 'ok', envelopeId: 'e1', sealedAt: null, sealReason: null,
        recipients: { owners: [], codes: [] }, skippedOwners: [], recoveryCode: { codeId: 3, createdAt: '2026-10-02T09:00:00.000Z' }, ...over,
    });
    it('shows the code\'s number and the day it was made, ok, and says the server cannot see paper', () => {
        const l = codeLine(status());
        expect(l.state).toBe('ok');
        expect(l.text).toMatch(/^Recovery code #3, made /);
        expect(l.hint).toMatch(/cannot see paper/);
    });
    it('is amber with no code made', () => {
        const l = codeLine(status({ recoveryCode: null }));
        expect(l.state).toBe('amber');
        expect(l.text).toBe('No recovery code made yet.');
    });
    it('is amber for a code spent in a take-over, naming it', () => {
        const l = codeLine(status({ codeUsed: { codeId: 3, at: '2026-10-20T00:00:00.000Z', message: 'used' } }));
        expect(l.state).toBe('amber');
        expect(l.text).toMatch(/#3 was used/);
    });
    it('is "cannot tell" when the node could not be read', () => {
        expect(codeLine(null).state).toBe('unknown');
    });
});

describe('the owners line: a second owner, and each owner\'s 12 words checked', () => {
    const owner = (callsign: string, checked: number | null): OwnerWordsCheck => ({ pubkey: callsign, callsign, wordsCheckedAt: checked });
    it('is ok when two owners have both checked in the last year', () => {
        const l = ownersLine([owner('a', NOW - DAY), owner('b', NOW - 300 * DAY)], NOW);
        expect(l.state).toBe('ok');
        // With its date: the oldest check any owner reported.
        expect(l.text).toBe(`2 of 2 owners checked their 12 words in the last year. The oldest check: ${dayWords(NOW - 300 * DAY)}.`);
    });
    it('is amber for one owner only, even if they have checked', () => {
        const l = ownersLine([owner('a', NOW - DAY)], NOW);
        expect(l.state).toBe('amber');
        expect(l.text).toMatch(/^Only one owner\. 1 of 1 owner checked/);
        expect(l.hint).toMatch(/second owner/);
    });
    it('is amber when an owner has not checked, or checked more than a year ago', () => {
        expect(ownersLine([owner('a', NOW - DAY), owner('b', null)], NOW).state).toBe('amber');
        const old = ownersLine([owner('a', NOW - DAY), owner('b', NOW - WORDS_AMBER_AFTER_MS - MIN)], NOW);
        expect(old.state).toBe('amber');
        expect(old.text).toBe(`1 of 2 owners checked their 12 words in the last year. The oldest check: ${dayWords(NOW - WORDS_AMBER_AFTER_MS - MIN)}.`);
        // Nobody has checked: no date to give.
        expect(ownersLine([owner('a', null), owner('b', null)], NOW).text).toBe('0 of 2 owners checked their 12 words in the last year.');
    });
    it('is amber with no owner, and "cannot tell" when unread', () => {
        expect(ownersLine([], NOW).state).toBe('amber');
        expect(ownersLine(null, NOW).state).toBe('unknown');
    });
});

describe('the download line: the last locked file downloaded in this browser', () => {
    it('is amber with none, ok within 35 days, amber after', () => {
        expect(downloadLine({}, NOW).state).toBe('amber');
        expect(downloadLine({ downloadedAt: NOW - DOWNLOAD_AMBER_AFTER_MS }, NOW).state).toBe('ok');
        const late = downloadLine({ downloadedAt: NOW - DOWNLOAD_AMBER_AFTER_MS - MIN }, NOW);
        expect(late.state).toBe('amber');
        expect(late.hint).toMatch(/each month/);
    });
    it('says it is this browser\'s download, and that where the file went is not seen', () => {
        const l = downloadLine({ downloadedAt: NOW - DAY }, NOW);
        expect(l.text).toMatch(/^Last locked file downloaded in this browser /);
        expect(l.hint).toMatch(/cannot see where the file went/);
    });
    it('a file downloaded with no recovery code (unlocked, no keys) is never the locked file: amber, and says what to do', () => {
        const l = downloadLine({ downloadedPlainAt: NOW - DAY }, NOW);
        expect(l.state).toBe('amber');
        expect(l.text).toMatch(/was not locked, so it holds no keys/);
        expect(l.hint).toMatch(/Make a recovery code/);
    });
    it('a newer unlocked file does not hide an earlier locked one, and a locked one wins', () => {
        const l = downloadLine({ downloadedAt: NOW - 3 * DAY, downloadedPlainAt: NOW - MIN }, NOW);
        expect(l.state).toBe('ok');
        expect(l.text).toMatch(/\(3 days ago\)/);
    });
});

describe('the APK line: the apk-on-node lane\'s state', () => {
    it('says the APK is not on this node yet, amber, until the node says anything: never a false tick', () => {
        for (const nothing of [undefined, null, {}, 'yes', 7, { version: 'latest' }, { version: '' }, { version: 12 }, { version: '1.2' }]) {
            const l = apkLine(nothing);
            expect(l.state, JSON.stringify(nothing)).toBe('amber');
            expect(l.text).toBe('The APK is not on this node yet.');
        }
    });
    it('is ok, with its version, once the node carries one', () => {
        const l = apkLine({ version: '1.2.96', versionCode: 318, size: 168_000_000 });
        expect(l.state).toBe('ok');
        expect(l.text).toMatch(/Version 1\.2\.96 is on this node/);
    });
    it('reads only what it understands of the node\'s state', () => {
        expect(readApkState({ version: '1.2.96', versionCode: 'x', size: Infinity, extra: 1 })).toEqual({ version: '1.2.96' });
    });
});

describe('the drill line: the switch tried once with the internet unplugged', () => {
    it('is amber when never tried, ok within half a year, amber after', () => {
        expect(drillLine({}, NOW).state).toBe('amber');
        expect(drillLine({ drillAt: NOW - DAY }, NOW).state).toBe('ok');
        expect(drillLine({ drillAt: NOW - DRILL_AMBER_AFTER_MS }, NOW).state).toBe('ok');
        expect(drillLine({ drillAt: NOW - DRILL_AMBER_AFTER_MS - MIN }, NOW).state).toBe('amber');
    });
});

describe('readySummary', () => {
    it('counts ok lines only: amber and unknown are not ready', () => {
        const ok = imageLine({ imagePulledAt: NOW }, NOW);
        const lines = [ok, imageLine({}, NOW), copyLine(null, false, NOW)];
        expect(readySummary(lines)).toEqual({ ready: 1, total: 3 });
    });
});

describe('the owner\'s notes: this browser only, never believed past reason', () => {
    beforeEach(() => localStorage.clear());

    it('keeps a note per node, and reads it back', () => {
        writeHallNote('n1', 'drillAt', NOW - DAY, NOW);
        expect(readHallNotes('n1', NOW)).toEqual({ drillAt: NOW - DAY });
        expect(readHallNotes('n2', NOW)).toEqual({});
    });
    it('keeps the other notes when one changes, and removes the entry when the last is cleared', () => {
        writeHallNote('n1', 'drillAt', NOW - DAY, NOW);
        writeHallNote('n1', 'imagePulledAt', NOW - 2 * DAY, NOW);
        expect(readHallNotes('n1', NOW)).toEqual({ drillAt: NOW - DAY, imagePulledAt: NOW - 2 * DAY });
        writeHallNote('n1', 'drillAt', null, NOW);
        writeHallNote('n1', 'imagePulledAt', null, NOW);
        expect(readHallNotes('n1', NOW)).toEqual({});
        expect(localStorage.getItem('bp_hall_ready:n1')).toBeNull();
    });
    it('ignores a time that cannot be right: junk, before 2020, or more than a day ahead', () => {
        localStorage.setItem('bp_hall_ready:n1', JSON.stringify({ drillAt: 'yesterday', imagePulledAt: 5, downloadedAt: NOW + 3 * DAY, downloadedPlainAt: -1 }));
        expect(readHallNotes('n1', NOW)).toEqual({});
        localStorage.setItem('bp_hall_ready:n1', 'not json');
        expect(readHallNotes('n1', NOW)).toEqual({});
        localStorage.setItem('bp_hall_ready:n1', 'null');
        expect(readHallNotes('n1', NOW)).toEqual({});
    });
    it('tells the page when a note is written, so a card on screen reads it again', () => {
        const heard = vi.fn();
        window.addEventListener(HALL_NOTES_EVENT, heard);
        writeHallNote('n1', 'downloadedAt', NOW, NOW);
        window.removeEventListener(HALL_NOTES_EVENT, heard);
        expect(heard).toHaveBeenCalledTimes(1);
        expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({ nodeId: 'n1' });
    });
    it('keeps working when storage refuses (a private window): nothing throws and the note is kept for the call', () => {
        const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
        const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
        expect(readHallNotes('n1', NOW)).toEqual({});
        expect(() => writeHallNote('n1', 'drillAt', NOW, NOW)).not.toThrow();
        expect(writeHallNote('n1', 'drillAt', NOW, NOW)).toEqual({ drillAt: NOW });
        get.mockRestore();
        set.mockRestore();
    });
});

describe('the kit page link', () => {
    it('is the operator page H0 plans, "Before the lights go out"', () => {
        expect(HALL_KIT_PAGE).toBe('before-the-lights-go-out');
    });
});
