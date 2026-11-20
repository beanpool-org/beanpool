/**
 * How the front door asks for an invite, per phone (DESIGN-onboarding-home-landing-fable.md §3.1 B, as amended by
 * DESIGN-ios-invite-paste-fable.md §4.1-§4.2; Marty, 21 Nov 2026: "Yes, all of Fable's picks").
 *
 * - **Android**: our own "I have an invite" reads the clipboard at that tap (Android 12+ shows its own small note).
 * - **iPhone, iOS 16 and later**: no button of ours ever reads the clipboard there (it would raise "Allow Paste?" every
 *   time). When the phone holds copied text, the door shows Apple's own paste button with its icon only, under our words
 *   "I have an invite"; otherwise our button opens the Your invite screen without reading anything.
 * - **iPhone, iOS 15**: Apple's button doesn't exist and neither does the pop-up: our button reads at the tap, as Android.
 *
 * Whatever a tap brings back is kept only if it is an invite (`inviteOnly`): anything else is dropped there, never shown in
 * a box and never sent anywhere.
 */
import { holdsInvite } from './invite-parser';

export interface InvitePhone {
    /** Platform.OS. */
    os: string;
    /** expo-clipboard's `isPasteButtonAvailable`: Apple's paste button exists (iOS 16 and later). */
    pasteButton: boolean;
}

/** What the front door draws for the invite: Apple's icon-only button in its tile, or our own button. */
export type InviteDoor = 'apple-tile' | 'our-button';

/**
 * Apple's tile only on an iPhone that has the button and holds copied text (`hasStringAsync`, which reads nothing and
 * shows no notice). Any other phone, or an iPhone with nothing copied: our own button.
 */
export function inviteDoor(phone: InvitePhone & { copiedText: boolean }): InviteDoor {
    return phone.os === 'ios' && phone.pasteButton && phone.copiedText ? 'apple-tile' : 'our-button';
}

/**
 * Whether OUR "I have an invite" reads the clipboard at its tap: Android, and an iPhone without Apple's button (iOS 15).
 * Never on iOS 16 and later, and never on any other platform.
 */
export function ourButtonReadsClipboard(phone: InvitePhone): boolean {
    if (phone.os === 'android') return true;
    if (phone.os === 'ios') return !phone.pasteButton;
    return false;
}

/** What a tap brought back, kept only if it is an invite (a link with `invite=`, an `INV-…` code); otherwise null. */
export function inviteOnly(raw: unknown): string | null {
    const text = typeof raw === 'string' ? raw.trim() : '';
    return text && holdsInvite(text) ? text : null;
}
