import { useState } from 'react';
import { t } from '@beanpool/core';
import { removeWorkingStyle } from '../lib/working-style';

/**
 * "Remove my working style" on the card (DESIGN-archetype-across-fable.md §3, S3): one confirm in plain words, then the
 * browser's copy goes and the community is told (lib/working-style.ts). `onRemoved` is the page taking the result off its
 * own screen. 44 px tall; the quiet ink of the card in light and dark.
 */
export function RemoveWorkingStyleButton({ publicKey, onRemoved }: { publicKey: string; onRemoved: () => void }) {
    const [busy, setBusy] = useState(false);

    async function remove() {
        if (!window.confirm(t('This takes your working style off this device and out of every community on it. A retake brings it back.'))) return;
        setBusy(true);
        try {
            await removeWorkingStyle(publicKey);
            onRemoved();
        } finally {
            setBusy(false);
        }
    }

    return (
        <button
            type="button"
            aria-label={t('Remove my working style')}
            disabled={busy}
            onClick={remove}
            className="w-full min-h-[44px] px-2 rounded-xl text-xs font-semibold text-nature-600 dark:text-nature-300 underline bg-transparent border-none cursor-pointer break-words disabled:opacity-60"
        >
            {t('Remove my working style')}
        </button>
    );
}
