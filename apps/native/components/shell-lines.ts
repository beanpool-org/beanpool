/**
 * The app shell's sentences from layers that never reach the words layer, in the member's language (words S3l).
 *
 * utils/key-succession.ts signs the re-key statement, so its prompt (app/_layout.tsx) is worded again here from the same
 * date. utils/__tests__/shell-words-render.test.ts holds it to keySuccessionPromptText and KEY_SUCCESSION_PROMPT_YES / _NO
 * in English. The file it stands for is not touched; what "Yes" and "Not me" do is unchanged.
 *
 * The update block's ways out (components/ForceUpdateBlock.tsx) say why one failed in the lower layer's English (the 12
 * words behind the lock, leaving, switching): phoneLineWords gives utils/update-block-escape.ts's own (the table below)
 * and the ones Settings already words (its table, by the exact sentence) in the member's language, and anything else (a
 * community's own words) exactly as given. shell-words-render.test.ts draws each from the function that throws it.
 */
import { formatDate, t, word, type WordKey } from '@beanpool/core';
import { settingsLineWords } from './settings/settings-lines';

/** keySuccessionPromptText(at) and its two buttons: the same sentence, the date as key-succession.ts shortDate writes it. */
export function rekeyPromptWords(at: string): { text: string; yes: string; no: string } {
    const d = new Date(at);
    const date = Number.isFinite(d.getTime()) ? formatDate(d, 'day-month-year', { utc: true }) : at;
    return {
        text: t('This account was re-keyed on {date}. Confirm it was you, and the messages you sent before then will show under your name again.', { date }),
        yes: t('Yes, that was me'),
        no: t('Not me'),
    };
}

/** utils/update-block-escape.ts's own sentences, by their exact English (the key IS the English). */
const BLOCK: Readonly<Record<string, WordKey>> = {
    // leaveFromUpdateBlock: the phone moved to another community since the plan; nothing was done.
    'This phone changed community. Open Leave this community again.': word('This phone changed community. Open Leave this community again.'),
};

/** A lower layer's sentence in the member's language where the block's table or Settings' knows it; anything else exactly as given. */
export function phoneLineWords(english: string): string {
    return Object.prototype.hasOwnProperty.call(BLOCK, english) ? t(BLOCK[english]) : settingsLineWords(english);
}
