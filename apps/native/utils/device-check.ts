/**
 * The device check's answers as rows (components/DeviceCheck.tsx; temporary, the TestFlight probe branch only, never
 * merged). One list for the screen and for Copy results, so nothing drawn can be left out of what is copied. Each row is
 * plain words and the raw value. English only: nothing here goes in the word catalogues.
 */
import { t } from '@beanpool/core';
import type { PasteEventPayload } from 'expo-clipboard';
import type { NotificationPermissionsStatus } from 'expo-notifications';

/** What one call answered, or the error it gave. */
export type Answer<T> = { value: T } | { error: string };

export async function answer<T>(ask: () => Promise<T>): Promise<Answer<T>> {
    try {
        return { value: await ask() };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

export interface DeviceCheckAnswers {
    os: string;
    version: string;
    /** expo-clipboard's isPasteButtonAvailable: an iPhone on iOS 16 or later. */
    pasteButton: boolean;
    hasString?: Answer<boolean>;
    hasUrl?: Answer<boolean>;
    text?: Answer<string>;
    url?: Answer<string | null>;
    /** Everything Apple's button handed over, in order: one tap gives one event per item copied. */
    pasted?: Pasted[];
    /** The permission when the screen opened: whether this phone can answer section B at all. */
    opened?: Answer<NotificationPermissionsStatus>;
    now?: Answer<NotificationPermissionsStatus>;
    quiet?: Answer<NotificationPermissionsStatus>;
    full?: Answer<NotificationPermissionsStatus>;
}

export interface DeviceCheckRow {
    id: string;
    label: string;
    /** In plain words. */
    said: string;
    /** The raw value; null while there is none. */
    raw: string | null;
}

/** One event from Apple's button, with only what the check shows: never a picture's own data. */
export type Pasted = { type: 'text'; text: string | null } | { type: 'image'; width: number; height: number };

/** A link the phone couldn't load arrives as text with no text in it (expo-clipboard's ClipboardPasteButton.swift). */
export function pastedOnly(data: PasteEventPayload): Pasted {
    return data.type === 'text'
        ? { type: 'text', text: data.text ?? null }
        : { type: 'image', width: data.size.width, height: data.size.height };
}

/** Its length and its first 60 characters, quoted so a line break shows. */
const start = (text: string) => `length ${text.length}, first 60: ${JSON.stringify(text.slice(0, 60))}`;

const pastedWords = (p: Pasted) => (p.type === 'image' ? t('A picture.')
    : p.text === null ? t('Text, with nothing in it.')
    : t('Text: {length} characters.', { length: p.text.length }));
const pastedRaw = (p: Pasted) => (p.type === 'image' ? `type: image, ${p.width} x ${p.height}`
    : `type: text, ${p.text === null ? 'text: null' : start(p.text)}`);

function row<T>(id: string, label: string, call: string, got: Answer<T> | undefined, notYet: string, said: (value: T) => string, raw: (value: T) => string): DeviceCheckRow {
    if (!got) return { id, label, said: notYet, raw: null };
    if ('error' in got) return { id, label, said: t('The phone gave an error.'), raw: `${call}: error: ${got.error}` };
    return { id, label, said: said(got.value), raw: `${call}: ${raw(got.value)}` };
}

/** Section A. */
export function inviteRows(c: DeviceCheckAnswers): DeviceCheckRow[] {
    const pasted = c.pasted ?? [];
    return [
        {
            id: 'phone',
            label: t('This phone'),
            said: c.pasteButton ? t("It has Apple's paste button.") : t("It doesn't have Apple's paste button."),
            raw: `${c.os} ${c.version}, isPasteButtonAvailable: ${c.pasteButton}`,
        },
        row('has-text', t('Is text copied?'), 'hasStringAsync', c.hasString, t('Not asked yet.'),
            (yes) => (yes ? t('Yes, the phone says text is copied.') : t('No, the phone says no text is copied.')), String),
        row('has-link', t('Is a link copied?'), 'hasUrlAsync', c.hasUrl, t('Not asked yet.'),
            (yes) => (yes ? t('Yes, the phone says a link is copied.') : t('No, the phone says no link is copied.')), String),
        row('text', t('The copied text, read at your tap'), 'getStringAsync', c.text, t('Not tapped yet.'),
            (text) => (text ? t('It came back: {length} characters.', { length: text.length }) : t("Nothing came back: nothing is copied, or you tapped Don't Allow.")), start),
        row('link', t('The copied link, read at your tap'), 'getUrlAsync', c.url, t('Not tapped yet.'),
            (url) => (url ? t('It came back: {length} characters.', { length: url.length }) : t("No link came back: nothing copied counts as a link, or you tapped Don't Allow.")),
            (url) => (url === null ? 'null' : start(url))),
        {
            id: 'apple-button',
            label: t("What Apple's button handed over"),
            said: pasted.length ? pasted.map(pastedWords).join(' ') : t('Not tapped yet.'),
            raw: pasted.length ? pasted.map(pastedRaw).join('; then ') : null,
        },
    ];
}

/** expo-notifications' IosAuthorizationStatus, by its raw value. */
const IOS_STATUS = ['NOT_DETERMINED', 'DENIED', 'AUTHORIZED', 'PROVISIONAL', 'EPHEMERAL'] as const;

function permissionWords(p: NotificationPermissionsStatus): string {
    switch (p.ios ? IOS_STATUS[p.ios.status] : undefined) {
        case 'NOT_DETERMINED': return t('BeanPool has never asked on this phone.');
        case 'DENIED': return t('Notifications are off: the answer was no.');
        case 'AUTHORIZED': return t('Notifications are fully on.');
        case 'PROVISIONAL': return t('Quiet delivery is on.');
        case 'EPHEMERAL': return t('On for a short time only.');
        default: return t("The phone didn't say which.");
    }
}

const permissionRaw = (p: NotificationPermissionsStatus) =>
    `status: ${p.status}, ios.status: ${p.ios ? `${p.ios.status} (${IOS_STATUS[p.ios.status] ?? 'unknown'})` : 'none'}, canAskAgain: ${p.canAskAgain}, all: ${JSON.stringify(p)}`;

/** Section B, on an iPhone. */
export function notifyRows(c: DeviceCheckAnswers): DeviceCheckRow[] {
    const read = (id: string, label: string, call: string, got: DeviceCheckAnswers['now'], notYet: string) =>
        row(id, label, call, got, notYet, permissionWords, permissionRaw);
    return [
        read('opened', t('When this screen opened'), 'getPermissionsAsync', c.opened, t('Not asked yet.')),
        read('now', t('Now'), 'getPermissionsAsync', c.now, t('Not asked yet.')),
        read('quiet', t('After 1. Ask quietly'), 'requestPermissionsAsync with allowProvisional', c.quiet, t('Not tapped yet.')),
        read('full', t('After 2. Ask fully'), 'requestPermissionsAsync', c.full, t('Not tapped yet.')),
    ];
}

/** What only the person holding the phone can see: lines on the screen, and lines to fill in on the copy. */
export const inviteNotes = () => [
    t('Did a pop-up appear when you tapped Read what is copied? Note yes or no'),
    t("Did a pop-up appear when you tapped Apple's button? Note yes or no"),
    t("Did Apple's button show, how big is its icon, and what does VoiceOver say? Note it"),
];
export const notifyNote = () => t('Did the phone show its own question? Note yes or no');

export const sectionA = () => t('A. Invite paste');
export const sectionB = () => t('B. Quiet notifications');
export const iphoneOnly = () => t('iPhone only');

/** Copy results: every row, then the lines to fill in. */
export function resultsText(c: DeviceCheckAnswers): string {
    const line = (r: DeviceCheckRow) => `${r.label}: ${r.said}${r.raw === null ? '' : ` [${r.raw}]`}`;
    const fill = (words: string) => `${words}: ____`;
    return [
        sectionA(), ...inviteRows(c).map(line), ...inviteNotes().map(fill),
        '',
        sectionB(), ...(c.os === 'ios' ? [...notifyRows(c).map(line), fill(notifyNote())] : [iphoneOnly()]),
    ].join('\n');
}
