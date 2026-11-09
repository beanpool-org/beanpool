/**
 * Share on People → Invites sends the QR picture with the invite message (Damo, 9 Nov, on the web; the web app's
 * lib/invite-picture.ts is the same). The phone's share dialogs differ, measured in the modules the app ships:
 *
 *  - iOS: React Native's Share takes the message AND a file address (`url`), and the sheet carries both.
 *  - Android: React Native's Share carries the message only (it ignores `url`), and expo-sharing carries the picture only
 *    (its intent has the file and no text: expo-sharing 55 SharingModule.kt). One dialog cannot carry both, so the picture
 *    goes in the dialog and the message goes on the clipboard, said so in a toast, to paste next to it.
 *  - Anywhere the picture could not be made, or cannot be shared, today's message-only share stays.
 *
 * The phone modules arrive as `deps`, so a test can stand in for them (none of them load outside a phone).
 */
import { invitePictureName, t } from '@beanpool/core';

export interface InviteShareDeps {
    platform: string;
    Share: { share(content: { message: string; url?: string }): Promise<unknown> };
    /** expo-sharing, loaded only when a picture is shared (it does not load outside a phone). */
    sharing(): Promise<{
        isAvailableAsync(): Promise<boolean>;
        shareAsync(uri: string, options?: { mimeType?: string; dialogTitle?: string }): Promise<unknown>;
    }>;
    Clipboard: { setStringAsync(text: string): Promise<unknown> };
    /** A short note that stays up over the share dialog (Android's toast). */
    toast(text: string): void;
}

export type InviteShareHow = 'picture' | 'text';

/**
 * Shares the invite message, with the picture where there is one and the phone can carry it. Returns how it went out.
 * A picture that cannot be shared falls back to the message alone, so a tap never ends in nothing.
 */
export async function shareInviteWithPicture(message: string, pictureUri: string | null, deps: InviteShareDeps): Promise<InviteShareHow> {
    if (!pictureUri) {
        await deps.Share.share({ message });
        return 'text';
    }
    try {
        if (deps.platform === 'ios') {
            await deps.Share.share({ message, url: pictureUri });
            return 'picture';
        }
        const sharing = await deps.sharing();
        if (await sharing.isAvailableAsync()) {
            // Before the dialog opens: a picture is sent with a note that the words are copied, never with words that were not.
            await deps.Clipboard.setStringAsync(message);
            deps.toast(t('Invite message copied. Paste it with the picture.'));
            await sharing.shareAsync(pictureUri, { mimeType: 'image/png', dialogTitle: t('Join me on BeanPool') });
            return 'picture';
        }
    } catch {
        /* the message alone, below */
    }
    await deps.Share.share({ message });
    return 'text';
}

/** The part of expo-file-system/legacy the picture's file uses. */
export interface PictureFiles {
    cacheDirectory?: string | null;
    deleteAsync(uri: string, options?: { idempotent?: boolean }): Promise<unknown>;
    moveAsync(options: { from: string; to: string }): Promise<unknown>;
}

/**
 * Gives the captured picture its name, `beanpool-invite-<CODE>.png` (a chat shows the file's name), in the app's cache.
 * Returns the named file, or the capture itself where it cannot be renamed. `files` is asked for here, so a phone without the
 * module shares the capture as it is.
 */
export async function nameInvitePicture(captured: string, code: string, files: () => Promise<PictureFiles>): Promise<string> {
    try {
        const fs = await files();
        const cache = fs.cacheDirectory;
        if (!cache) return captured;
        const to = `${cache.endsWith('/') ? cache : `${cache}/`}${invitePictureName(code)}`;
        await fs.deleteAsync(to, { idempotent: true });
        await fs.moveAsync({ from: captured, to });
        return to;
    } catch {
        return captured;
    }
}
