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
import type { ReactNode } from 'react';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand';

/** A heading and what is under it. */
export function ToolSection({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
    return (
        <section className="mb-4 min-w-0" data-testid={testId}>
            <h2 className="m-0 mb-1 px-1 min-w-0 break-words text-xs font-extrabold uppercase tracking-wider text-nature-600 dark:text-nature-300">
                {title}
            </h2>
            <div className="min-w-0 rounded-2xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 divide-y divide-nature-200 dark:divide-nature-800">
                {children}
            </div>
        </section>
    );
}

/**
 * One row: an icon, a title of up to two lines, a state line cut to one, and a chevron when it opens something. The whole
 * row is the target (at least 48 px) and its name is its words, the title and the state, so a screen reader hears both.
 */
export function ToolRow({ icon, title, state, onClick, testId }: {
    icon?: string;
    title: string;
    state?: string | null;
    onClick?: () => void;
    testId?: string;
}) {
    const inner = (
        <>
            {icon && <span aria-hidden="true" className="shrink-0 w-8 text-center text-xl leading-none">{icon}</span>}
            <span className="min-w-0 flex-1">
                <span className="block min-w-0 break-words line-clamp-2 text-[0.95rem] font-semibold text-nature-900 dark:text-white">{title}</span>
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

/** Chips that wrap to another row rather than shrink their words; the picked one is pressed. */
export function ToolChips({ chips, picked, onPick, label }: {
    chips: readonly { id: string; label: string }[];
    picked: string | null;
    onPick: (id: string) => void;
    /** What the group of chips chooses, for a screen reader. */
    label: string;
}) {
    return (
        <div role="group" aria-label={label} className="flex flex-wrap gap-2 min-w-0">
            {chips.map((c) => {
                const on = c.id === picked;
                return (
                    <button key={c.id} type="button" aria-pressed={on} onClick={() => onPick(c.id)}
                        className={`shrink-0 max-w-full min-h-[48px] px-4 rounded-full border text-sm font-semibold break-words cursor-pointer ${FOCUS} ${on
                            ? 'bg-bp-chip-accent-tint text-bp-chip-accent-ink border-bp-chip-accent-border'
                            : 'bg-white dark:bg-nature-900 text-nature-800 dark:text-nature-100 border-nature-300 dark:border-nature-700'}`}>
                        {c.label}
                    </button>
                );
            })}
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
