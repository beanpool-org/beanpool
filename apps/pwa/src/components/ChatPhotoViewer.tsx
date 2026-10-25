/**
 * A chat photo full screen, over the chat, until tapped, clicked or closed (parity gap 4, DESIGN-group-chat-photos-fable.md §2.3).
 *
 * Parity with the phone's ChatPhotoViewer (apps/native/components/chat/ChatPhoto.tsx:67):
 * - Shows the SAME 800 px copy the chat already holds, fitted to the screen (never upscaled past its own size; memory photos-stay-800px).
 * - A real dialog (`role="dialog"`, `aria-modal="true"`): focus into the close button on open, returned to what opened it on close.
 * - Backdrop click and Escape close it; the window capture keydown listener pattern from PictureCropDialog.tsx intercepts Escape
 *   before any page listener can hear it.
 * - Same accessible names as the phone: "Dismiss full-size photo", "Close photo", "Full-size photo".
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@beanpool/core';

export interface ChatPhotoViewerProps {
    uri: string | null;
    onClose: () => void;
}

const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ChatPhotoViewer({ uri, onClose }: ChatPhotoViewerProps): ReactNode {
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const closeBtnRef = useRef<HTMLButtonElement | null>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    // Focus into close button on open, return to opener on close
    useLayoutEffect(() => {
        if (!uri) return;
        const opener = document.activeElement as HTMLElement | null;
        closeBtnRef.current?.focus();
        return () => {
            if (opener && opener !== document.body && opener.isConnected) {
                opener.focus?.();
            }
        };
    }, [uri]);

    // Window capture keydown listener: catches Escape and handles Tab trapping
    const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
    onKey.current = (e: KeyboardEvent) => {
        const mine = dialogRef.current;
        if (!mine) return;
        const open = document.querySelectorAll('[role="dialog"]');
        if (open[open.length - 1] !== mine) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeRef.current();
            return;
        }

        if (e.key !== 'Tab') return;
        const items = Array.from(mine.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const at = document.activeElement;
        if (!at || !mine.contains(at)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && at === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && at === last) {
            e.preventDefault();
            first.focus();
        }
    };

    useLayoutEffect(() => {
        if (!uri) return;
        const listen = (e: KeyboardEvent) => onKey.current(e);
        window.addEventListener('keydown', listen, true);
        return () => window.removeEventListener('keydown', listen, true);
    }, [uri]);

    if (!uri) return null;

    return createPortal(
        <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('Full-size photo')}
            data-testid="chat-photo-viewer"
            className="fixed inset-0 flex items-center justify-center select-none"
            style={{
                zIndex: 1300,
                backgroundColor: 'var(--image-viewer-bg)',
            }}
        >
            {/* Backdrop click dismisses */}
            <button
                type="button"
                aria-label={t('Dismiss full-size photo')}
                onClick={onClose}
                className="absolute inset-0 w-full h-full border-0 bg-transparent cursor-pointer p-0 m-0"
                tabIndex={0}
            />

            {/* Photo container: never upscaled past its own natural size (width: auto, height: auto, max: min(100%, 800px)) */}
            <div
                className="relative pointer-events-none flex items-center justify-center w-full h-full p-2 sm:p-6"
                style={{ boxSizing: 'border-box' }}
            >
                <img
                    src={uri}
                    alt={t('Full-size photo')}
                    className="pointer-events-auto select-none rounded-lg"
                    style={{
                        maxWidth: 'min(100%, 800px)',
                        maxHeight: 'min(100%, 800px)',
                        width: 'auto',
                        height: 'auto',
                        objectFit: 'contain',
                        display: 'block',
                    }}
                />
            </div>

            {/* Close button */}
            <button
                ref={closeBtnRef}
                type="button"
                aria-label={t('Close photo')}
                onClick={onClose}
                className="absolute top-3 right-3 sm:top-6 sm:right-6 min-w-[44px] min-h-[44px] w-11 h-11 sm:w-12 sm:h-12 rounded-full border-0 flex items-center justify-center cursor-pointer text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white transition-opacity"
                style={{
                    backgroundColor: 'var(--image-viewer-close-bg)',
                }}
            >
                <span aria-hidden="true" className="text-2xl leading-none font-bold">✕</span>
            </button>
        </div>,
        document.body,
    );
}
