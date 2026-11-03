/**
 * "Vouch for them: None, 25, 50, 100" on the invite screen, for someone who can vouch and nobody else (core
 * offersInviteVouch; InvitePage owns the choice, and None is what it holds each time the screen opens). The phone's
 * InviteVouchChoice on the web: a small plain row, not a card. Real radios, so a screen reader names each choice and says
 * which is on, and the arrow keys move between them. Four across at 320 px and 1.3× text, wrapping rather than cutting a
 * word in a longer language; every choice at least 44 px tall.
 */
import { INVITE_VOUCH_CHOICES, INVITE_VOUCH_WORDS, t, type VouchLevel } from '@beanpool/core';

export function InviteVouchChoice({ value, onChange }: { value: VouchLevel | null; onChange: (level: VouchLevel | null) => void }) {
    return (
        <fieldset className="mb-4 border-0 p-0 m-0 min-w-0" data-testid="invite-vouch">
            <legend className="p-0 mb-2 text-[14px] font-bold text-nature-950 dark:text-white">{t(INVITE_VOUCH_WORDS.label)}</legend>
            <div className="flex flex-wrap gap-2">
                {INVITE_VOUCH_CHOICES.map(({ level, amount }) => (
                    <label key={String(level)} className="relative flex-1 min-w-[56px] cursor-pointer">
                        <input
                            type="radio"
                            name="invite-vouch"
                            className="peer sr-only"
                            checked={level === value}
                            onChange={() => onChange(level)}
                            aria-label={amount === null ? t(INVITE_VOUCH_WORDS.none) : t(INVITE_VOUCH_WORDS.beans, { amount })}
                        />
                        <span className="flex min-h-[44px] items-center justify-center rounded-xl border px-2 py-2 text-[14px] font-bold transition-colors border-nature-200 dark:border-nature-500 bg-white dark:bg-nature-900 text-nature-950 dark:text-white peer-checked:border-transparent peer-checked:bg-bp-commit-fill peer-checked:text-bp-commit-on peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-500">
                            {amount === null ? t(INVITE_VOUCH_WORDS.none) : amount}
                        </span>
                    </label>
                ))}
            </div>
        </fieldset>
    );
}
