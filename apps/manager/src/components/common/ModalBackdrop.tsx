import React, { useEffect, useRef } from 'react';

/**
 * The dimmed overlay every Settings modal and wizard sits in. It closes the modal the ways a phone user expects, not
 * only from the ✕: a tap on the backdrop beside the card, Escape, and the phone's Back button, which closes the
 * modal instead of leaving Settings.
 *
 * Each open modal is a history entry carrying `bpModal: <depth>` on top of the screen's own entry (see
 * useSettingsHistory in PhoneNav.tsx), so Back pops the modal first. Modals can stack (a wizard opened from member
 * detail): Escape and Back close only the top one.
 *
 * `dismissable={false}` holds the modal open while it cannot be left (a request in flight): the backdrop and Escape do
 * nothing, and Back leaves it where it is.
 */
type ModalBackdropProps = React.HTMLAttributes<HTMLDivElement> & {
    onClose: () => void;
    dismissable?: boolean;
    children: React.ReactNode;
};

/**
 * Open modals, top last. A modal inside another one's overlay (a wizard opened from member detail) always sits above
 * it, even when both mount together: React runs the inner one's effect first.
 */
type OpenModal = { el: HTMLElement | null };
const openModals: OpenModal[] = [];
let historySyncQueued = false;
/** A `history.go` of ours has not landed yet: the entry on top is a closed modal's and must not be reused. */
let traversalPending = false;
let traversalListener = false;

function modalDepth(state: unknown): number {
    const d = (state as { bpModal?: unknown } | null)?.bpModal;
    return typeof d === 'number' ? d : 0;
}

/**
 * After modals close from the page (✕, Escape, backdrop, Save), drop their history entries, or the next Back would be
 * spent on a modal that is already shut. Queued, so a wizard and the modal under it closing together go back once.
 */
function dropClosedModalEntries() {
    if (historySyncQueued) return;
    historySyncQueued = true;
    setTimeout(() => {
        historySyncQueued = false;
        const extra = modalDepth(window.history.state) - openModals.length;
        if (extra <= 0) return;
        if (!traversalListener) {
            traversalListener = true;
            window.addEventListener('popstate', () => { traversalPending = false; });
        }
        traversalPending = true;
        window.history.go(-extra);
    }, 0);
}

export function ModalBackdrop({ onClose, dismissable = true, children, onMouseDown, onClick, style, ...rest }: ModalBackdropProps) {
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const dismissableRef = useRef(dismissable);
    dismissableRef.current = dismissable;
    // A press that starts in the card and ends on the backdrop (selecting text in a field) is not a tap outside.
    const pressedInCard = useRef(false);
    const overlayRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const me: OpenModal = { el: overlayRef.current };
        const inside = openModals.findIndex((m) => Boolean(me.el && m.el && me.el.contains(m.el)));
        if (inside >= 0) openModals.splice(inside, 0, me); else openModals.push(me);
        const depthOf = () => openModals.indexOf(me) + 1;
        const pushEntry = (depth: number) => window.history.pushState({ ...(window.history.state ?? {}), bpModal: depth }, '');
        // A modal opened as another closes (in the same click) takes over its entry, unless we are already going back
        // past that entry, in which case it needs one of its own.
        if (traversalPending || modalDepth(window.history.state) < openModals.length) pushEntry(openModals.length);

        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || openModals[openModals.length - 1] !== me) return;
            if (dismissableRef.current) onCloseRef.current();
        };
        const onPop = (e: PopStateEvent) => {
            if (modalDepth(e.state) >= depthOf()) return;
            if (dismissableRef.current) onCloseRef.current();
            else pushEntry(depthOf());
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('popstate', onPop);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('popstate', onPop);
            openModals.splice(openModals.indexOf(me), 1);
            dropClosedModalEntries();
        };
    }, []);

    return (
        <div
            {...rest}
            ref={overlayRef}
            // Most modals sit in a `space-y-*` stack, whose margin would push a fixed overlay down off the top bar.
            style={{ margin: 0, ...style }}
            data-bp-modal=""
            onMouseDown={(e) => {
                pressedInCard.current = e.target !== e.currentTarget;
                onMouseDown?.(e);
            }}
            onClick={(e) => {
                if (e.target === e.currentTarget && !pressedInCard.current && dismissableRef.current) onCloseRef.current();
                pressedInCard.current = false;
                onClick?.(e);
            }}
        >
            {children}
        </div>
    );
}
