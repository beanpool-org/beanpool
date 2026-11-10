/**
 * The one button an owner or admin sees on someone else's profile, following the person's state (invites-vouching I4,
 * DESIGN-invites-vouching-review-fable.md §3 ask 2; the phone's components/ProfileVoucherButton.tsx, from the same words):
 *
 *   Add to the names list    not on the list
 *   Make a voucher           confirmed, and the viewer is on the credit committee
 *   Voucher · 400 left ›     a voucher now: opens the voucher's card here
 *
 * The web app holds no names-list key (the keys live on the admins' phones; the web list stays parked), so the first two say
 * at once, beside the button, that it is done in the app: the sentence the invite page's rows say (core INVITE_ADDS_WORDS).
 * The state is the node's (the trust profile's `voucherButton`); this never decides it, and shows nothing for a state it does
 * not know. Wraps at 320 px with 1.3x text; at least 44 px tall; colours from the central tokens, light and dark.
 */
import { useId, useState } from 'react';
import { INVITE_ADDS_WORDS, isProfileVoucherButton, profileVoucherButtonWords, t } from '@beanpool/core';
import { VoucherCardModal } from './VoucherCardModal';

export function ProfileVoucherButton({ button, memberPubkey }: { button: unknown; memberPubkey: string }) {
    const noteId = useId();
    const [asked, setAsked] = useState(false);
    const [cardOpen, setCardOpen] = useState(false);
    if (!isProfileVoucherButton(button)) return null;
    const words = profileVoucherButtonWords(button);
    const press = () => (button.state === 'voucher' ? setCardOpen(true) : setAsked(true));
    return (
        <div className="mx-4 mt-4" data-testid="profile-voucher">
            <button
                type="button"
                onClick={press}
                aria-describedby={asked ? noteId : undefined}
                className="w-full min-h-[44px] rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 px-4 py-2 text-left text-sm font-bold text-bp-ink-accent cursor-pointer break-words"
                data-testid="profile-voucher-button"
            >
                {words}
            </button>
            <div aria-live="polite">
                {asked && button.state !== 'voucher' && (
                    <p id={noteId} className="m-0 mt-2 break-words rounded-xl bg-bp-chip-info-tint px-3 py-2 text-[13px] leading-relaxed text-bp-chip-info-ink" data-testid="profile-voucher-note">
                        {t(INVITE_ADDS_WORDS.doneInApp)}
                    </p>
                )}
            </div>
            {cardOpen && button.state === 'voucher' && <VoucherCardModal memberPubkey={memberPubkey} onClose={() => setCardOpen(false)} />}
        </div>
    );
}
