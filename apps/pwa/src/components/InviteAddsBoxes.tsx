/**
 * "Add them to the names list" and "Make them a voucher", under the vouch presets on an owner's or admin's invite screen
 * (DESIGN-invites-and-names-list-amend3-fable.md §1 and §4, slice A3; Marty, 8 Nov, Q2: phone first).
 *
 * The web app holds no names-list key (the keys live on the admins' phones), so both rows are switched off: they never tick,
 * and they look it (the vouch presets' own greyed look). But a switched-off row is not a dead end (Marty, 9 Nov: "I get a
 * circle with a line through it when I try and add a friend in PWA … maybe we can say — needs to be done in app?"): a tap on
 * either row, its box, or Space or Enter on it, says at once, beside that row, where it is done. The rows are therefore not
 * `disabled` (which swallows the tap and draws the not-allowed cursor) but `aria-disabled`, still in the tab order, and the
 * click is cancelled so nothing ticks. The sentence sits in a polite live region that is on the page before it fills, so a
 * screen reader reads it when it arrives; it is on the page once, under the row last tapped. On a phone's browser (and only
 * there) an "Open in the BeanPool app" link sits beside it (lib/peek.ts openAppDoors); a computer gets the sentence alone.
 * Nothing here changes what an invite sends. The page shows this only to an owner or admin on a node that offers the names
 * list (core `offersNamesList`).
 *
 * Wraps at 320 px with 1.3x text; each row and link >= 44 px tall; colours from the central tokens, light and dark.
 */
import { useId, useState } from 'react';
import { t, inviteFromNamesListWords, INVITE_ADDS_WORDS, PEEK_WORDS } from '@beanpool/core';
import { usePhoneBrowser } from '../lib/global-entry';
import { openAppDoors } from '../lib/peek';

type Row = 'names' | 'voucher' | 'list';

const LINK = 'inline-flex min-h-[44px] max-w-full items-center justify-center rounded-xl px-4 py-2 text-center text-[14px] font-bold break-words no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info';

/** The sentence that says where it is done, and (on a phone's browser) the links into the app; on the page once, under what was last tapped. */
function DoneInAppNote({ asked, noteId, doors }: { asked: boolean; noteId: string; doors: ReturnType<typeof openAppDoors> }) {
    return (
        <div aria-live="polite">
            {asked && (
                <>
                    <p id={noteId} className="m-0 mt-2 break-words rounded-xl bg-bp-chip-info-tint px-3 py-2 text-[13px] leading-relaxed text-bp-chip-info-ink" data-testid="invite-adds-note">
                        {t(INVITE_ADDS_WORDS.doneInApp)}
                    </p>
                    {/* The links sit on the page's own ground, not on the note's tint, as the peek page has them (the blue ink is for it). */}
                    {doors && (
                        <div className="mt-2 flex flex-wrap gap-2">
                            <a href={doors.app} data-testid="invite-adds-open-app" className={`${LINK} bg-bp-commit-fill text-bp-commit-on hover:bg-bp-commit-hover`}>
                                {t(PEEK_WORDS.openInApp)}
                            </a>
                            {/* An Android intent falls back to the store by itself; an iPhone's app link has no fallback. */}
                            {!doors.app.startsWith('intent:') && (
                                <a href={doors.store} rel="noopener noreferrer" data-testid="invite-adds-get-app" className={`${LINK} border border-bp-ink-info text-bp-ink-info`}>
                                    {t(PEEK_WORDS.getApp)}
                                </a>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function SwitchedOffRow({ row, testId, label, asked, noteId, doors, onAsk }: {
    row: Row;
    testId: string;
    label: string;
    asked: boolean;
    noteId: string;
    /** The app's links, on a phone's browser; null on a computer. */
    doors: ReturnType<typeof openAppDoors>;
    onAsk: () => void;
}) {
    return (
        <div data-testid={`invite-adds-row-${row}`}>
            <label className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border border-nature-200 bg-bp-chip-quiet-tint px-3 py-2 text-[14px] font-bold text-bp-chip-quiet-ink focus-within:ring-2 focus-within:ring-bp-ink-info dark:border-nature-800">
                <input
                    type="checkbox"
                    className="sr-only"
                    aria-disabled="true"
                    aria-describedby={asked ? noteId : undefined}
                    data-testid={testId}
                    onClick={(e) => { e.preventDefault(); onAsk(); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAsk(); } }}
                />
                <span
                    aria-hidden="true"
                    className="h-5 w-5 shrink-0 rounded border-2 border-nature-300 bg-white/60 dark:border-nature-600 dark:bg-nature-900"
                />
                <span className="min-w-0 break-words">{label}</span>
            </label>
            <DoneInAppNote asked={asked} noteId={noteId} doors={doors} />
        </div>
    );
}

export function InviteAddsBoxes() {
    const noteId = useId();
    // The row last tapped: the sentence is on the page once, under it.
    const [asked, setAsked] = useState<Row | null>(null);
    const doors = usePhoneBrowser() ? openAppDoors() : null;
    return (
        <div className="mb-4" data-testid="invite-adds">
            <div className="flex flex-col gap-2">
                <SwitchedOffRow row="names" testId="invite-adds-names" label={t(INVITE_ADDS_WORDS.addToNames)} asked={asked === 'names'} noteId={noteId} doors={doors} onAsk={() => setAsked('names')} />
                <SwitchedOffRow row="voucher" testId="invite-adds-voucher" label={t(INVITE_ADDS_WORDS.makeVoucher)} asked={asked === 'voucher'} noteId={noteId} doors={doors} onAsk={() => setAsked('voucher')} />
            </div>
            {/* The other way in (invites-vouching I4): the names list's own "Invite this person", which is the phone's. */}
            <div data-testid="invite-adds-row-list">
                <button
                    type="button"
                    onClick={() => setAsked('list')}
                    aria-describedby={asked === 'list' ? noteId : undefined}
                    className="mt-1 min-h-[44px] max-w-full cursor-pointer break-words border-0 bg-transparent px-1 py-2 text-left text-[14px] font-bold text-bp-ink-accent"
                    data-testid="invite-from-names-list"
                >
                    {inviteFromNamesListWords()}
                </button>
                <DoneInAppNote asked={asked === 'list'} noteId={noteId} doors={doors} />
            </div>
        </div>
    );
}
