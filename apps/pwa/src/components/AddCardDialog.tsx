/**
 * Add a card (scratch/home/CARD-FRAME-DESIGN-fable.md §1.2, slice F3): the picker, opened from the community card's
 * "Add a card ›" and Arrange's + Add a card tile. Three groups (For you · Around you · Getting started), each type this node
 * can show (lib/home-layout.ts `pickerGroups`), in the catalogue's order. A row is the type's name and one line of what
 * it shows, with an Add button, "On Home" for a one-of-a-kind already there, or "2 of 5 on Home" under an instance
 * type's line. Nothing is ever shown as locked: a type this node can't show is simply not listed.
 *
 * A type with settings (a saved search) opens its settings ({@link CardSettingsDialog}) on Add, whose last button is
 * "Add to Home". The same settings open from a card's "…" → Settings…, with Save.
 *
 * A real dialog: `role="dialog"`, labelled by its heading, focus moved in and kept there, Escape closes
 * it, focus goes back to what opened it (or where the page sends it after an add; components/dialog-focus.ts). Every
 * control is at least 44 px.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
    HOME_CHAT_NAME_CHARS, HOME_DECIDE_CHOICES, HOME_SEARCH_KMS, HOME_SEARCH_MAX_CHARS, homeCardHue, homeChatPicked, readChatSettings, readDecideSettings, readSearchSettings, readSkySettings, searchFromSheet, t, word,
    type HomeChatKind, type HomeDecideShow, type HomeSearchKind, type SkySettings, type WordKey,
} from '@beanpool/core';
import { type PickerGroup, type PickerRow } from '../lib/home-layout';
import { CHAT_CARD_WORDS } from '../lib/home-cards';
import { formatRelativeTime } from '../lib/pulse';
import { MARKETPLACE_CATEGORIES } from '../lib/marketplace';
import { useDialogFocus } from './dialog-focus';

const primary = 'min-w-[44px] min-h-[44px] px-4 rounded-xl border-0 bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400';
const plain = 'min-w-[44px] min-h-[44px] px-4 rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-sm font-bold text-nature-800 dark:text-nature-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';

export function Shell({ id, testId, title, children, onClose, dialog, closeText }: {
    id: string; testId: string; title: string; children: ReactNode; onClose: () => void; dialog: React.RefObject<HTMLDivElement | null>;
    /** The close button's words: "Done" where the dialog did something, "Cancel" where it only offers (the starter Offers dialog). */
    closeText?: string;
}) {
    return (
        // Above everything while it is open, the install banner (InstallPrompt, 1000) included: it is modal.
        <div className="fixed inset-0 flex items-end sm:items-center justify-center" style={{ zIndex: 1100, background: 'rgba(0,0,0,0.45)' }}
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={id} data-testid={testId}
                className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto bg-white dark:bg-nature-950 rounded-t-2xl sm:rounded-2xl shadow-2xl p-4 min-w-0">
                <div className="flex items-start gap-2 mb-1">
                    <h2 id={id} tabIndex={-1} className="m-0 flex-1 min-w-0 break-words text-lg font-extrabold text-nature-950 dark:text-white focus:outline-none">{title}</h2>
                    <button type="button" data-testid={`${testId}-done`} onClick={onClose} className={plain}>{closeText ?? t('Done')}</button>
                </div>
                {children}
            </div>
        </div>
    );
}

export const PICKER_NOTE = word('Pick a card to put on Home. You can move or remove it any time.');
export const PICKER_FULL_NOTE = word('Home is full: remove a card to add one.');
/** The picker's two notes, shown through t() (a table, as words:check reads a key). */
const NOTES = { pick: PICKER_NOTE, full: PICKER_FULL_NOTE } as const;

interface PickerProps {
    groups: PickerGroup[];
    full: boolean;
    /** Add this type (with its settings, for a type that has them). The page closes the picker and moves focus. */
    onAdd: (type: string, settings?: Record<string, unknown>) => void;
    onClose: () => void;
    /** Where focus goes on close when what opened the picker has gone (a tile Arrange took with it). */
    returnFocus?: () => HTMLElement | null | undefined;
    /** For a saved search's distance chips: see {@link CardSettingsDialog}. */
    hasPoint?: boolean;
    /** For a chosen chat's list: see {@link CardSettingsDialog}. */
    chats?: ChatPick;
}

export function AddCardDialog({ groups, full, onAdd, onClose, returnFocus, hasPoint, chats }: PickerProps) {
    const dialog = useRef<HTMLDivElement | null>(null);
    // An add sends focus to the new card's "…" (the page does it): closing then doesn't pull it back to the opener.
    const added = useRef(false);
    const [settingsFor, setSettingsFor] = useState<PickerRow | null>(null);
    useDialogFocus(dialog, onClose, { keepFocus: added, fallback: returnFocus });

    const add = (type: string, settings?: Record<string, unknown>) => {
        added.current = true;
        onAdd(type, settings);
    };

    if (settingsFor) {
        return (
            <CardSettingsDialog type={settingsFor.type} name={settingsFor.name} mode="add" keepFocus={added} hasPoint={hasPoint} chats={chats}
                onSubmit={(s) => add(settingsFor.type, s)} onClose={() => setSettingsFor(null)}
                // Back in the picker: its row's Add, else its heading.
                returnFocus={() => dialog.current?.querySelector<HTMLElement>(`[data-testid="home-add-${settingsFor.type}"]`) ?? dialog.current?.querySelector<HTMLElement>('h2')} />
        );
    }

    return (
        <Shell id="home-add-title" testId="home-add-dialog" title={t('Add a card')} onClose={onClose} dialog={dialog}>
            <p data-testid="home-add-note" className="m-0 mb-3 text-sm text-nature-700 dark:text-nature-200">{full ? t(NOTES.full) : t(NOTES.pick)}</p>
            {groups.map((g) => (
                <section key={g.id} aria-labelledby={`home-add-group-${g.id}`} className="mb-3">
                    <h3 id={`home-add-group-${g.id}`} className="m-0 mb-1 text-[0.7rem] font-extrabold uppercase tracking-wider text-nature-600 dark:text-nature-300">{g.name}</h3>
                    <ul className="list-none m-0 p-0 rounded-xl border border-nature-200 dark:border-nature-800">
                        {g.rows.map((r) => (
                            <li key={r.type} data-testid={`home-add-row-${r.type}`}
                                className="flex items-center gap-2 px-3 py-2 border-b border-nature-100 dark:border-nature-800 last:border-b-0 min-w-0">
                                <span className="flex-1 min-w-0 break-words">
                                    <span className="flex items-center min-w-0" style={{ gap: 6 }}>
                                        {/* The colour the card will have on Home, before it is there: decoration, hidden from a screen reader. */}
                                        <span aria-hidden="true" data-testid={`home-add-dot-${r.type}`} className="shrink-0 rounded-full"
                                            style={{ width: 10, height: 10, backgroundColor: `var(--bp-card-${homeCardHue({ type: r.type })}-ink)` }} />
                                        <span className="min-w-0 text-sm font-bold text-nature-900 dark:text-white">{r.name}</span>
                                    </span>
                                    <span className="block text-xs text-nature-700 dark:text-nature-200">{r.line}</span>
                                    {r.count && <span data-testid={`home-add-count-${r.type}`} className="block text-xs text-nature-600 dark:text-nature-300">{r.count}</span>}
                                    {r.status && <span className="block text-xs text-nature-600 dark:text-nature-300">{r.status}</span>}
                                </span>
                                {r.state === 'add' ? (
                                    <button type="button" data-testid={`home-add-${r.type}`} aria-label={t('Add {card} to Home', { card: r.name })} className={`shrink-0 ${primary}`}
                                        onClick={() => (r.hasSettings ? setSettingsFor(r) : add(r.type))}>
                                        {t('Add')}
                                    </button>
                                ) : r.state === 'on-home' ? (
                                    // Words, not an aria-label: a plain span's label isn't reliably read (review of #1701, 7a).
                                    <span data-testid={`home-add-on-${r.type}`} className="shrink-0 text-xs font-semibold text-nature-600 dark:text-nature-300">
                                        <span aria-hidden="true">{t('On Home')}</span><span className="sr-only">{t('{card} is already on Home', { card: r.name })}</span>
                                    </span>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </Shell>
    );
}

interface SettingsProps {
    type: string;
    /** The type's name ("A saved search"), for the heading. */
    name: string;
    /** `add`: from the picker, last button "Add to Home"; `save`: from a card's Settings…, last button "Save". */
    mode: 'add' | 'save';
    /** The card's settings now (for `save`). */
    initial?: unknown;
    /** The node has a point to measure a distance from (the member's area, or a place this browser shared). */
    hasPoint?: boolean;
    onSubmit: (settings: Record<string, unknown>) => void;
    onClose: () => void;
    keepFocus?: React.RefObject<boolean>;
    /** Where focus goes on close when what opened the settings has gone (a menu's Settings… item). */
    returnFocus?: () => HTMLElement | null | undefined;
    /** A chosen chat's list: the member's chats, read once as it opens, and the ones already on Home. */
    chats?: ChatPick;
}

/** One chat the settings list offers (DESIGN-home-chosen-chat-fable.md §2): a group's, an event's, an enterprise's, or a person's. */
export interface ChatPickRow {
    conversationId: string;
    kind: HomeChatKind;
    name: string;
    /** Its last line's time, when the list knows it ("2h ago"). */
    at?: string | null;
}

/** What the chat list reads, handed in by the page: the read (once, at setup) and the chats pinned on Home already. */
export interface ChatPick {
    load: () => Promise<ChatPickRow[]>;
    pinned: readonly string[];
}

/** A row's mark by kind (§2: groups 🥖🎯📅, then people 👤, as the phone's list marks them): decoration, hidden from a screen reader. */
const CHAT_KIND_MARK: Record<HomeChatKind, string> = { group: '🥖', enterprise: '🎯', event: '📅', dm: '👤' };

/** Past this many rows the list has a filter box (§2). */
export const CHAT_FILTER_FROM = 8;

/**
 * A chosen chat's settings: the member's chats, groups first (by kind mark), then people, each a 48 px row of its name and
 * when it last spoke; a filter box past 8; a chat already on Home says so and isn't offered again. A tap picks it: the
 * card keeps its id, kind and name (core readChatSettings). Read once as it opens; a failed read says so with Try again.
 */
function ChatPickList({ chats, current, onPick }: { chats: ChatPick; current?: string; onPick: (row: ChatPickRow) => void }) {
    const [rows, setRows] = useState<ChatPickRow[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [filter, setFilter] = useState('');
    const [tries, setTries] = useState(0);
    useEffect(() => {
        let live = true;
        setFailed(false);
        chats.load().then((r) => { if (live) setRows(r); }).catch(() => { if (live) setFailed(true); });
        return () => { live = false; };
        // Read once as it opens (and again on Try again): never on every render, so `chats` (a new object each render) isn't a dependency.
    }, [tries]);
    if (failed) {
        return (
            <div data-testid="home-chat-pick-failed">
                <p className="m-0 mb-2 text-sm text-nature-700 dark:text-nature-200">{t(CHAT_CARD_WORDS.failed)}</p>
                <button type="button" className={plain} onClick={() => setTries((n) => n + 1)}>{t('Try again')}</button>
            </div>
        );
    }
    if (!rows) return <p data-testid="home-chat-pick-loading" className="m-0 text-sm text-nature-700 dark:text-nature-200">{t('Loading…')}</p>;
    if (!rows.length) return <p data-testid="home-chat-pick-none" className="m-0 text-sm text-nature-700 dark:text-nature-200">{t(CHAT_CARD_WORDS.none)}</p>;
    const q = filter.trim().toLocaleLowerCase();
    const shown = q ? rows.filter((r) => r.name.toLocaleLowerCase().includes(q)) : rows;
    const pinned = new Set(chats.pinned);
    return (
        <div>
            {rows.length > CHAT_FILTER_FROM && (
                <>
                    <label htmlFor="home-chat-filter" className="sr-only">{t(CHAT_CARD_WORDS.find)}</label>
                    <input id="home-chat-filter" data-testid="home-chat-filter" type="search" value={filter} onChange={(e) => setFilter(e.target.value)}
                        placeholder={t(CHAT_CARD_WORDS.find)} autoComplete="off"
                        className="w-full min-w-0 min-h-[44px] mb-2 px-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-base text-nature-900 dark:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" />
                </>
            )}
            <ul data-testid="home-chat-list" className="list-none m-0 p-0 rounded-xl border border-nature-200 dark:border-nature-800">
                {shown.map((r) => {
                    // On Home already (this card's own chat in Settings… included): said, never offered twice.
                    const on = pinned.has(r.conversationId) || r.conversationId === current;
                    const when = r.at ? formatRelativeTime(r.at) : '';
                    const mark = CHAT_KIND_MARK[r.kind];
                    const inner = (
                        <>
                            {mark && <span aria-hidden="true" className="shrink-0">{mark}</span>}
                            <span className="flex-1 min-w-0">
                                <span className="block min-w-0 break-words text-sm font-bold text-nature-900 dark:text-white">{r.name}</span>
                                {when && <span className="block text-xs text-nature-700 dark:text-nature-200">{when}</span>}
                            </span>
                        </>
                    );
                    return (
                        <li key={r.conversationId} data-testid="home-chat-row" className="border-b border-nature-100 dark:border-nature-800 last:border-b-0 min-w-0">
                            {on ? (
                                <div className="flex items-center gap-2 px-3 py-1 min-h-[48px] min-w-0">
                                    {inner}
                                    <span data-testid="home-chat-on" className="shrink-0 text-xs font-semibold text-nature-600 dark:text-nature-300">{t('On Home')}</span>
                                </div>
                            ) : (
                                <button type="button" data-testid="home-chat-choose" onClick={() => onPick(r)}
                                    className="w-full flex items-center gap-2 px-3 py-1 min-h-[48px] min-w-0 text-left bg-transparent border-0 cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-xl">
                                    {inner}
                                </button>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

/** A saved search's kinds, as its sheet offers them (CARD-FRAME §4). word() keys: shown through t(). */
export const SEARCH_KIND_CHIPS: ReadonlyArray<{ kind: HomeSearchKind; label: WordKey }> = [
    { kind: 'any', label: word('Both') }, { kind: 'offer', label: word('Offers') }, { kind: 'need', label: word('Needs') },
];

/** Whose place the sun and moon card shows, as its sheet offers it (CARD-FRAME §4). word() keys: shown through t(). */
export const SKY_PLACE_CHIPS: ReadonlyArray<{ place: SkySettings['place']; label: WordKey }> = [
    { place: 'community', label: word('Your community') }, { place: 'me', label: word('Your area') },
];

const chip = (on: boolean) => `min-w-[44px] min-h-[44px] px-3 rounded-full border text-sm font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
    on ? 'bg-bp-commit-fill border-bp-commit-fill text-bp-commit-on' : 'bg-transparent border-nature-300 dark:border-nature-700 text-nature-800 dark:text-nature-100'}`;

function Chips<T>({ legend, testId, options, value, onPick }: {
    legend: string; testId: string; options: ReadonlyArray<{ value: T; label: string }>; value: T; onPick: (v: T) => void;
}) {
    return (
        <fieldset data-testid={testId} className="m-0 mt-3 p-0 border-0 min-w-0">
            <legend className="mb-1 p-0 text-sm font-semibold text-nature-900 dark:text-white">{legend}</legend>
            <div className="flex flex-wrap gap-2">
                {options.map((o) => (
                    <button key={String(o.value)} type="button" aria-pressed={o.value === value} className={chip(o.value === value)} onClick={() => onPick(o.value)}>
                        {o.label}
                    </button>
                ))}
            </div>
        </fieldset>
    );
}

/**
 * A card's settings (CARD-FRAME §4). Sun and moon asks one thing: whose place, the community's or the member's own. Decide
 * asks one too: what it shows (a summary, every open Decision, or only the votes that are the member's), with a line under
 * the chosen one (core HOME_DECIDE_CHOICES, the same words as the phone's). The saved search asks its words, then Offers or Needs or both, a category, and a distance. The distance chips show only where the node has a point to measure from (the member's area,
 * or the place this browser shared); without one the node ignores the distance, so the sheet doesn't offer it, and a
 * distance already kept stays as it was.
 */
export function CardSettingsDialog({ type, name, mode, initial, hasPoint = false, onSubmit, onClose, keepFocus, returnFocus, chats }: SettingsProps) {
    const dialog = useRef<HTMLDivElement | null>(null);
    useDialogFocus(dialog, onClose, { keepFocus, fallback: returnFocus });
    const [start] = useState(() => readSearchSettings(initial));
    const [q, setQ] = useState(start.q);
    const [kind, setKind] = useState<HomeSearchKind>(start.kind);
    const [category, setCategory] = useState<string>(start.category ?? '');
    const [km, setKm] = useState<number | null>(start.km ?? null);
    const [place, setPlace] = useState<SkySettings['place']>(() => readSkySettings(initial).place);
    const [show, setShow] = useState<HomeDecideShow>(() => readDecideSettings(initial).show);
    const words = q.trim();
    if (type === 'chat') {
        // A tap on a chat picks it: in `add` the card goes on Home with it, in `save` the card shows it instead.
        const now = readChatSettings(initial);
        return (
            <Shell id="home-settings-title" testId="home-settings-dialog" title={name} onClose={onClose} dialog={dialog}>
                {chats
                    ? <ChatPickList chats={chats} current={homeChatPicked(now) ? now.conversationId : undefined}
                        onPick={(r) => onSubmit({ conversationId: r.conversationId, kind: r.kind, name: Array.from(r.name.trim()).slice(0, HOME_CHAT_NAME_CHARS).join('') })} />
                    : <p className="m-0 text-sm text-nature-700 dark:text-nature-200">{t(CHAT_CARD_WORDS.failed)}</p>}
            </Shell>
        );
    }
    if (type === 'decide') {
        return (
            <Shell id="home-settings-title" testId="home-settings-dialog" title={name} onClose={onClose} dialog={dialog}>
                <form onSubmit={(e) => { e.preventDefault(); onSubmit({ show }); }}>
                    <Chips legend={t('Show')} testId="home-settings-show" value={show} onPick={setShow}
                        options={HOME_DECIDE_CHOICES.map((c) => ({ value: c.show, label: t(c.label) }))} />
                    <p data-testid="home-settings-show-note" className="m-0 mt-2 text-xs text-nature-700 dark:text-nature-200">
                        {t(HOME_DECIDE_CHOICES.find((c) => c.show === show)!.note)}
                    </p>
                    <button type="submit" data-testid="home-settings-submit" className={`mt-4 w-full ${primary}`}>
                        {mode === 'add' ? t('Add to Home') : t('Save')}
                    </button>
                </form>
            </Shell>
        );
    }
    if (type === 'sky') {
        return (
            <Shell id="home-settings-title" testId="home-settings-dialog" title={name} onClose={onClose} dialog={dialog}>
                <form onSubmit={(e) => { e.preventDefault(); onSubmit({ place }); }}>
                    <Chips legend={t('Whose place')} testId="home-settings-place" value={place} onPick={setPlace}
                        options={SKY_PLACE_CHIPS.map((p) => ({ value: p.place, label: t(p.label) }))} />
                    <button type="submit" data-testid="home-settings-submit" className={`mt-4 w-full ${primary}`}>
                        {mode === 'add' ? t('Add to Home') : t('Save')}
                    </button>
                </form>
            </Shell>
        );
    }
    if (type !== 'search') return null;
    const submit = () => onSubmit(searchFromSheet(start, { q: words, kind, category, km }));
    return (
        <Shell id="home-settings-title" testId="home-settings-dialog" title={name} onClose={onClose} dialog={dialog}>
            <form onSubmit={(e) => { e.preventDefault(); if (words) submit(); }}>
                <label htmlFor="home-settings-q" className="block mb-1 text-sm font-semibold text-nature-900 dark:text-white">{t('Words to look for')}</label>
                <input id="home-settings-q" data-testid="home-settings-q" type="text" value={q} maxLength={HOME_SEARCH_MAX_CHARS}
                    onChange={(e) => setQ(e.target.value)} autoComplete="off"
                    className="w-full min-w-0 min-h-[44px] px-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-base text-nature-900 dark:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" />
                <Chips legend={t('Show')} testId="home-settings-kind" value={kind} onPick={setKind}
                    options={SEARCH_KIND_CHIPS.map((k) => ({ value: k.kind, label: t(k.label) }))} />
                <label htmlFor="home-settings-category" className="block mt-3 mb-1 text-sm font-semibold text-nature-900 dark:text-white">{t('Category')}</label>
                <select id="home-settings-category" data-testid="home-settings-category" value={category} onChange={(e) => setCategory(e.target.value)}
                    className="w-full min-w-0 min-h-[44px] px-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-base text-nature-900 dark:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                    <option value="">{t('Any category')}</option>
                    {MARKETPLACE_CATEGORIES.map((c) => {
                        // The category's name in the member's language, after its emoji (an icon, not words).
                        const name = t(c.label);
                        return <option key={c.id} value={c.id}>{c.emoji} {name}</option>;
                    })}
                </select>
                {hasPoint && (
                    <Chips legend={t('Distance')} testId="home-settings-km" value={km} onPick={setKm}
                        options={[{ value: null, label: t('Any distance') }, ...HOME_SEARCH_KMS.map((k) => ({ value: k as number | null, label: t('{distance} km', { distance: k }) }))]} />
                )}
                <button type="submit" data-testid="home-settings-submit" disabled={!words} className={`mt-4 w-full disabled:opacity-40 disabled:cursor-default ${primary}`}>
                    {mode === 'add' ? t('Add to Home') : t('Save')}
                </button>
            </form>
        </Shell>
    );
}
