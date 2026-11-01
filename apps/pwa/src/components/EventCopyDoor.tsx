/**
 * Where Going and Interested stand on a member's copy on the global community (DESIGN-list-on-global-fable.md §6): the door's
 * words, and the way through it. `/?ask=<host>` is the Find card on that community for a member (App takes it), and for
 * a visitor the lobby, which keeps it across the join. Nothing is sent before Ask to join is tapped there.
 */
import { copyDoorButton, copyDoorLine, type EventCopy } from '@beanpool/core';

export function EventCopyDoor({ copy }: { copy: EventCopy }) {
    const button = copyDoorButton(copy);
    return (
        <div data-testid="event-copy-door" className="flex flex-col gap-2 min-w-0">
            <p className="m-0 text-sm font-semibold text-nature-800 dark:text-nature-200 break-words">{copyDoorLine(copy)}</p>
            {button && copy.from && (
                <a
                    data-testid="event-copy-ask"
                    href={`/?ask=${encodeURIComponent(copy.from.host)}`}
                    className="inline-flex items-center justify-center min-h-[48px] px-3 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-sm font-bold text-bp-commit-on no-underline text-center break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand focus-visible:ring-offset-1"
                >
                    {button}
                </a>
            )}
        </div>
    );
}
