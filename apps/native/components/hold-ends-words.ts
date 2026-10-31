import { formatDate, t, tn } from '@beanpool/core';

/**
 * utils/vault.ts holdEndsText, in the member's language (vault.ts is on the 12 words' key path and never reaches the words
 * layer): "in about 5 hours (Thu 15:40)", "in a few minutes", or "any moment now". The day and time through core's
 * formatDate (holdEndsText writes the device's own).
 */
export function holdEndsWords(releaseAt: number, now: number = Date.now()): string {
    const left = releaseAt - now;
    if (left <= 60_000) return t('any moment now');
    if (left < 60 * 60_000) return t('in a few minutes');
    const hours = Math.round(left / (60 * 60_000));
    const end = new Date(releaseAt);
    const at = t('{day} {time}', { day: formatDate(end, 'weekday'), time: formatDate(end, 'time') });
    return tn(hours, 'in about {n} hour ({at})', 'in about {n} hours ({at})', { at });
}
