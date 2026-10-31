import { useEffect, useState } from 'react';
import { FIND_COMMUNITY_WORDS, PLACE_CIRCLE_WORDS, circlePeopleLine, circleStartedLine, t, type CircleCard } from '@beanpool/core';
import { setCircleStarting } from '../lib/api';
import { circleIntents, setCircleIntent } from '../lib/circle-intent';

const ROW = 'w-full min-h-[44px] px-4 rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-sm font-bold text-nature-900 dark:text-white cursor-pointer break-words disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const CARD = 'my-2 p-3 rounded-xl border border-nature-300 dark:border-nature-700';

/**
 * A place circle's own rows (Lounge L2, §3.3), the phone's PlaceCircleCard: how many are here, Start a community, and "I'm
 * starting one here", entry S8's row, which lives here and not loose on the Find card. Drawn on Home's Find card and in the
 * group's sheet. "Join when it starts" is this browser's own wish (lib/circle-intent.ts). Once a community has retired
 * the circle: what started, and how long the chat stays.
 */
export function PlaceCircleCard({ id, circle, myPubkey, onStart, onChange }: {
    id: string;
    circle: CircleCard;
    myPubkey?: string | null;
    onStart: () => void;
    onChange?: (card: CircleCard) => void;
}) {
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [joinAsked, setJoinAsked] = useState(() => !!myPubkey && circleIntents(myPubkey).includes(id));

    useEffect(() => {
        setJoinAsked(!!myPubkey && circleIntents(myPubkey).includes(id));
    }, [id, myPubkey]);

    if (circle.doneAt) {
        return (
            <div className={CARD} data-testid="circle-card-done">
                <p dir="auto" className="m-0 text-sm font-bold text-nature-900 dark:text-white break-words" data-testid="circle-started-line">{circleStartedLine(circle.community)}</p>
                <p className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-200 break-words">{t(PLACE_CIRCLE_WORDS.done)}</p>
            </div>
        );
    }

    const people = circlePeopleLine(circle.people);

    async function onStarting() {
        setBusy(true);
        setNote(null);
        try {
            onChange?.(await setCircleStarting(id, circle.starting !== 'you'));
        } catch (e: any) {
            setNote(e?.message || t("That didn't go through. Try again."));
        } finally {
            setBusy(false);
        }
    }

    function onJoinWhenStarts() {
        if (!myPubkey) return;
        const next = !joinAsked;
        setCircleIntent(myPubkey, id, next);
        setJoinAsked(next);
    }

    return (
        <div className={CARD} data-testid="circle-card">
            {people && <p className="m-0 mb-1 text-sm font-bold text-nature-900 dark:text-white break-words" data-testid="circle-people">{people}</p>}
            {circle.starting === 'someone' && <p className="m-0 mb-1 text-sm text-nature-800 dark:text-nature-100 break-words" data-testid="circle-someone-starting">{t(PLACE_CIRCLE_WORDS.someoneStarting)}</p>}
            {circle.starting === 'you' && <p className="m-0 mb-1 text-sm text-nature-800 dark:text-nature-100 break-words" data-testid="circle-you-starting">{t(PLACE_CIRCLE_WORDS.youAreStarting)}</p>}
            <div className="flex flex-col gap-2">
                <button type="button" className={ROW} onClick={onStart} data-testid="circle-start">{t(FIND_COMMUNITY_WORDS.start)}</button>
                {circle.starting !== 'someone' && (
                    <button type="button" className={ROW} disabled={busy} onClick={() => void onStarting()} data-testid="circle-starting">
                        {circle.starting === 'you' ? t(PLACE_CIRCLE_WORDS.notStarting) : t(PLACE_CIRCLE_WORDS.starting)}
                    </button>
                )}
                {circle.starting !== 'you' && (
                    <button type="button" className={ROW} aria-pressed={joinAsked} onClick={onJoinWhenStarts} data-testid="circle-join-when">
                        {joinAsked ? t(PLACE_CIRCLE_WORDS.joinWhenStartsOn) : t(PLACE_CIRCLE_WORDS.joinWhenStarts)}
                    </button>
                )}
            </div>
            {note && <p role="status" className="m-0 mt-1 text-sm text-nature-800 dark:text-nature-100 break-words" data-testid="circle-note">{note}</p>}
        </div>
    );
}
