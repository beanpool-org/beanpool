/**
 * The recovery kit's page: one printable sheet with the member's 12 words, the community they belong to, the date it
 * was made, and the way back in on a phone and in a web browser. The phone (apps/native/utils/recovery-kit.ts) and the
 * web app (apps/pwa/src/lib/recovery-kit.ts) both print this same page. Pure: no React Native, no DOM.
 *
 * The page never says whose account it is (no callsign, name, photo or key): a page found in a drawer must not point
 * at an account. Every value on it is escaped for HTML.
 */

export interface RecoveryKit {
    /** Exactly the member's 12 words, as the words screen shows them. */
    words: readonly string[];
    communityName: string;
    /** The member's own community address, whatever domain or IP it is. */
    communityAddress: string;
    date: Date;
}

export const KIT_TITLE = 'Your BeanPool recovery kit';
export const KIT_WARNING = 'Anyone who has these 12 words can sign in as you. Keep this page somewhere safe. Never photograph it or send it in a chat.';

/**
 * On a phone, worded as the app's restore screens are (apps/native/app/welcome.tsx): the welcome screen's "Already a
 * Member? Restore Account", then "Recover with 12 Words" on "Restore your account", then the words, the community, and
 * "Recover Identity".
 */
export const KIT_RESTORE_STEPS = [
    'Install BeanPool on your phone and open it.',
    'Tap “🔑 Already a Member? Restore Account →”.',
    'Tap “🔑 Recover with 12 Words”.',
    'Type your 12 words in order, one in each box.',
    'Type your community’s name or address (written above).',
    'Tap “Recover Identity”. Your name and picture come back once you’re in.',
] as const;

/**
 * In a web browser, worded as the web app's restore screens are (apps/pwa/src/pages/WelcomePage.tsx): the community's
 * own address opens the welcome page, whose "Restore Existing Identity" leads to "Recover with 12 Words", the twelve
 * boxes and "Recover Identity". The address is the community, so there is no community box on the web.
 */
export const KIT_WEB_RESTORE_STEPS = [
    'Open your community’s address (written above) in a web browser.',
    'Click “🔑 Restore Existing Identity →”.',
    'Click “🔑 Recover with 12 Words”.',
    'Type your 12 words in order, one in each box.',
    'Click “Recover Identity”. Your name and picture come back once you’re in.',
] as const;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** "3 October 2026", on the device's own calendar day; no Intl (older Hermes builds lack parts of it). */
function kitDate(date: Date): string {
    return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function stepList(steps: readonly string[]): string {
    return `<ol>${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`;
}

/**
 * The kit's page. Only the fields of {@link RecoveryKit} are read, whatever else the caller passes. One printed A4 or
 * Letter sheet at normal type: an `@page` rule, short sections, and no forced page breaks.
 */
export function recoveryKitHtml(kit: RecoveryKit): string {
    const { words, communityName, communityAddress, date } = kit;
    if (!Array.isArray(words) || words.length !== 12 || words.some((w) => typeof w !== 'string' || !w.trim())) {
        throw new Error('A recovery kit needs exactly 12 words.');
    }
    const cells = words.map((word, i) => (
        `<div class="cell"><span class="n">${i + 1}.</span><span class="w">${escapeHtml(word.trim())}</span></div>`
    )).join('');
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(KIT_TITLE)}</title>
<style>
  @page { margin: 14mm; }
  body { font-family: -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { font-size: 14px; margin: 2px 0; overflow-wrap: anywhere; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 14px 0; }
  .cell { border: 1px solid #888; border-radius: 6px; padding: 8px; display: flex; align-items: baseline; gap: 6px; }
  .n { font-size: 13px; color: #555; min-width: 24px; font-variant-numeric: tabular-nums; }
  .w { font-family: "Courier New", Courier, monospace; font-size: 19px; font-weight: bold; }
  .warn { border: 2px solid #b91c1c; border-radius: 8px; padding: 10px 12px; font-size: 15px; font-weight: bold; margin: 14px 0; }
  h2 { font-size: 17px; margin: 14px 0 4px; }
  h3 { font-size: 14px; margin: 10px 0 2px; }
  ol { font-size: 13px; padding-left: 22px; margin: 0; }
  li { margin: 2px 0; }
  @media print { .cell, .warn, ol { break-inside: avoid; } }
</style></head>
<body>
<h1>${escapeHtml(KIT_TITLE)}</h1>
<p class="meta">Community: <strong>${escapeHtml(communityName)}</strong></p>
<p class="meta">Address: <strong>${escapeHtml(communityAddress)}</strong></p>
<p class="meta">Made on ${escapeHtml(kitDate(date))}</p>
<div class="grid">${cells}</div>
<div class="warn">${escapeHtml(KIT_WARNING)}</div>
<h2>How to get back in</h2>
<h3>On a phone</h3>
${stepList(KIT_RESTORE_STEPS)}
<h3>In a web browser</h3>
${stepList(KIT_WEB_RESTORE_STEPS)}
</body></html>`;
}
