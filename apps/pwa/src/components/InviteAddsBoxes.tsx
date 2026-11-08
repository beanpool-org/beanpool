/**
 * "Add them to the names list" and "Make them a voucher", under the vouch presets on an owner's or admin's invite screen
 * (DESIGN-invites-and-names-list-amend3-fable.md §1 and §4, slice A3; Marty, 8 Nov, Q2: phone first).
 *
 * The web app holds no names-list key (the keys live on the admins' phones), so both boxes are drawn greyed and say so in one
 * sentence. Greyed means disabled and aria-disabled: not in the tab order, so no focus trap, and each is described by the
 * sentence. Nothing here changes what an invite sends. The page shows this only to an owner or admin on a node that offers
 * the names list (core `offersNamesList`).
 *
 * Wraps at 320 px with 1.3x text; each row >= 44 px tall; the greyed look is the vouch presets' own (central tokens, light and dark).
 */
import { useId } from 'react';
import { t, INVITE_ADDS_WORDS } from '@beanpool/core';

function GreyedBox({ testId, label, noteId }: { testId: string; label: string; noteId: string }) {
    return (
        <label className="flex min-h-[44px] cursor-not-allowed items-center gap-3 rounded-xl border border-nature-200 bg-bp-chip-quiet-tint px-3 py-2 text-[14px] font-bold text-bp-chip-quiet-ink dark:border-nature-800">
            <input
                type="checkbox"
                className="sr-only"
                disabled
                aria-disabled="true"
                aria-describedby={noteId}
                data-testid={testId}
            />
            <span
                aria-hidden="true"
                className="h-5 w-5 shrink-0 rounded border-2 border-nature-300 bg-white/60 dark:border-nature-600 dark:bg-nature-900"
            />
            <span className="min-w-0 break-words">{label}</span>
        </label>
    );
}

export function InviteAddsBoxes() {
    const noteId = useId();
    return (
        <div className="mb-4" data-testid="invite-adds">
            <div className="flex flex-col gap-2">
                <GreyedBox testId="invite-adds-names" label={t(INVITE_ADDS_WORDS.addToNames)} noteId={noteId} />
                <GreyedBox testId="invite-adds-voucher" label={t(INVITE_ADDS_WORDS.makeVoucher)} noteId={noteId} />
            </div>
            <p id={noteId} className="m-0 mt-2 text-[13px] leading-relaxed text-nature-600 dark:text-nature-300" data-testid="invite-adds-note">
                {t(INVITE_ADDS_WORDS.webLater)}
            </p>
        </div>
    );
}
