/**
 * The recovery kit: one printable page with the member's 12 words, the community they belong to, and the date it was
 * made, offered as Print (the system print dialog) or Save as PDF (shared, then the phone's copy deleted). Both are
 * optional: the words screen's tickbox stays the only step, and nothing here blocks joining (no hard gates).
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
export const KIT_SAVE_WARNING = 'Keep this file off cloud backups and chats. Anyone who has it can sign in as you.';
export const KIT_FAILED_LINE = 'The recovery kit couldn’t be made on this phone. Write the 12 words down instead.';
export const KIT_PRINT_LABEL = 'Print your recovery kit';
export const KIT_SAVE_LABEL = 'Save as PDF';

/**
 * The way back in, worded as the app's restore screens are (app/welcome.tsx): the welcome screen's "Already a Member?
 * Restore Account", then "Recover with 12 Words" on "Restore your account", then the words, the community, and
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

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** "3 October 2026", on the phone's own calendar day; no Intl (older Hermes builds lack parts of it). */
function kitDate(date: Date): string {
    return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** The kit's page. Only the fields of {@link RecoveryKit} are read, whatever else the caller passes. */
export function recoveryKitHtml(kit: RecoveryKit): string {
    const { words, communityName, communityAddress, date } = kit;
    if (!Array.isArray(words) || words.length !== 12 || words.some((w) => typeof w !== 'string' || !w.trim())) {
        throw new Error('A recovery kit needs exactly 12 words.');
    }
    const cells = words.map((word, i) => (
        `<div class="cell"><span class="n">${i + 1}.</span><span class="w">${escapeHtml(word.trim())}</span></div>`
    )).join('');
    const steps = KIT_RESTORE_STEPS.map((step) => `<li>${escapeHtml(step)}</li>`).join('');
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(KIT_TITLE)}</title>
<style>
  @page { margin: 16mm; }
  body { font-family: -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .meta { font-size: 14px; margin: 2px 0; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 18px 0; }
  .cell { border: 1px solid #888; border-radius: 6px; padding: 10px 8px; display: flex; align-items: baseline; gap: 6px; }
  .n { font-size: 13px; color: #555; min-width: 24px; font-variant-numeric: tabular-nums; }
  .w { font-family: "Courier New", Courier, monospace; font-size: 20px; font-weight: bold; }
  .warn { border: 2px solid #b91c1c; border-radius: 8px; padding: 12px; font-size: 15px; font-weight: bold; margin: 16px 0; }
  h2 { font-size: 17px; margin: 16px 0 6px; }
  ol { font-size: 14px; padding-left: 22px; margin: 0; }
  li { margin: 3px 0; }
</style></head>
<body>
<h1>${escapeHtml(KIT_TITLE)}</h1>
<p class="meta">Community: <strong>${escapeHtml(communityName)}</strong></p>
<p class="meta">Address: <strong>${escapeHtml(communityAddress)}</strong></p>
<p class="meta">Made on ${escapeHtml(kitDate(date))}</p>
<div class="grid">${cells}</div>
<div class="warn">${escapeHtml(KIT_WARNING)}</div>
<h2>How to get back in</h2>
<ol>${steps}</ol>
</body></html>`;
}

/** The phone modules the two actions use (expo-print, expo-sharing, expo-file-system/legacy). */
export interface KitModules {
    Print: {
        printAsync(options: { html: string }): Promise<unknown>;
        printToFileAsync(options: { html: string }): Promise<{ uri: string }>;
    };
    Sharing: { shareAsync(uri: string, options?: { mimeType?: string; UTI?: string; dialogTitle?: string }): Promise<unknown> };
    FileSystem: { deleteAsync(uri: string, options?: { idempotent?: boolean }): Promise<unknown> };
}

type ModulesOrLoader = KitModules | (() => KitModules);

/**
 * Required when pressed, not at the top: a phone built before expo-print fails the kit alone, and says so
 * (as app/names-list.tsx's export does).
 */
function loadKitModules(): KitModules {
    return {
        Print: require('expo-print') as KitModules['Print'],
        Sharing: require('expo-sharing') as KitModules['Sharing'],
        FileSystem: require('expo-file-system/legacy') as KitModules['FileSystem'],
    };
}

function modulesFrom(source: ModulesOrLoader | undefined): KitModules {
    if (!source) return loadKitModules();
    return typeof source === 'function' ? source() : source;
}

export type KitResult = 'done' | 'cancelled' | 'failed';

/** Print: the system print dialog renders the page; the app writes no file of its own. */
export async function printRecoveryKit(kit: RecoveryKit, modules?: ModulesOrLoader): Promise<KitResult> {
    try {
        const html = recoveryKitHtml(kit);
        const { Print } = modulesFrom(modules);
        await Print.printAsync({ html });
        return 'done';
    } catch {
        return 'failed';
    }
}

/**
 * Save as PDF: asked first (Cancel makes nothing), then the PDF is made, handed to the share sheet, and the phone's
 * temporary copy deleted whatever the share sheet did.
 */
export async function saveRecoveryKitPdf(kit: RecoveryKit, askFirst: () => Promise<boolean>, modules?: ModulesOrLoader): Promise<KitResult> {
    if (!(await askFirst())) return 'cancelled';
    try {
        const html = recoveryKitHtml(kit);
        const { Print, Sharing, FileSystem } = modulesFrom(modules);
        const { uri } = await Print.printToFileAsync({ html });
        try {
            await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: KIT_TITLE });
        } finally {
            await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
        }
        return 'done';
    } catch {
        return 'failed';
    }
}

type AlertButton = { text: string; style?: 'cancel' | 'default' | 'destructive'; onPress?: () => void };
type AlertLike = (title: string, message?: string, buttons?: AlertButton[], options?: { cancelable?: boolean; onDismiss?: () => void }) => void;

/** The one line before Save as PDF, as an Alert: Cancel or Save. Dismissing it is Cancel. */
export function askBeforeSavingKit(alert: AlertLike): Promise<boolean> {
    return new Promise((resolve) => {
        alert(KIT_SAVE_LABEL, KIT_SAVE_WARNING, [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Save', onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) });
    });
}

/**
 * The community the kit names: the saved alias for the phone's anchor (else its host), and the anchor's address as
 * the phone holds it. Null with no anchor: the kit is not made without the place to go back to.
 */
export function kitCommunityFrom(anchor: string | null | undefined, savedNodes: readonly { url: string; alias?: string | null }[]): { communityName: string; communityAddress: string } | null {
    if (!anchor) return null;
    const alias = savedNodes.find((n) => n.url === anchor)?.alias;
    let host: string;
    try {
        host = new URL(anchor).host || anchor;
    } catch {
        host = anchor.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || anchor;
    }
    return { communityName: alias || host, communityAddress: anchor };
}
