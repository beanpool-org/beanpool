/**
 * Where Going and Interested stand on a member's copy on the global community, and where a listing's buttons stand with its
 * `line` (DESIGN-list-on-global-fable.md §6): the door's words, and the way through it. `/?ask=<host>` is the Find card on that community for a member (App takes it), and for
 * a visitor the lobby, which keeps it across the join. Nothing is sent before Ask to join is tapped there.
 * The tap keeps the listing the copy stands for, at its community (slice G4, lib/visitor-lobby.ts keepLinkedPost with a host),
 * so the yes's Join hands it to that community's page and the member lands on it there.
 */
import { copyDoorButton, copyDoorLine, type EventCopy } from '@beanpool/core';
import { keepLinkedPost } from '../lib/visitor-lobby';

export function EventCopyDoor({ copy, line }: { copy: EventCopy; line?: string }) {
    const button = copyDoorButton(copy);
    const keepListing = () => {
        if (copy.from?.postId) keepLinkedPost(copy.from.postId, Date.now(), copy.from.host);
    };
    return (
        <div data-testid="event-copy-door" className="flex flex-col gap-2 min-w-0">
            <p className="m-0 text-sm font-semibold text-nature-800 dark:text-nature-200 break-words">{line ?? copyDoorLine(copy)}</p>
            {button && copy.from && (
                <a
                    data-testid="event-copy-ask"
                    href={`/?ask=${encodeURIComponent(copy.from.host)}`}
                    onClick={keepListing}
                    className="inline-flex items-center justify-center min-h-[48px] px-3 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-sm font-bold text-bp-commit-on no-underline text-center break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand focus-visible:ring-offset-1"
                >
                    {button}
                </a>
            )}
        </div>
    );
}
