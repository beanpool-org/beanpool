/**
 * "A sign for your window or stall": the two "Beans accepted here" signs, A4 for a window and A6 for a stall, printed (or saved as a
 * PDF in the browser's print dialog) from lib/beans-sign.ts. On the community's Settings (anyone) and on an enterprise's Manage tab (its
 * keepers). Optional, and never a success message: the print dialog is the answer; a sign that could not be made says so.
 * Stacked full width, so at 320 px with large text each label wraps rather than clips; 48 px targets; the sage ink the recovery kit's
 * button uses, readable in light and dark.
 */
import { useState } from 'react';
import { BEANS_SIGN_WORDS as W, t, type BeansSignSize } from '@beanpool/core';
import { printBeansSign, type SignDeps } from '../lib/beans-sign';

const button = 'block w-full min-h-[48px] px-4 py-3 rounded-xl text-center text-base font-bold break-words bg-transparent border border-bp-ink-accent text-bp-ink-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info';

export function BeansSignButtons({ deps }: { deps?: SignDeps }) {
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);

    async function make(size: BeansSignSize) {
        if (busy) return;
        setBusy(true);
        setFailed(false);
        try {
            setFailed((await printBeansSign(size, deps)) === 'failed');
        } finally {
            setBusy(false);
        }
    }

    return (
        <section data-testid="beans-sign" aria-labelledby="beans-sign-heading" className="grid gap-2 mb-4">
            <h3 id="beans-sign-heading" className="m-0 text-lg font-bold text-nature-950 dark:text-white">{t(W.heading)}</h3>
            <button type="button" data-testid="beans-sign-a4" disabled={busy} onClick={() => make('a4')} className={button}>
                <span aria-hidden="true">🪟 </span>{t(W.a4)}
            </button>
            <button type="button" data-testid="beans-sign-a6" disabled={busy} onClick={() => make('a6')} className={button}>
                <span aria-hidden="true">🧺 </span>{t(W.a6)}
            </button>
            {failed && <p role="alert" data-testid="beans-sign-failed" className="m-0 text-sm font-semibold text-bp-ink-danger break-words">{t(W.failed)}</p>}
        </section>
    );
}
