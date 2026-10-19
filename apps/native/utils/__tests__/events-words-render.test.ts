// @vitest-environment jsdom
/**
 * An event in the member's language (words slice S3, sweep B11): its page (components/EventDetail.tsx) with what it draws
 * (Share, Add to calendar and Remind me: components/EventExtras.tsx; the report box), and the form that makes, copies and
 * edits one (components/NewEventModal.tsx, with its address search, components/AddressSearch.tsx), drawn for real inside
 * the real LanguageProvider. React Native's host components are plain tags (profile-events-words-harness.ts); the node,
 * the map, the date pickers, the camera roll and the phone's location are stubbed at their modules.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any text, screen-reader label, hint,
 * placeholder or alert with letters outside a bracket bypassed t(). Dates and times are core's formatDate (bracketed in
 * xx too). What members wrote is shown as written: an event's title and text, its place, names, a group's name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
const links = vi.hoisted(() => ({ fail: false }));
vi.mock('react-native', async () => {
    const native = (await import('./profile-events-words-harness')).nativeMock(alerts);
    return { ...native, Linking: { ...native.Linking, openURL: async () => { if (links.fail) throw new Error('no app'); }, openSettings: async () => {} } };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    return { KeyboardAvoidingView: ({ children }: { children?: unknown }) => h('div', null, children as any) };
});
vi.mock('expo-router', () => ({ router: { canGoBack: () => true, back: () => {}, replace: () => {}, push: () => {} }, ErrorBoundary: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@react-native-community/datetimepicker', () => ({ default: () => null }));
vi.mock('react-native-maps', () => ({ default: () => null, Marker: () => null, PROVIDER_DEFAULT: 'default' }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: async () => ({ status: 'denied', canAskAgain: false }),
    requestForegroundPermissionsAsync: async () => ({ status: 'denied' }),
    getLastKnownPositionAsync: async () => null,
    getCurrentPositionAsync: async () => { throw new Error('off'); },
}));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: async () => { throw new Error(''); } }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: async () => ({}), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-1' }));
vi.mock('expo-image', async () => {
    const { createElement: h } = await import('react');
    return { Image: (p: { accessibilityLabel?: string }) => h('img', p.accessibilityLabel ? { 'aria-label': p.accessibilityLabel } : {}) };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.2.70' } } }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/', writeAsStringAsync: async () => {}, EncodingType: { UTF8: 'utf8' } }));
vi.mock('expo-sharing', () => ({ shareAsync: async () => {} }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});
const ME = '9'.repeat(64);
const HOST = '7'.repeat(64);
const who = vi.hoisted(() => ({ value: { identity: { publicKey: '9'.repeat(64), privateKey: '8'.repeat(64), callsign: 'Wren' } } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who.value }));
const node = vi.hoisted(() => ({
    view: null as any, rsvpError: null as null | Error, deleteError: null as null | Error, deleted: [] as string[], groups: [] as unknown[],
    reminders: [] as unknown[], reminderError: null as null | Error, reportError: null as null | Error,
}));
vi.mock('../db', async () => {
    const { UNSIGNABLE_RSVP_MESSAGE } = await import('../events');
    return {
        fetchEventDetail: async () => node.view,
        rsvpEvent: async (_id: string, next: string | null) => {
            if (node.rsvpError) throw node.rsvpError;
            node.view = { ...node.view, myRsvp: next };
            return { success: true, post: node.view };
        },
        deletePost: async (id: string) => { if (node.deleteError) throw node.deleteError; node.deleted.push(id); node.view = { ...node.view, status: 'cancelled', eventState: 'cancelled' }; },
        reportAbuse: async () => { if (node.reportError) throw node.reportError; return { ok: true }; },
        letInToEvent: async () => ({ success: true, post: node.view }),
        fetchMemberPreferences: async () => ({}),
        fetchMyEvents: async () => node.reminders,
        setEventReminder: async () => { throw node.reminderError ?? new Error(''); },
        isRouteMissing: () => false,
        createPost: async () => ({}),
        updateEvent: async () => node.view,
        fetchEventZone: async () => null,
        fetchEventZones: async () => [],
        fetchGroups: async () => node.groups,
        getBalance: async () => null,
        getTreasuries: async () => [],
        UNSIGNABLE: UNSIGNABLE_RSVP_MESSAGE,
    };
});
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', checkedAt: '2026-10-19T00:00:00.000Z', features: { beans: true, onlineEvents: true } }) }));
vi.mock('../maps', () => ({ HAS_MAPS_KEY: false }));
vi.mock('../reads-own', () => ({ readsOwn: async () => false }));
vi.mock('../haptics', () => ({ hapticTick: () => {} }));
vi.mock('../../components/EventCard', () => ({ EVENT_ACCENT: '#7c3aed' }));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: () => null }));
// The next dates of a repeating event are their own sweep's; none here repeats.
vi.mock('../../components/EventNextDates', () => ({ EventNextDates: () => null }));

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider, DrawnInLanguage } from '../../components/LanguageProvider';
import { LanguagePickerSheet } from '../../components/LanguagePicker';
import { EventDetail } from '../../components/EventDetail';
import { NewEventModal } from '../../components/NewEventModal';
import { reminderChoiceWords } from '../../components/EventExtras';
import { formatReminderChoice } from '../event-extras';
import { UNSIGNABLE_RSVP_MESSAGE } from '../events';
import { eventLineWords } from '../../components/event-lines';
import { bypassing, bracketed, unfit } from './profile-events-words-harness';

/** What members wrote: the event's title, text, place and note, names, a group's name. */
const MEMBERS = ['Garden dinner', 'Bring a plate', 'Bangalow Hall', 'Hana', 'Sam', 'Tia', 'Seed Savers', 'Blue gate, number 12', 'Wren'];
const DAY = 86_400_000;
const base = {
    id: '11111111-2222-4333-8444-555555555555', type: 'event', title: 'Garden dinner', description: 'Bring a plate',
    author_pubkey: HOST, authorPublicKey: HOST, authorCallsign: 'Hana',
    eventStartAt: new Date(Date.now() + 2 * DAY).toISOString(), eventEndAt: new Date(Date.now() + 2 * DAY + 3 * 3_600_000).toISOString(),
    eventPlaceName: 'Bangalow Hall', lat: -28.6871, lng: 153.5243, photos: [], goingCount: 3, interestedCount: 1,
};
const RSVPS = [
    { memberPubkey: '1'.repeat(64), memberCallsign: 'Sam', status: 'going', updatedAt: '2026-10-15T00:00:00.000Z' },
    { memberPubkey: '2'.repeat(64), memberCallsign: 'Tia', status: 'interested', updatedAt: '2026-10-15T00:00:00.000Z' },
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.buttons = [];
    links.fail = false;
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://mullum.example');
    node.view = null;
    node.rsvpError = null;
    node.deleteError = null;
    node.deleted.length = 0;
    node.groups = [];
    node.reminders = [];
    node.reminderError = null;
    node.reportError = null;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function renderIn(lang: UiLang, element: unknown) {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, element as any) as any); });
    await settle();
}
const xx = (s: string) => pseudoLocalise(s);
const byLabel = (shown: string) => host.querySelector(`[aria-label="${shown.replace(/"/g, '\\"')}"]`);
const click = async (el: Element | null | undefined, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(6);
};
const type = async (el: Element | null | undefined, text: string) => {
    expect(el).toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el as HTMLInputElement, text);
        (el as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
};
const pressAlert = async (english: string) => {
    const b = alerts.buttons.find((x) => x.text === xx(english));
    expect(b, english).toBeTruthy();
    await act(async () => { await b!.onPress?.(); });
    await settle();
};
const said = () => alerts.said;
const byText = (shown: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === shown) ?? null;

describe('an event\'s page in the pseudo-locale: every word came through t() (words S3l)', () => {
    it('a member: the header, the date, the counts, Going and Interested, the place, the host line, Share, Add to calendar, Report', async () => {
        node.view = { ...base, myRsvp: null };
        await renderIn('xx', createElement(EventDetail, { post: base }));
        expect(host.textContent).toContain(xx('EVENT'));
        expect(host.textContent).toContain(xx('{going} going · {interested} interested').replace('{going}', '3').replace('{interested}', '1'));
        expect(host.textContent).toContain(xx('Going'));
        expect(host.textContent).toContain(xx('Show on map'));
        expect(byLabel(xx('Show {place} on a map').replace('{place}', 'Bangalow Hall'))).not.toBeNull();
        expect(host.textContent).toContain(xx('Hosted by {name}').replace('{name}', 'Hana'));
        expect(host.textContent).toContain(xx('🔗 Share'));
        expect(host.textContent).toContain(xx('📅 Add to calendar'));
        expect(host.textContent).toContain(xx('🚩 Report event'));
        expect(bracketed(host)).toBeGreaterThan(5);
        expect(bypassing(host, MEMBERS, said())).toEqual([]);
    });

    it('Going: the button\'s selected label, the reminder line and its choices; a reminder the node didn\'t save', async () => {
        node.view = { ...base, myRsvp: null };
        await renderIn('xx', createElement(EventDetail, { post: base }));
        await click(byLabel(xx('Going')), 'Going');
        expect(byLabel(xx('{label}, selected. Tap to clear').replace('{label}', xx('Going')))).not.toBeNull();
        expect(host.textContent).toContain(xx('{label} ✓').replace('{label}', xx('Going')));
        // "⏰ Remind me: {choice}" with the choice in bold inside it, and the choice its own whole sentence.
        const line = xx('⏰ Remind me: {choice}').split('{choice}');
        expect(host.textContent).toContain(`${line[0]}${xx('{choice} (your default)').replace('{choice}', xx('1 day before'))}${line[1]}`);
        expect(bypassing(host, MEMBERS, said())).toEqual([]);
        await click(byLabel(xx('Change the reminder for this event')), 'Change');
        expect(host.textContent).toContain(xx('Tell me before it starts. With none ticked you get no reminder for this event.'));
        for (const english of ['1 week before', '1 day before', '2 hours before', '1 hour before', '30 minutes before']) expect(byLabel(xx(english)), english).not.toBeNull();
        expect(host.textContent).toContain(xx('Save for this event'));
        expect(bypassing(host, MEMBERS, said())).toEqual([]);
        await click(byLabel(xx('Save for this event')), 'Save');
        expect(said()).toEqual([xx('Reminder not saved'), xx('Could not reach the node.')]);
        expect(bypassing(host, MEMBERS, said())).toEqual([]);
    });

    it("a reminder the phone couldn't send: setEventReminder's own sentences in the member's language", async () => {
        node.view = { ...base, myRsvp: 'going' };
        for (const english of ['You are currently offline.', 'No identity found.', 'Could not save your reminder']) {
            node.reminderError = new Error(english);
            alerts.said.length = 0;
            await renderIn('xx', createElement(EventDetail, { post: base }));
            await click(byLabel(xx('Change the reminder for this event')), 'Change');
            await click(byLabel(xx('Save for this event')), 'Save');
            expect(said(), english).toEqual([xx('Reminder not saved'), xx(english)]);
            expect(bypassing(host, MEMBERS, said())).toEqual([]);
            act(() => root.unmount());
            root = createRoot(host);
        }
    });

    it('the alerts: an RSVP the phone wouldn\'t sign, sharing and the calendar out of reach, a report', async () => {
        node.view = { ...base, myRsvp: null };
        node.rsvpError = new Error(UNSIGNABLE_RSVP_MESSAGE);
        await renderIn('xx', createElement(EventDetail, { post: base }));
        await click(byLabel(xx('Interested')), 'Interested');
        expect(said()).toEqual([xx('RSVP not saved'), xx("This event's id isn't one BeanPool recognises, so your answer wasn't signed or sent.")]);
        alerts.said.length = 0;
        store.map.clear();
        await click(byLabel(xx('Share this event')), 'Share');
        expect(said()).toEqual([xx('Not shared'), xx('You are currently offline.')]);
        alerts.said.length = 0;
        store.map.set('beanpool_anchor_url', 'https://mullum.example');
        links.fail = true;
        await click(byLabel(xx('Add this event to your calendar')), 'Calendar');
        expect(said()).toEqual([xx('No calendar app'), xx('Nothing on this phone could open a calendar entry.')]);
        alerts.said.length = 0;
        await click(byLabel(xx('Show {place} on a map').replace('{place}', 'Bangalow Hall')), 'Show on map');
        expect(said()).toEqual([xx('No maps app'), xx('The event is at {lat}, {lng}.').replace('{lat}', '-28.68710').replace('{lng}', '153.52430')]);
        alerts.said.length = 0;
        await click(byLabel(xx('Report event')), 'Report');
        expect(host.textContent).toContain(xx('WHY ARE YOU REPORTING IT?'));
        expect(bypassing(host, MEMBERS, said())).toEqual([]);
    });

    it("a report the phone couldn't send: _signedRequest's sentences in the member's language, the node's words as given", async () => {
        node.view = { ...base, myRsvp: null };
        const cases: Array<[Error, string]> = [
            [new Error('You are off-grid. Please connect to a BeanPool Node to perform this action.'), xx('You are off-grid. Please connect to a BeanPool Node to perform this action.')],
            [new Error('No identity found. You must be logged in.'), xx('No identity found. You must be logged in.')],
            [new Error('Server returned 502'), xx('Server returned {status}').replace('{status}', '502')],
            [new Error('This event was already reported by you.'), 'This event was already reported by you.'],
        ];
        for (const [error, body] of cases) {
            node.reportError = error;
            alerts.said.length = 0;
            await renderIn('xx', createElement(EventDetail, { post: base }));
            await click(byLabel(xx('Report event')), 'Report');
            await click(byText(xx('Spam or scam')), 'Spam or scam');
            await click(byText(xx('Submit report')), 'Submit report');
            expect(said(), error.message).toEqual([xx('Not sent'), body]);
            expect(bypassing(host, MEMBERS, said().slice(0, -1))).toEqual([]);
            act(() => root.unmount());
            root = createRoot(host);
        }
    });

    it("the phone's own refusals in the member's language: an RSVP with no community set, a cancel that never reached the node", async () => {
        node.view = { ...base, myRsvp: null };
        node.rsvpError = new Error('You are currently offline.');
        await renderIn('xx', createElement(EventDetail, { post: base }));
        await click(byLabel(xx('Interested')), 'Interested');
        expect(said()).toEqual([xx('RSVP not saved'), xx('You are currently offline.')]);
        act(() => root.unmount());
        root = createRoot(host);
        alerts.said.length = 0;
        node.view = { ...base, author_pubkey: ME, authorPublicKey: ME, authorCallsign: 'Wren', eventRsvps: RSVPS };
        node.deleteError = new Error('Offline or anchor node unreachable: Failed to remove post on Node');
        await renderIn('xx', createElement(EventDetail, { post: { ...base, author_pubkey: ME, authorPublicKey: ME } }));
        await click(byLabel(xx('Cancel event')), 'Cancel event');
        alerts.said.length = 0;
        await pressAlert('Cancel event');
        expect(node.deleted).toEqual([]);
        expect(said()).toEqual([xx('Not cancelled'), xx('Offline or anchor node unreachable: {reason}').replace('{reason}', xx('Failed to remove post on Node'))]);
        expect(bypassing(host, MEMBERS, said())).toEqual([]);
    });

    it("the refusals are utils/db.ts's, as rsvpEvent, deletePost, letInToEvent and setEventReminder throw them; a node's words as given", () => {
        const db = fs.readFileSync(path.resolve(__dirname, '../db.ts'), 'utf8');
        const body = (start: string) => {
            const at = db.indexOf(start);
            expect(at, start).toBeGreaterThan(-1);
            return db.slice(at, db.indexOf('\n}\n', at));
        };
        // Every fixed sentence each one throws, or falls back to when the node's refusal has no words: a new one fails here.
        const thrown = (src: string) => [...src.matchAll(/(?:new Error\(|errMsg = |errorMsg = |message = |\|\| )'([^']+)'/g)].map((m) => m[1]);
        const rsvp = body('export async function rsvpEvent(');
        const remove = body('export async function deletePost(');
        const signed = body('async function _signedRequest(');
        const reminder = body('export async function setEventReminder(');
        expect(rsvp).toContain('throw new Error(UNSIGNABLE_RSVP_MESSAGE)');
        expect(thrown(rsvp)).toEqual(['You are currently offline.', 'No identity found.', 'Could not save your RSVP']);
        expect(thrown(remove)).toEqual(['Action requires internet connection.', 'Not logged in. Identity required.', 'Failed to remove post on Node']);
        expect(remove).toContain('throw new Error(`Offline or anchor node unreachable: ${e.message}`)');
        expect(thrown(signed)).toEqual(['You are off-grid. Please connect to a BeanPool Node to perform this action.', 'No identity found. You must be logged in.', 'Network request failed. You must be connected to a node.']);
        expect(signed).toContain('`Server returned ${res.status}`');
        expect(thrown(reminder)).toEqual(['You are currently offline.', 'No identity found.', 'Could not save your reminder']);
        const fixed = [UNSIGNABLE_RSVP_MESSAGE as string, ...thrown(rsvp), ...thrown(remove), ...thrown(signed), ...thrown(reminder)];
        const filled = ['Offline or anchor node unreachable: Failed to remove post on Node', 'Server returned 502'];
        for (const s of [...fixed, ...filled]) expect(eventLineWords(s), s).toBe(s);
        setLanguage('xx');
        for (const s of fixed) expect(eventLineWords(s), s).toBe(xx(s));
        expect(eventLineWords(filled[0])).toBe(xx('Offline or anchor node unreachable: {reason}').replace('{reason}', xx('Failed to remove post on Node')));
        expect(eventLineWords(filled[1])).toBe(xx('Server returned {status}').replace('{status}', '502'));
        // A node's own words, or the platform's, exactly as given (slice S4); inside db.ts's sentence, that sentence is worded.
        expect(eventLineWords('Only the host can cancel this event.')).toBe('Only the host can cancel this event.');
        expect(eventLineWords('Offline or anchor node unreachable: Network request failed'))
            .toBe(xx('Offline or anchor node unreachable: {reason}').replace('{reason}', 'Network request failed'));
        setLanguage('en');
    });

    it('the host: who\'s going, the group-only line, edit, copy and cancel, and the cancel\'s questions and answer', async () => {
        node.view = { ...base, author_pubkey: ME, authorPublicKey: ME, authorCallsign: 'Wren', eventRsvps: RSVPS, eventPrivateNote: 'Blue gate, number 12',
            audienceScope: 'group', targetGroupName: 'Seed Savers' };
        await renderIn('xx', createElement(EventDetail, { post: { ...base, author_pubkey: ME, authorPublicKey: ME } }));
        expect(host.textContent).toContain(xx("You're hosting this event"));
        expect(host.textContent).toContain(xx('NOTE FOR PEOPLE WHO ARE GOING'));
        expect(host.textContent).toContain(xx('Hosted by {name} · 🔒 only {group} can see this').replace('{name}', 'Wren').replace('{group}', 'Seed Savers'));
        expect(byLabel(xx("Who's going, {n} replies").replace('{n}', '2'))).not.toBeNull();
        await click(byLabel(xx("Who's going, {n} replies").replace('{n}', '2')), "Who's going");
        expect(host.textContent).toContain(xx("Who's going ({n})").replace('{n}', '2'));
        expect(host.textContent).toContain(xx('Interested'));
        expect(host.textContent).toContain(xx('Edit event'));
        expect(host.textContent).toContain(xx('Copy to a new date'));
        expect(bypassing(host, MEMBERS, said())).toEqual([]);
        await click(byLabel(xx('Cancel event')), 'Cancel event');
        expect(said()).toEqual([xx('Cancel this event?'), xx('It leaves the feed and shows CANCELLED to anyone who opens it. This cannot be undone.'), xx('Keep event'), xx('Cancel event')]);
        alerts.said.length = 0;
        await pressAlert('Cancel event');
        expect(node.deleted).toEqual([base.id]);
        expect(said()).toEqual([xx('Event cancelled'), xx('It now shows CANCELLED, and everyone going has been told.')]);
        expect(host.textContent).toContain(xx('CANCELLED'));
        expect(host.textContent).toContain(xx('This event was cancelled, so it can no longer be edited.'));
        expect(bypassing(host, MEMBERS, said())).toEqual([]);
    });

    it('the host\'s Edit opens the form in edit mode: its header, the audience line, Save', async () => {
        node.view = { ...base, author_pubkey: ME, authorPublicKey: ME, eventRsvps: [] };
        await renderIn('xx', createElement(EventDetail, { post: { ...base, author_pubkey: ME, authorPublicKey: ME } }));
        await click(byLabel(xx('Edit event')), 'Edit event');
        const modal = host.querySelector('[data-modal]')!;
        expect(modal.textContent).toContain(xx('Edit Event'));
        expect(modal.textContent).toContain(xx('{audience} Who can see it and who hosts it stay as they are.').replace('{audience}', xx('This community.')));
        expect(byLabel(xx('Save changes'))).not.toBeNull();
        expect(byLabel(xx('{label}: {value}. Change').replace('{label}', xx('STARTS *')).split('{value}')[0])).toBeNull();
        expect(bypassing(host, MEMBERS, said())).toEqual([]);
    });

    it('the host\'s Copy opens the form as a copy: its header and note', async () => {
        node.view = { ...base, author_pubkey: ME, authorPublicKey: ME, eventRsvps: [] };
        await renderIn('xx', createElement(EventDetail, { post: { ...base, author_pubkey: ME, authorPublicKey: ME } }));
        await click(byLabel(xx('Copy to a new date')), 'Copy');
        const modal = host.querySelector('[data-modal]')!;
        expect(modal.textContent).toContain(xx('Copy Event'));
        expect(modal.textContent).toContain(xx('Copied from your last one. Pick the new date and time. The photo is not copied — add one again if you want.'));
        expect(bypassing(host, MEMBERS, said())).toEqual([]);
    });

    it('an event that has ended', async () => {
        const past = { ...base, eventStartAt: new Date(Date.now() - 2 * DAY).toISOString(), eventEndAt: new Date(Date.now() - 2 * DAY + 3_600_000).toISOString() };
        node.view = { ...past, myRsvp: 'going' };
        await renderIn('xx', createElement(EventDetail, { post: past }));
        expect(host.textContent).toContain(xx('This event has ended.'));
        expect(bypassing(host, MEMBERS, said())).toEqual([]);
    });
});

describe('the event form in the pseudo-locale', () => {
    it('a new event: every label, placeholder and button; its refusals; the location and photo alerts', async () => {
        node.groups = [{ id: 'g1', name: 'Seed Savers', viewerRole: 'convenor', viewerStatus: 'active' }];
        await renderIn('xx', createElement(NewEventModal, { visible: true, onClose() {} }));
        for (const english of ['New Event', 'TITLE *', 'STARTS *', 'ENDS (OPTIONAL)', 'Pick a date and time', '2 hours after start if blank', 'WHERE', 'At a place',
            'PLACE NAME *', 'FIND AN ADDRESS', 'PIN ON THE MAP *', 'The map is not available in this build. Use your location.', 'Tap the map to place the pin.',
            '📍 Use my location', "Anyone who opens this node's map will see this spot.", 'Approximate (~100 m)', 'DESCRIPTION', 'PHOTO (OPTIONAL)', '📷 Add a photo',
            'NOTE FOR PEOPLE WHO ARE GOING', 'POST AS', 'WHO CAN SEE IT', 'This community', 'Addresses from OpenStreetMap. What you type here is sent to them.']) {
            expect(host.textContent, english).toContain(xx(english));
        }
        for (const english of ['e.g. Working bee at the hall', 'e.g. The old bowls club', 'What is happening, and who is it for?', 'Gate code, parking, what to bring', 'Street and town, or a place']) {
            expect(host.querySelector(`[placeholder="${xx(english)}"]`), english).not.toBeNull();
        }
        expect(byLabel(xx('Publishes your new event to the Market feed')) ?? host.querySelector(`[data-hint="${xx('Publishes your new event to the Market feed')}"]`)).not.toBeNull();
        expect(bypassing(host, MEMBERS, said())).toEqual([]);

        await click(byLabel(xx('Create event')), 'Create');
        expect(said()).toEqual([xx('Almost there'), xx('Give the event a title.')]);
        alerts.said.length = 0;
        await type(byLabel(xx('Event title')), 'Garden dinner');
        await click(byLabel(xx('Create event')), 'Create');
        expect(said()).toEqual([xx('Almost there'), xx('Pick when the event starts.')]);
        alerts.said.length = 0;
        await click(byLabel(xx('Use my location for the pin')), 'Use my location');
        expect(said()).toEqual([xx('Location is off'), xx('Allow location in settings, or tap the map to place the pin.'), xx('Cancel'), xx('Open Settings')]);
        alerts.said.length = 0;
        await click(byLabel(xx('Add a photo')), 'Add a photo');
        expect(said()).toEqual([xx('Photo not added'), xx('Could not open your photos.')]);
        alerts.said.length = 0;
        // Post as the group: who can see it, said for the group.
        await click(byLabel('Seed Savers'), 'Post as Seed Savers');
        expect(host.textContent).toContain(xx('🔒 Only {name} members, because the group is hosting.').replace('{name}', 'Seed Savers'));
        await click(byLabel(xx('Online')), 'Online');
        expect(host.textContent).toContain(xx('LINK TO JOIN'));
        expect(bypassing(host, [...MEMBERS, 'https://'], said())).toEqual([]);
    });

    it('the reminder choice reads as utils/event-extras.ts writes it, for every set of offsets', () => {
        const sets: Array<number[] | null> = [null, [], [1440], [10080, 120], [10080, 1440, 30], [10080, 1440, 120, 60, 30], [45]];
        for (const offsets of sets) {
            expect(reminderChoiceWords(offsets, [1440]), JSON.stringify(offsets)).toBe(formatReminderChoice(offsets, [1440]));
            expect(reminderChoiceWords(offsets, []), JSON.stringify(offsets)).toBe(formatReminderChoice(offsets, []));
        }
        setLanguage('xx');
        expect(reminderChoiceWords([10080, 1440, 30], [1440])).toMatch(/^\[.*\]$/s);
    });
});

describe('in English nothing is bracketed, and the words are as they were', () => {
    it('the event\'s page and the form', async () => {
        node.view = { ...base, myRsvp: 'going' };
        await renderIn('en', createElement(EventDetail, { post: base }));
        expect(bracketed(host)).toBe(0);
        for (const english of ['EVENT', '3 going · 1 interested', 'Going ✓', 'Interested', '⏰ Remind me: 1 day before (your default)', '🔗 Share', '📅 Add to calendar',
            'Show on map', 'Hosted by Hana', '🚩 Report event']) {
            expect(host.textContent, english).toContain(english);
        }
        act(() => root.unmount());
        root = createRoot(host);
        await renderIn('en', createElement(NewEventModal, { visible: true, onClose() {} }));
        expect(bracketed(host)).toBe(0);
        for (const english of ['New Event', 'TITLE *', 'Pick a date and time', 'Tap the map to place the pin.', 'Approximate (~100 m)', 'This community', 'Create']) {
            expect(host.textContent, english).toContain(english);
        }
    });
});

describe('the event screens at 320 dp with 1.3× text, in the pseudo-locale', () => {
    it('the page (320 - 2 × 16) and the form (320 - 2 × 16): no word too wide, nothing stuck in a row', async () => {
        node.view = { ...base, author_pubkey: ME, authorPublicKey: ME, eventRsvps: RSVPS };
        await renderIn('xx', createElement(EventDetail, { post: { ...base, author_pubkey: ME, authorPublicKey: ME } }));
        await click(byLabel(xx("Who's going, {n} replies").replace('{n}', '2')), "Who's going");
        expect(unfit(host, 320 - 32, MEMBERS)).toEqual([]);
        act(() => root.unmount());
        root = createRoot(host);
        await renderIn('xx', createElement(NewEventModal, { visible: true, onClose() {} }));
        expect(unfit(host, 320 - 32, MEMBERS)).toEqual([]);
    });
});

describe('the event page follows a language picked while it is open', () => {
    const fr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../words/fr.json'), 'utf8')) as Record<string, unknown>;

    it('a pick redraws it in French from the real catalog', async () => {
        node.view = { ...base, myRsvp: null };
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'] },
                createElement(DrawnInLanguage, null, createElement(EventDetail, { post: base })),
                createElement(LanguagePickerSheet, { visible: true, onClose() {} })) as any);
        });
        await settle();
        expect(byLabel('Going')).not.toBeNull();
        await click(host.querySelector('[data-testid="language-fr"]'), 'Français');
        await settle();
        for (const key of ['Going', 'Interested', 'Back']) {
            expect(typeof fr[key], key).toBe('string');
            expect(byLabel(fr[key] as string), key).not.toBeNull();
        }
        expect(host.textContent).toContain((fr['{going} going · {interested} interested'] as string).replace('{going}', '3').replace('{interested}', '1'));
        expect(byLabel('Going')).toBeNull();
    });
});
