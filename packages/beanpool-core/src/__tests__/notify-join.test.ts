/**
 * The join's last screen in core (src/notify-ask.ts `notifyJoinStep`, `notifyJoinChoice`, `notifyJoinWords`;
 * DESIGN-notify-and-backup-asks-fable-amend2.md §3.4, §4.1, §4.4, slice N1j).
 *
 * One table over every state: (path) x (phone) x (record) -> does the join's screen show. Then what each answer counts,
 * and the words for each kind of join. Each row's `pins` names the guard it holds: take it away and the row goes red.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { notifyAsks, notifyJoinChoice, notifyJoinStep, notifyJoinWords, type NotifyAskRecord, type NotifyJoinPath, type NotifyPhone } from '../notify-ask.js';
import { NOTIFY_CHOICES } from '../onboarding-funnel.js';
import { localDay } from '../home-tips.js';
import { PSEUDO_LANG, setLanguage } from '../words.js';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 21, 12, 0).getTime();
const TODAY = localDay(new Date(NOW));

const PHONES: Record<string, NotifyPhone> = {
    'iPhone or Android 13+, not asked yet': { available: true, granted: false, canAskAgain: true },
    'Android 8 to 12 (on without asking)': { available: true, granted: true, canAskAgain: true },
    'allowed already': { available: true, granted: true, canAskAgain: true },
    "the phone's no, can't ask again": { available: true, granted: false, canAskAgain: false },
    'no notifications here': { available: false, granted: false, canAskAgain: false },
};
const RECORDS: Record<string, { record: NotifyAskRecord; free: boolean; pins: string }> = {
    'a new phone': { record: {}, free: true, pins: 'free day' },
    'a Later yesterday (a second community)': { record: { joinAt: NOW - DAY - 1, laterAt: NOW - DAY, askDay: localDay(new Date(NOW - DAY)), askKind: 'join' }, free: true, pins: 'Later is not final' },
    'a Later today': { record: { joinAt: NOW - 120_000, laterAt: NOW - 60_000, askDay: TODAY, askKind: 'join' }, free: false, pins: 'never twice in a day' },
    'shown today, unanswered (a join resumed on it)': { record: { joinAt: NOW - 60_000, askDay: TODAY, askKind: 'join' }, free: true, pins: 'joinUnanswered' },
    'a named line today': { record: { askDay: TODAY, askKind: 'line', lines: ['answer'] }, free: false, pins: 'one soft ask a day' },
    "a 1.4.7 'Not now' last week": { record: { state: 'declined', updatedAt: NOW - 7 * DAY }, free: true, pins: "an old 'Not now' is a Later" },
    "the phone's no, recorded": { record: { phoneNoAt: NOW - DAY }, free: false, pins: 'notifyPhoneSaidNo' },
};
const PATHS: NotifyJoinPath[] = ['invite', 'door', 'global', 'claim', 'restore'];

afterEach(() => setLanguage('en'));

describe('notifyJoinStep: (path) x (phone) x (record)', () => {
    for (const path of PATHS) {
        for (const [phoneName, phone] of Object.entries(PHONES)) {
            for (const [recName, r] of Object.entries(RECORDS)) {
                const canAsk = phone.available && !phone.granted && phone.canAskAgain;
                const expected = path !== 'restore' && canAsk && r.free;
                it(`${path} · ${phoneName} · ${recName} → ${expected ? 'shown' : 'not shown'} [${path === 'restore' ? 'restore' : canAsk ? r.pins : 'the phone'}]`, () => {
                    expect(notifyJoinStep(path, { record: r.record, phone, now: NOW })).toBe(expected);
                    // The same answer as the rule's join ask wherever a join is (one rule for both apps).
                    if (path !== 'restore') expect(notifyJoinStep(path, { record: r.record, phone, now: NOW })).toBe(notifyAsks({ record: r.record, phone, now: NOW }).join);
                });
            }
        }
    }
});

describe('notifyJoinChoice: what each way off the screen counts (N1c)', () => {
    const ROWS = [
        { outcome: 'granted', choice: 'on' },
        { outcome: 'declined', choice: 'no' },
        { outcome: 'settings', choice: 'no' },
        { outcome: 'unanswered', choice: 'later' },
        { outcome: 'later', choice: 'later' },
    ] as const;
    for (const r of ROWS) it(`${r.outcome} → ${r.choice}`, () => expect(notifyJoinChoice(r.outcome)).toBe(r.choice));
    it('every count is one the server takes', () => {
        for (const r of ROWS) expect(NOTIFY_CHOICES).toContain(notifyJoinChoice(r.outcome));
    });
});

describe('notifyJoinWords (amend2 §4.1)', () => {
    it('a community join with its inviter, by name; never "Nothing else."', () => {
        const w = notifyJoinWords({ kind: 'community', community: 'Riverside', inviter: 'Asha' });
        expect(w).toEqual({
            title: 'Hear from Riverside',
            never: 'BeanPool never emails or texts you.',
            only: 'Notifications are the only way it can reach you.',
            arrives: "When Asha writes, someone answers you, or an event you're going to changes.",
            ads: 'Never ads.',
            turnOn: 'Turn on notifications',
            confirm: 'Your phone will ask you to confirm.',
            later: 'Later',
        });
        expect(Object.values(w).join(' ')).not.toMatch(/Nothing else/);
    });
    it('no names known: your community, a neighbour; blanks count as none', () => {
        const w = notifyJoinWords({ kind: 'community', community: '  ', inviter: null });
        expect(w.title).toBe('Hear from your community');
        expect(w.arrives).toBe("When a neighbour writes, someone answers you, or an event you're going to changes.");
    });
    it('the global community and an owner each have their own line', () => {
        expect(notifyJoinWords({ kind: 'global', inviter: 'Asha' }).arrives).toBe('When someone writes to you, or a community answers your request to join.');
        expect(notifyJoinWords({ kind: 'owner', community: 'Riverside' }).arrives).toBe('When someone asks to join, a member writes, or your server needs you.');
    });
    it('every sentence through t(): the pseudo-locale marks each one', () => {
        setLanguage(PSEUDO_LANG);
        const w = notifyJoinWords({ kind: 'community', community: 'Riverside', inviter: 'Asha' });
        for (const v of Object.values(w)) expect(v).toMatch(/~/);
        expect(w.title).toContain('Riverside');
        expect(w.arrives).toContain('Asha');
    });
});
