/**
 * A long message folds with "…more" (Marty, 28 Oct), in every chat, sent and received. The rule and its one constant are
 * core's (chat-fold.ts); this is the phone's half: working out, from what the text drew, whether it needs folding.
 *
 * HOW IT MEASURES. A message whose text could run past the fold (mayFoldChatText) is drawn once with ONE LINE MORE THAN
 * THE FOLD allowed, and the text's own layout (onTextLayout) says how many lines it came to. Reporting 13 means it has
 * more than twelve, whether the platform reports every line the text has or only the ones it drew. A message that fits is
 * drawn as it always was; one that does not folds to twelve lines under a "…more" button. It is measured again when the
 * window's width or the font scale changes, since either moves where the lines break.
 *
 * AN OPEN MESSAGE IS NEVER CLAMPED TO BE MEASURED. It is drawn whole, and a Text with no numberOfLines reports every line
 * it has, so the count still says whether it is long.
 *
 * WHERE "OPEN" AND "MEASURED" LIVE. A list unmounts the rows it scrolls far away, so a message the member opened would
 * fold itself again on the way back, and every message coming back would be drawn clamped a line past the fold again,
 * then jump to its settled height. The list therefore holds both (ChatFoldProvider, in ChatMessageList): the open ones,
 * and what each message last measured as, so a row that returns starts out knowing. Per message, for as long as the
 * member stays in the chat, and never stored. A bubble drawn outside a list keeps its own open state and measures itself.
 */

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { CHAT_FOLD_LINES, mayFoldChatText } from '@beanpool/core';

/** What one measuring found, and the inputs it holds for: a different text, width or font scale is measured again. */
interface Measured {
    text: string;
    width: number;
    fontScale: number;
    long: boolean;
}

interface FoldContextValue {
    open: ReadonlySet<string>;
    toggle: (id: string) => void;
    /** Per message, what it last measured as. Not state: a row writes it when its own state already redraws that row. */
    measured: Map<string, Measured>;
}

const FoldContext = createContext<FoldContextValue | null>(null);

/** Holds which messages the member has opened, and what each measured as, for the life of the list. */
export function ChatFoldProvider({ children }: { children: React.ReactNode }) {
    const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
    const [measured] = useState(() => new Map<string, Measured>());
    const toggle = useCallback((id: string) => {
        setOpen((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            return next;
        });
    }, []);
    const value = useMemo(() => ({ open, toggle, measured }), [open, toggle, measured]);
    return <FoldContext.Provider value={value}>{children}</FoldContext.Provider>;
}

interface TextLayoutEvent {
    nativeEvent: { lines: readonly unknown[] };
}

export interface ChatFold {
    /** The words run past the fold at this width: draw them folded or open, with the control. */
    long: boolean;
    open: boolean;
    toggle: () => void;
    /** Spread onto the words' Text. Empty unless this message is still being measured. */
    measure: { numberOfLines?: number; onTextLayout?: (event: TextLayoutEvent) => void };
}

/**
 * `enabled` is false for a message that must never fold (one the member is editing, a tombstone): it is drawn whole, and
 * is never measured.
 */
export function useChatFold(id: string, text: string, enabled: boolean): ChatFold {
    const shared = useContext(FoldContext);
    const [ownOpen, setOwnOpen] = useState(false);
    const { width, fontScale } = useWindowDimensions();
    const memory = shared?.measured;
    // A row that comes back to a list starts from what it measured last time, so it is drawn settled on its first frame.
    const [measured, setMeasured] = useState<Measured | null>(() => memory?.get(id) ?? null);

    const candidate = enabled && mayFoldChatText(text);
    const known = measured && measured.text === text && measured.width === width && measured.fontScale === fontScale ? measured : null;

    const onTextLayout = useCallback((event: TextLayoutEvent) => {
        const found = { text, width, fontScale, long: event.nativeEvent.lines.length > CHAT_FOLD_LINES };
        memory?.set(id, found);
        setMeasured(found);
    }, [memory, id, text, width, fontScale]);

    const open = shared ? shared.open.has(id) : ownOpen;
    const toggle = useCallback(() => {
        if (shared) shared.toggle(id);
        else setOwnOpen((current) => !current);
    }, [shared, id]);

    // Measuring clamps the words a line past the fold so the count can tell "twelve" from "more"; an open message is drawn
    // whole instead, and reports every line it has.
    const measuring = open ? { onTextLayout } : { numberOfLines: CHAT_FOLD_LINES + 1, onTextLayout };

    return {
        long: candidate && known?.long === true,
        open,
        toggle,
        measure: candidate && !known ? measuring : {},
    };
}
