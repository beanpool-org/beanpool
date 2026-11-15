/**
 * The web's Text message for an invite from a contact (scratch/fable-design/DESIGN-private-contacts-fable.md §3.8; Damo via
 * Marty, 15 Nov: the web sheet offered only Copy). The phone app hands core's link the phone's own OS (Platform.OS); a
 * browser can only say which phone it runs on in its user agent, so this reads it there.
 *
 * Apple's Messages (an iPhone, an iPad, a Mac: an iPad asks for the Mac site, so its Safari says Macintosh) reads the body
 * after `&`; Android's text apps, and anything else, read it after `?` as RFC 5724 writes it. The number is the contact's
 * first one with digits, stripped to digits and a leading `+` by core's contactSmsLink. The link is opened on this device:
 * neither it nor the number is ever sent anywhere.
 */
import { contactSmsLink } from '@beanpool/core';

/** Which text app a browser with this user agent hands an sms: link to. */
export function smsKind(userAgent: string): 'ios' | 'android' {
    return /\b(iPhone|iPad|iPod|Macintosh)\b/.test(userAgent) ? 'ios' : 'android';
}

/** The number Text message uses: the first of the contact's numbers that has digits, or null for none. */
export function textNumber(phones: readonly string[]): string | null {
    return phones.find((p) => contactSmsLink(p, '', 'android') !== null) ?? null;
}

/** The sms: link with the contact's number and the whole message, for a browser with this user agent; null with no number. */
export function contactTextLink(phones: readonly string[], message: string, userAgent: string): string | null {
    const phone = textNumber(phones);
    return phone === null ? null : contactSmsLink(phone, message, smsKind(userAgent));
}
