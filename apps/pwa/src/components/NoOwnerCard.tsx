import { t } from '@beanpool/core';

/**
 * "‹name› has no owner yet", on the web app's first screen at a server nobody has claimed (GET /api/local/claim answers
 * `unclaimed: true`; DESIGN-new-operator-path-fable.md S4). The phone's no-owner card (apps/native/components/NoOwnerCard.tsx)
 * in the same words and order: the name, the address under it, the one sentence, then Claim. It stands where the
 * community's card would, whose Ask to join nobody could answer yet.
 *
 * Claiming is done from the phone app only (an owner's key and screen lock are the phone's), so Claim opens this server's
 * Settings, whose no-owner page shows the command to run on the server, the QR code to scan and the phone's two routes
 * (apps/manager UnclaimedCard). The words wrap at 320 px and 130 % text: nothing is cut to a line count.
 */
export function NoOwnerCard({ name, origin }: { name: string; origin: string }) {
    return (
        <section data-testid="no-owner-card" aria-labelledby="no-owner-card-title"
            className="text-left mb-6 p-4 rounded-2xl border border-border-primary bg-bg-card">
            <h2 id="no-owner-card-title" dir="auto" aria-live="polite"
                className="m-0 text-lg font-extrabold leading-snug break-words text-text-primary">
                {t('{name} has no owner yet', { name })}
            </h2>
            <p data-testid="no-owner-card-address" className="m-0 mt-0.5 text-sm break-all text-text-secondary select-all">{origin}</p>
            <p className="m-0 mt-2 text-[15px] leading-relaxed break-words text-text-primary">
                {t('If you installed it, claim it with the one-time code on the server.')}
            </p>
            <a href={`${origin}/settings`} data-testid="no-owner-card-claim"
                className="mt-3 inline-flex min-h-[48px] max-w-full items-center justify-center rounded-xl px-5 py-3 text-center text-[15px] font-extrabold break-words no-underline bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info">
                {t('Claim {name}', { name })}
            </a>
        </section>
    );
}
