import { useCallback, useEffect, useRef, useState } from 'react';
import type { DoorWorkDoor } from '@beanpool/core';
import { BUSY_LEVEL, busyLevelSentence, startDoorWork, type DoorWorkRun, type DoorWorkState } from './door-work';
import type { BeanPoolIdentity } from './identity';

/**
 * A door's work for a screen (utils/door-work.ts): started when the door opens, kept while the screen is up, stopped
 * when it goes or the member leaves the door. One run at a time per door (the challenge names one key and one door);
 * starting again for the same key and door keeps the run in hand.
 *
 * `busy` is the busy-level sentence (from level 3, with this phone's own estimate), counted down once a second while
 * the work runs, and null otherwise.
 */
export function useDoorWork() {
    const runs = useRef(new Map<DoorWorkDoor, DoorWorkRun>());
    const [states, setStates] = useState<Partial<Record<DoorWorkDoor, DoorWorkState>>>({});
    const [now, setNow] = useState(() => Date.now());

    const stop = useCallback((door?: DoorWorkDoor) => {
        for (const [d, run] of runs.current) {
            if (door && d !== door) continue;
            run.cancel();
            runs.current.delete(d);
        }
        setStates(s => {
            if (!door) return {};
            const next = { ...s };
            delete next[door];
            return next;
        });
    }, []);

    const start = useCallback((url: string, identity: BeanPoolIdentity, door: DoorWorkDoor): DoorWorkRun => {
        const held = runs.current.get(door);
        if (held && held.publicKey === identity.publicKey && held.state().phase !== 'cancelled') return held;
        held?.cancel();
        // The run reports its first state before startDoorWork returns, so it is named only once it exists: a state from a
        // run that has since been replaced is dropped.
        let made: DoorWorkRun | null = null;
        const run = startDoorWork({
            url, identity, door,
            onChange: (state) => {
                const mine = made;
                setStates(s => (mine && runs.current.get(door) !== mine ? s : { ...s, [door]: state }));
            },
        });
        made = run;
        runs.current.set(door, run);
        setStates(s => ({ ...s, [door]: run.state() }));
        return run;
    }, []);

    const runFor = useCallback((door: DoorWorkDoor): DoorWorkRun | null => runs.current.get(door) ?? null, []);

    useEffect(() => () => {
        for (const run of runs.current.values()) run.cancel();
        runs.current.clear();
    }, []);

    const words = states.words ?? null;
    const counting = !!words && words.phase === 'solving' && (words.level ?? 0) >= BUSY_LEVEL && words.estimateMs !== null;
    useEffect(() => {
        if (!counting) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [counting]);

    return {
        start,
        stop,
        runFor,
        state: (door: DoorWorkDoor): DoorWorkState | null => states[door] ?? null,
        busy: words ? busyLevelSentence(words, now) : null,
    };
}
