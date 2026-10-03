/**
 * The recovery kit on the phone: the page (from @beanpool/core, shared with the web app), offered as Print (the system
 * print dialog) or Save as PDF (shared, then the phone's copy deleted). Both are optional: the words screen's tickbox
 * stays the only step, and nothing here blocks joining (no hard gates).
 *
 * The page never says whose account it is (no callsign, name, photo or key). Every value on it is escaped for HTML.
 */
import { KIT_TITLE, recoveryKitHtml, type RecoveryKit } from '@beanpool/core';

export { KIT_RESTORE_STEPS, KIT_TITLE, KIT_WARNING, KIT_WEB_RESTORE_STEPS, recoveryKitHtml, type RecoveryKit } from '@beanpool/core';
export const KIT_SAVE_WARNING = 'Keep this file off cloud backups and chats. Anyone who has it can sign in as you.';
export const KIT_FAILED_LINE = 'The recovery kit couldn’t be made on this phone. Write the 12 words down instead.';
export const KIT_PRINT_LABEL = 'Print your recovery kit';
export const KIT_SAVE_LABEL = 'Save as PDF';

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
