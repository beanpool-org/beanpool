import { useEffect, useState } from 'react';
import { FIND_COMMUNITY_WORDS, PLACE_CIRCLE_WORDS, circleKnockLine, circleKnockReady, circlePeopleLine, circleStartedLine, t, type CircleCard, type CircleKnockTrouble } from '@beanpool/core';
import { setCircleStarting } from '../lib/api';
import { circleIntents, knockForCircle, readCircleAsk, setCircleIntent, type CircleAsk } from '../lib/circle-intent';
import type { BeanPoolIdentity } from '../lib/identity';

const ROW = 'w-full min-h-[44px] px-4 rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-sm font-bold text-nature-900 dark:text-white cursor-pointer break-words disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
/** Ask to join, as AskToJoin draws it. */
const ASK = 'w-full min-h-[44px] mt-2 px-4 rounded-xl border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-sm font-bold cursor-pointer break-words disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const CARD = 'my-2 p-3 rounded-xl border border-nature-300 dark:border-nature-700';

/**
 * A place circle's own rows (Lounge L2, §3.3), the phone's PlaceCircleCard: how many are here, Start a community, and "I'm
 * starting one here", entry S8's row, which lives here and not loose on the Find card. Drawn on Home's Find card and in the
 * group's sheet. "Remind me to join when it starts" is this browser's own wish (lib/circle-intent.ts). Once a community has
 * retired the circle: what started, how long the chat stays, and Ask to join, the one tap that sends anything to it.
 */
export function PlaceCircleCard({ id, circle, identity, closed, onAsked, onStart, onChange }: {
    id: string;
    circle: CircleCard;
    identity?: BeanPoolIdentity | null;
    /** The group has closed: its sheet says so, and "Its chat stays for 30 days" would no longer be true. */
    closed?: boolean;
    /** A tap on Ask to join left a request. Whoever passes this draws how it fares (Home's waiting card); left out, the card says where to look. */
    onAsked?: () => void;
    /** Opens Start a community. Left out, the row isn't drawn: a button must do something. */
    onStart?: () => void;
    onChange?: (card: CircleCard) => void;
}) {
    const myPubkey = identity?.publicKey ?? null;
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [joinAsked, setJoinAsked] = useState(() => !!myPubkey && circleIntents(myPubkey).includes(id));
    /** What this browser holds about asking the community that retired it: null until read, so no button stands on a guess. */
    const [ask, setAsk] = useState<CircleAsk | null>(null);
    const [trouble, setTrouble] = useState<CircleKnockTrouble | null>(null);
    const [said, setSaid] = useState<string | null>(null);

    useEffect(() => {
        setJoinAsked(!!myPubkey && circleIntents(myPubkey).includes(id));
    }, [id, myPubkey]);

    useEffect(() => {
        setTrouble(null);
        setSaid(null);
    }, [id]);

    // This browser's own memory, on each read of the card. Nothing here goes to the community.
    useEffect(() => {
        if (!circle.doneAt || !myPubkey) { setAsk(null); return; }
        let alive = true;
        void readCircleAsk(myPubkey, id, circle.community?.url).then(held => { if (alive) setAsk(held); });
        return () => { alive = false; };
    }, [id, myPubkey, circle]);

    async function onAskToJoin() {
        if (!identity) return;
        setBusy(true);
        setTrouble(null);
        const r = await knockForCircle(identity, { ...circle, id });
        setTrouble(r.trouble);
        setSaid(r.said);
        setAsk(await readCircleAsk(identity.publicKey, id, circle.community?.url));
        setBusy(false);
        if (r.sent) onAsked?.();
    }

    if (circle.doneAt) {
        const canAsk = !!identity && !!ask && circleKnockReady(circle) && !ask.asked && !ask.cancelled && !ask.refused && !said;
        const knockLine = circleKnockLine(trouble ?? (ask?.refused ? 'refused' : null));
        return (
            <div className={CARD} data-testid="circle-card-done">
                <p dir="auto" className="m-0 text-sm font-bold text-nature-900 dark:text-white break-words" data-testid="circle-started-line">{circleStartedLine(circle.community)}</p>
                {canAsk && ask.wished && <p className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-200 break-words" data-testid="circle-reminded">{t(PLACE_CIRCLE_WORDS.reminded)}</p>}
                {canAsk && (
                    <button type="button" className={ASK} disabled={busy} aria-busy={busy} onClick={() => void onAskToJoin()} data-testid="circle-ask-join">
                        {t(PLACE_CIRCLE_WORDS.askToJoin)}
                    </button>
                )}
                {/* Always in the page, so a screen reader hears the line when it is put in. */}
                <div role="status">
                    {knockLine && <p className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-200 break-words" data-testid="circle-knock-line">{knockLine}</p>}
                    {said && <p className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-200 break-words" data-testid="circle-knock-said">{said}</p>}
                    {ask?.asked && !onAsked && <p className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-200 break-words" data-testid="circle-asked">{t(PLACE_CIRCLE_WORDS.asked)}</p>}
                </div>
                {!closed && <p className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-200 break-words" data-testid="circle-chat-stays">{t(PLACE_CIRCLE_WORDS.done)}</p>}
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
                {onStart && <button type="button" className={ROW} onClick={onStart} data-testid="circle-start">{t(FIND_COMMUNITY_WORDS.start)}</button>}
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
