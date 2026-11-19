/**
 * The door's work at a cheap target, for every web test that solves it (#3296's WebJoin.check fix, closed for the class
 * after the 19 Nov nightly: WebJoin.words' "refused work (the node restarted, say)" timed out at 30 s under load while it
 * still hashed the real target). Each try hashes the try's own head (the challenge's hash, the part, the counter) and not
 * the 64 KB of zeros after it. The solver and the stubbed node both use it, so a join still has to carry counters that
 * solve this challenge's puzzle for this key and door; only each try is cheap. With the real hash, a join hashed about
 * 200 MB on the test's own thread (about 1.4 s alone, past the wait during the full parallel run). The real hash is
 * core's door-work tests' and lib/door-work.test.ts's to check, and stays theirs.
 */
import { DOOR_WORK_MESSAGE_BYTES, DOOR_WORK_PAD_BYTES, doorWorkSha256, type DoorWorkDigestSync } from '@beanpool/core/door-work';

let hashed = 0;

/** The cheap digest: the stubbed node checks counters with it, and the test's solver solves with it. */
export const cheapDoorWorkDigest: DoorWorkDigestSync = (message) => {
    const head = message.subarray(0, DOOR_WORK_MESSAGE_BYTES - DOOR_WORK_PAD_BYTES);
    hashed += head.length;
    return doorWorkSha256(head);
};

/** The bytes the cheap digest has hashed since the last `resetCheapDoorWorkHashed()`. */
export function cheapDoorWorkHashed(): number {
    return hashed;
}

export function resetCheapDoorWorkHashed(): void {
    hashed = 0;
}
