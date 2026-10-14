/**
 * The host lets people in (scratch/global-node/DESIGN-global-member-privacy-fable.md §2, §7 slice 3): the form's default
 * and words, the payload, an edit of the tickbox, the member's three states, the chat entry, and the node's
 * `waiting_for_host` refusal never read as "only the host and people going".
 */
import { describe, it, expect } from 'vitest';
import {
    buildEventDraft, buildEventEditPatch, eventEditValues, hostLetsInDefault, privateNoteHelper, eventLetInState, eventLetInLine,
    eventWaitingCount, eventWaitingLine, letEveryoneInQuestion, canOpenEventChat, isWaitingForHost, eventChatWaitingText,
    hostLetsInOffWarning, eventChatSystemText, letInButtonLabel, EVENT_CHAT_OPENED_SYSTEM_TYPE,
    type EventFormInput,
} from '../events';

const now = new Date(2026, 8, 20, 8, 0);
const form = (over: Partial<EventFormInput> = {}): EventFormInput => ({
    title: 'Garden dinner', description: '', start: new Date(2026, 8, 26, 18, 0), end: null, placeName: 'Bangalow Hall',
    lat: -28.65, lng: 153.56, privateNote: 'Blue gate, code 4321', audienceGroupId: null, authorPubkey: 'me', hostLetsIn: false, ...over,
});

describe('the form', () => {
    it('ticks "Only people I let in" by default where anyone can join in a minute, and not elsewhere', () => {
        expect(hostLetsInDefault({ openMembership: true })).toBe(true);
        expect(hostLetsInDefault({})).toBe(false);
        expect(hostLetsInDefault(null)).toBe(false);
    });
    it('says who reads the note, by the tickbox and the node', () => {
        expect(privateNoteHelper(true, true)).toBe("Anyone can join this community in a minute. Only the people you let in will see this note and the event chat. You let people in from Who's going.");
        expect(privateNoteHelper(false, true)).toBe('Everyone who taps Going sees this. Anyone can join this community in a minute.');
        expect(privateNoteHelper(true, false)).toBe('Only the people you let in see this.');
        expect(privateNoteHelper(false, false)).toBe('Everyone who taps Going sees this.');
    });
    it('the payload always carries the host\'s choice', () => {
        const on = buildEventDraft(form({ hostLetsIn: true }), now);
        const off = buildEventDraft(form({ hostLetsIn: false }), now);
        expect(on.ok && on.draft.eventHostLetsIn).toBe(true);
        expect(off.ok && off.draft.eventHostLetsIn).toBe(false);
    });
    it('an edit sends the tickbox only when it changed, and silently', () => {
        const before = eventEditValues({ title: 'Garden dinner', eventStartAt: '2026-09-26T08:00:00.000Z', eventPlaceName: 'Bangalow Hall', lat: -28.65, lng: 153.56, eventHostLetsIn: true });
        expect(before.hostLetsIn).toBe(true);
        const same = buildEventEditPatch(before, { ...before }, now);
        expect(same.ok && same.patch.eventHostLetsIn).toBeUndefined();
        const off = buildEventEditPatch(before, { ...before, hostLetsIn: false }, now);
        expect(off.ok && off.patch.eventHostLetsIn).toBe(false);
        expect(off.ok && off.notifies).toBe(false);
        expect(eventEditValues({ title: 'x' }).hostLetsIn).toBe(false);
    });
    // Marty, 15 Oct (board card privacy-global-calls): a host may untick; the form says what that opens, before saving.
    it('says, before saving, that unticking opens the note and the chat so far, and only on that change', () => {
        expect(hostLetsInOffWarning(true, false)).toBe('Everyone going will see the note and the chat so far.');
        expect(hostLetsInOffWarning(true, true)).toBeNull();
        expect(hostLetsInOffWarning(false, false)).toBeNull();
        expect(hostLetsInOffWarning(false, true)).toBeNull();
    });
});

describe("the chat's line when the host opens it", () => {
    it("words the node's opened line in the app's language, and leaves any other system line as the node wrote it", () => {
        expect(EVENT_CHAT_OPENED_SYSTEM_TYPE).toBe('event_opened_to_going');
        expect(eventChatSystemText('event_opened_to_going', 'whatever the node said')).toBe('The host opened this chat to everyone going.');
        expect(eventChatSystemText(null, 'A line from the node')).toBe('A line from the node');
        expect(eventChatSystemText('something_new', 'A newer line')).toBe('A newer line');
    });
});

describe("the member's states", () => {
    const ev = { type: 'event', eventHostLetsIn: true };
    it('before Going, waiting, let in; open where the host does not let people in, and for the host', () => {
        expect(eventLetInState({ ...ev, myRsvp: null }, false)).toBe('before');
        expect(eventLetInState({ ...ev, myRsvp: 'interested', myLetIn: false }, false)).toBe('before');
        expect(eventLetInState({ ...ev, myRsvp: 'going', myLetIn: false }, false)).toBe('waiting');
        expect(eventLetInState({ ...ev, myRsvp: 'going', myLetIn: true }, false)).toBe('in');
        expect(eventLetInState({ type: 'event', myRsvp: 'going' }, false)).toBe('open');
        expect(eventLetInState({ ...ev, myRsvp: null }, true)).toBe('open');
    });
    it('the words for each', () => {
        expect(eventLetInLine('before')).toBe('The host lets people in. Tap Going, and the note and the chat open once they do.');
        expect(eventLetInLine('waiting')).toBe("You're going. The host hasn't let you in yet: the note and the chat open when they do.");
        expect(eventLetInLine('in')).toBeNull();
        expect(eventLetInLine('open')).toBeNull();
    });
    it('the chat entry: not for someone waiting, as before for everyone else', () => {
        expect(canOpenEventChat({ ...ev, myRsvp: 'going', myLetIn: false })).toBe(false);
        expect(canOpenEventChat({ ...ev, myRsvp: 'going', myLetIn: true })).toBe(true);
        expect(canOpenEventChat({ type: 'event', myRsvp: 'going' })).toBe(true);
        expect(canOpenEventChat({ ...ev, eventRsvps: [] })).toBe(true);
        expect(eventChatWaitingText()).toBe('Chat opens when the host lets you in.');
    });
    it("the node's waiting_for_host refusal is told apart from every other", () => {
        expect(isWaitingForHost(Object.assign(new Error("The host hasn't let you in yet: the chat opens when they do."), { code: 'waiting_for_host' }))).toBe(true);
        expect(isWaitingForHost(new Error('Only the host and people going can open this event chat'))).toBe(false);
        expect(isWaitingForHost(null)).toBe(false);
    });
});

describe('the host', () => {
    it('counts the people Going whom they have not let in', () => {
        const rsvps = [
            { status: 'going', letInAt: null }, { status: 'going', letInAt: '2026-10-15T00:00:00.000Z' },
            { status: 'going' }, { status: 'interested', letInAt: null },
        ];
        expect(eventWaitingCount(rsvps)).toBe(2);
        expect(eventWaitingCount(undefined)).toBe(0);
        expect(eventWaitingLine(3)).toBe('3 waiting to be let in');
        expect(letEveryoneInQuestion(23)).toBe('Let all 23 in? People who tap Going later still wait.');
        expect(letInButtonLabel(false, 'Sam')).toBe('Let Sam in');
        expect(letInButtonLabel(true, 'Fred')).toBe('Let in. Tap to take it back from Fred');
        expect(letInButtonLabel(false, undefined)).toBe('Let them in');
    });
});
