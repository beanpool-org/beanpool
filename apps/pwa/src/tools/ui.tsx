/**
 * The tool template's layout primitives on the web (scratch/tools/DESIGN-tool-template-fable.md §1.5, slice T0.3): what a
 * tool's screens are built from, so every tool reads alike and holds at 320 px with 1.3x text. The phone's are
 * apps/native/tools/ui.tsx (T0.2), with the same names.
 *
 * - Every target at least 48 px tall; one column; nothing scrolls sideways: a word too long for the line breaks, a title
 *   wraps to two lines, a state line is cut to one with an ellipsis (its whole text is still read out).
 * - Colours from the central tokens only (tailwind.config.js: the app's `nature` scale and the shared library's `bp-*`
 *   roles), each with its dark pair. A `bp-*` class takes no `/NN` opacity: that compiles to nothing.
 * - No words of their own: a tool passes what it drew through t().
 *
 * A tool's folder imports this file as `../ui` (the fence in eslint.config.mjs allows it and the host, nothing else).
 */
import { createContext, useContext, useId, type ReactNode } from 'react';
import { useToolPhotoSrc } from './photos';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand';

/** A heading (or none) and what is under it. */
export function ToolSection({ title, children, testId }: { title?: string; children: ReactNode; testId?: string }) {
    return (
        <section className="mb-4 min-w-0" data-testid={testId}>
            {title ? (
                <h2 className="m-0 mb-1 px-1 min-w-0 break-words text-xs font-extrabold uppercase tracking-wider text-nature-600 dark:text-nature-300">
                    {title}
                </h2>
            ) : null}
            <div className="min-w-0 rounded-2xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 divide-y divide-nature-200 dark:divide-nature-800">
                {children}
            </div>
        </section>
    );
}

/**
 * One row: an icon (or a photo the host keeps, as a small square in its place), a title of up to two lines, a state line
 * cut to one, and a chevron when it opens something. The whole row is the target (at least 48 px) and its name is its
 * words, the title and the state, so a screen reader hears both.
 */
export function ToolRow({ icon, image, title, wrap, state, onClick, testId }: {
    icon?: string;
    /** A photo's uri from the host (host.photos.uri): drawn instead of the icon. */
    image?: string | null;
    title: string;
    /** The whole title, on as many lines as it takes (a record's own screen), rather than two at most. */
    wrap?: boolean;
    state?: string | null;
    onClick?: () => void;
    testId?: string;
}) {
    const inner = (
        <>
            {image ? <RowPhoto uri={image} /> : icon && <span aria-hidden="true" className="shrink-0 w-8 text-center text-xl leading-none">{icon}</span>}
            <span className="min-w-0 flex-1">
                <span className={`block min-w-0 break-words ${wrap ? '' : 'line-clamp-2'} text-[0.95rem] font-semibold text-nature-900 dark:text-white`}>{title}</span>
                {state && <span className="block min-w-0 truncate text-xs text-nature-600 dark:text-nature-300">{state}</span>}
            </span>
            {onClick && <span aria-hidden="true" className="shrink-0 text-lg text-nature-500 dark:text-nature-400">›</span>}
        </>
    );
    const cls = 'w-full min-h-[48px] flex items-center gap-3 px-3 py-2 text-left min-w-0';
    if (!onClick) return <div className={cls} data-testid={testId}>{inner}</div>;
    return (
        <button type="button" onClick={onClick} data-testid={testId}
            className={`${cls} bg-transparent border-0 cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-800 ${FOCUS}`}>
            {inner}
        </button>
    );
}

/** A label over its value, one column. */
export function ToolField({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="px-3 py-2 min-w-0">
            <div className="text-xs font-bold text-nature-600 dark:text-nature-300 break-words">{label}</div>
            <div className="text-[0.95rem] text-nature-900 dark:text-white break-words min-w-0">{children}</div>
        </div>
    );
}

/** A row's photo: a small square, decorative (the row's words name it). */
function RowPhoto({ uri }: { uri: string }) {
    const src = useToolPhotoSrc(uri);
    return (
        <span aria-hidden="true" className="shrink-0 w-10 h-10 rounded-lg overflow-hidden bg-nature-100 dark:bg-nature-800">
            {src && <img src={src} alt="" className="w-full h-full object-cover" />}
        </span>
    );
}

/**
 * Chips that wrap to another row rather than shrink their words; the picked one is pressed. `heading` shows the group's
 * label over the chips, as a field's label.
 */
export function ToolChips({ chips, picked, onPick, label, heading, testId }: {
    chips: readonly { id: string; label: string }[];
    picked: string | null;
    onPick: (id: string) => void;
    /** What the group of chips chooses, for a screen reader. */
    label: string;
    heading?: boolean;
    /** Each chip is `<testId>-<id>`. */
    testId?: string;
}) {
    const group = (
        <div role="group" aria-label={label} data-testid={testId} className="flex flex-wrap gap-2 min-w-0">
            {chips.map((c) => {
                const on = c.id === picked;
                return (
                    <button key={c.id} type="button" aria-pressed={on} onClick={() => onPick(c.id)} data-testid={testId ? `${testId}-${c.id}` : undefined}
                        className={`shrink-0 max-w-full min-h-[48px] px-4 rounded-full border text-sm font-semibold break-words cursor-pointer ${FOCUS} ${on
                            ? 'bg-bp-accent-fill text-bp-accent-on border-transparent'
                            : 'bg-white dark:bg-nature-900 text-nature-800 dark:text-nature-100 border-nature-300 dark:border-nature-700'}`}>
                        {c.label}
                    </button>
                );
            })}
        </div>
    );
    if (!heading) return group;
    return (
        <div className="min-w-0">
            <div aria-hidden="true" className="mb-1 text-xs font-bold text-nature-700 dark:text-nature-200 break-words">{label}</div>
            {group}
        </div>
    );
}

/**
 * A text box with its label over it, one column: one line, or several (`lines`) for longer words; the number keyboard
 * for `numeric`. At most `max` characters (the document holds each field to its bound in code points, so this is never
 * looser). A hint under it, or what is wrong with it in its place; both are read with it, and what is wrong is announced
 * as it shows (as the phone's twin does), the hint never.
 */
export function ToolInput({ label, value, onChange, max, lines, numeric, hint, error, testId }: {
    label: string;
    value: string;
    onChange: (next: string) => void;
    max: number;
    lines?: number;
    numeric?: boolean;
    hint?: string;
    error?: string | null;
    testId?: string;
}) {
    const id = useId();
    const noteId = `${id}-note`;
    const note = error || hint;
    const cls = `w-full min-w-0 min-h-[48px] px-3 py-2 rounded-xl border text-base bg-white dark:bg-nature-950 text-nature-900 dark:text-white ${error
        ? 'border-bp-danger-fill'
        : 'border-nature-300 dark:border-nature-700'} ${FOCUS}`;
    const common = {
        id, value, maxLength: max, 'aria-invalid': error ? true : undefined, 'aria-describedby': note ? noteId : undefined, 'data-testid': testId,
    };
    return (
        <div className="px-3 py-2 min-w-0" data-testid={testId ? `${testId}-field` : undefined}>
            <label htmlFor={id} className="block mb-1 text-xs font-bold text-nature-700 dark:text-nature-200 break-words">{label}</label>
            {lines && lines > 1
                ? <textarea {...common} rows={lines} onChange={(e) => onChange(e.target.value)} className={`${cls} resize-y`} />
                : <input {...common} type="text" inputMode={numeric ? 'numeric' : undefined} onChange={(e) => onChange(e.target.value)} className={cls} />}
            {/* What is wrong goes in a region that is there, empty, before it does: one made with its words in it is often not read out. */}
            <div aria-live="polite">
                {error ? <p id={noteId} className="m-0 mt-1 text-xs font-semibold text-bp-ink-danger break-words">{error}</p> : null}
            </div>
            {!error && hint ? <p id={noteId} className="m-0 mt-1 text-xs text-nature-600 dark:text-nature-300 break-words">{hint}</p> : null}
        </div>
    );
}

/** A photo the host keeps (host.photos.uri), as wide as the column and never taller than it is wide. */
export function ToolPhoto({ uri, label, testId }: { uri: string; label: string; testId?: string }) {
    const src = useToolPhotoSrc(uri);
    return (
        <div className="px-3 pt-3 min-w-0">
            <div className="w-full aspect-[4/3] rounded-xl overflow-hidden bg-nature-100 dark:bg-nature-800">
                {src
                    ? <img src={src} alt={label} data-testid={testId} className="w-full h-full object-cover" />
                    : <span role="img" aria-label={label} data-testid={testId} className="block w-full h-full" />}
            </div>
        </div>
    );
}

/** Inside a ToolLive, whose region announces a note: the note isn't a region of its own too, or it is read out twice. */
const InLive = createContext(false);

/**
 * A sentence under a section: a note, a hint. Wraps; never cut. `warning` for what needs the member's eye before they go
 * on, `danger` for what stopped. One that comes and goes as the member acts is drawn in a ToolLive, so it is announced as
 * it shows (as the phone's twin is); one drawn with the screen is a status.
 */
export function ToolNote({ text, tone, testId }: { text: string; tone?: 'warning' | 'danger'; testId?: string }) {
    const live = useContext(InLive);
    const look = tone === 'danger' ? 'font-semibold text-bp-ink-danger' : tone === 'warning' ? 'font-semibold text-bp-ink-warning' : 'text-nature-700 dark:text-nature-200';
    return <p role={tone && !live ? 'status' : undefined} data-testid={testId} className={`m-0 px-3 py-2 text-sm break-words min-w-0 ${look}`}>{text}</p>;
}

/**
 * Where a note that comes and goes is drawn (what stopped a change, what couldn't be checked): a region that is there,
 * empty, before the note is, so its words are announced as it shows; one made with its words in it is often not read out
 * (ToolInput's error does the same). Polite, as the phone's notes are. Empty, it draws nothing, not even a section's
 * divider.
 */
export function ToolLive({ children, testId }: { children?: ReactNode; testId?: string }) {
    const empty = children === null || children === undefined || children === false;
    return (
        <div aria-live="polite" data-testid={testId} className={`min-w-0${empty ? ' !border-0' : ''}`}>
            <InLive.Provider value>{children}</InLive.Provider>
        </div>
    );
}

/** A button: `primary` the screen's one main action, `quiet` the rest, `danger` what takes something away. */
export function ToolButton({ kind = 'quiet', onClick, children, testId, disabled }: {
    kind?: 'primary' | 'quiet' | 'danger';
    onClick: () => void;
    children: ReactNode;
    testId?: string;
    disabled?: boolean;
}) {
    const look = kind === 'primary'
        ? 'bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on border-transparent'
        : kind === 'danger'
            ? 'bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on border-transparent'
            : 'bg-white dark:bg-nature-900 hover:bg-nature-50 dark:hover:bg-nature-800 text-nature-900 dark:text-white border-nature-300 dark:border-nature-700';
    return (
        <button type="button" onClick={onClick} data-testid={testId} disabled={disabled}
            className={`min-h-[48px] max-w-full px-4 py-2 rounded-xl border text-sm font-bold text-center break-words cursor-pointer disabled:cursor-default disabled:opacity-60 ${look} ${FOCUS}`}>
            {children}
        </button>
    );
}

/** A screen with nothing in it yet: an icon, a heading, a line, and what can be done. */
export function ToolEmpty({ icon, title, line, children, testId }: {
    icon?: string;
    title: string;
    line?: string;
    children?: ReactNode;
    testId?: string;
}) {
    return (
        <div className="px-4 py-6 text-center min-w-0" data-testid={testId}>
            {icon && <div aria-hidden="true" className="text-4xl leading-none mb-2">{icon}</div>}
            <h2 className="m-0 mb-1 text-lg font-bold text-nature-900 dark:text-white break-words">{title}</h2>
            {line && <p className="m-0 mb-4 text-sm text-nature-600 dark:text-nature-300 break-words">{line}</p>}
            {children && <div className="flex flex-wrap justify-center gap-2 min-w-0">{children}</div>}
        </div>
    );
}
