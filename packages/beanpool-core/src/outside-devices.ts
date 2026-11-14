/**
 * Each device has its own mail from other communities (messages across communities X2b: scratch/fable-design/decisions/
 * DECISION-outside-door.md; DESIGN-cross-chat-voice-fable.md §3.5, §11 row X2b). The member's community holds an item until
 * every device that fetches their mail has confirmed it, so a line reaches each phone and browser signed in when it came,
 * and a device that drops an item (its door closed, say) never takes it from another whose door is open.
 *
 * A device names itself by a random id its app makes and keeps in its outside-chat store, gone at Sign Out: the phone's
 * utils/outside-mail.ts, the web's lib/outside-mail.ts. The server's half is apps/server/src/engine/relay-mail.ts.
 */
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { word } from './words.js';

/** A device's id, as the mailbox takes it (GET /api/mail?device=, POST /api/mail/confirm, POST /api/mail/device/forget). */
export const OUTSIDE_DEVICE_ID = /^[0-9a-f]{32}$/;

/** A new device id: 16 random bytes from the platform's CSPRNG, as hex. Nothing in it names the member or the device. */
export function newOutsideDeviceId(): string {
    return bytesToHex(randomBytes(16));
}

/** Beside the door's switch, on the phone and on the web: the switch is this device's own. */
export const OUTSIDE_DOOR_EACH_DEVICE = word('Each phone or browser you use has its own switch.');
/** In a chat's banner, on the phone and on the web: my own lines stay where I wrote them. */
export const OUTSIDE_WRITES_STAY_THERE = word('What you write on another phone or browser shows only there.');
