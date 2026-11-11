/**
 * The ⓘ beside Contacts (scratch/fable-design/DESIGN-private-contacts-fable.md §3.2, slice C4): what the private contacts
 * list is, in the design's words, with the true sentence about encryption (§3.3: two-person and group chats are end-to-end
 * encrypted, event and enterprise chats are not). A real dialog: focus inside, Escape closes, focus goes back.
 */
import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@beanpool/core';
import { useDialogFocus } from './dialog-focus';

/** The hover line on the Chat button (its title and aria-description), the same on both apps. */
export function contactsHoverLine(): string {
    return t('A private contacts list you take wherever you go. Only you can open it.');
}

export function ContactsInfo({ onClose }: { onClose: () => void }): ReactNode {
    const ref = useRef<HTMLDivElement>(null);
    useDialogFocus(ref, onClose);
    const lines = [
        t("A contacts list that is yours. Sign in on any phone or browser and it's there, in every community you belong to."),
        t("It is locked on this device with your account's key, the one your 12 words make. Only you can open it. Each of your communities keeps a locked copy for you. The people who run those servers can't read it."),
        t('Nobody is told they are in your list. BeanPool never matches phone numbers.'),
        t("Chats between two people and group chats are end-to-end encrypted, always: there is nothing to turn on. Event chats and enterprise chats are not: the community's server can read those."),
        t("It's optional. Nothing is taken from your phone unless you choose it here."),
    ];
    return createPortal(
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
            <div
                ref={ref}
                role="dialog"
                aria-modal="true"
                aria-labelledby="contacts-info-title"
                data-testid="contacts-info"
                onClick={(e) => e.stopPropagation()}
                style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', borderRadius: '16px', padding: '1.25rem', maxWidth: '28rem', width: '100%', maxHeight: '85vh', overflowY: 'auto' }}
            >
                <h2 id="contacts-info-title" style={{ fontSize: '1.1rem', margin: '0 0 0.75rem' }}>{t('Your private contacts')}</h2>
                <ul style={{ margin: '0 0 1rem', paddingLeft: '1.1rem', display: 'grid', gap: '0.6rem', fontSize: '0.92rem', lineHeight: 1.45 }}>
                    {lines.map((line) => <li key={line}>{line}</li>)}
                </ul>
                <button
                    type="button"
                    onClick={onClose}
                    className="bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on"
                    style={{ minHeight: '44px', padding: '0.5rem 1.25rem', borderRadius: '10px', border: 'none', font: 'inherit', fontWeight: 700, cursor: 'pointer' }}
                >
                    {t('Got it')}
                </button>
            </div>
        </div>,
        document.body,
    );
}
