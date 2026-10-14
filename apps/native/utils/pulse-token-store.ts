/**
 * Where the phone keeps each Pulse channel's platform sign-in (utils/pulse-oauth.ts: the TikTok or Instagram access and
 * refresh tokens), and how they all leave with the account.
 *
 * - This phone only. Each is written readable only while the phone is unlocked and never carried to another phone, as the
 *   account's key is (identity.ts `KEY_ITEM_OPTIONS`): an iPhone backup restored onto a new phone no longer brings them.
 *   On an iPhone the setting takes effect only when the item is made, never on a write over one already there, so every
 *   write removes the item first. A write that fails after that leaves the channel to be connected again, never a token
 *   kept with the old setting.
 * - They leave with the account. A long-lived platform token outlived Sign Out and Replace, and the next account on the
 *   phone that landed on the same channel read it straight back (FABLE-sec-native MEDIUM-2, 2026-10-01). Secure storage
 *   can't list its items, so the channels with a token are kept in a list of their own, written before the token, and
 *   {@link forgetAllPulseTokens} removes every one (identity.ts `wipeIdentity`, `wipeIdentityScopedStorage`).
 *
 * Every item's key is letters, digits and `_` around the channel id: secure storage refuses a key with a colon.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const isWeb = Platform.OS === 'web';

/** The channels with a token on this phone: a JSON list of channel ids. */
export const PULSE_TOKEN_CHANNELS_KEY = 'pulse_oauth_channels';

export const PULSE_TOKEN_ITEM_OPTIONS: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export function pulseTokenKey(channelId: string): string {
    return `pulse_oauth_token_${channelId}`;
}

async function readItem(key: string): Promise<string | null> {
    if (isWeb) return localStorage.getItem(key);
    return SecureStore.getItemAsync(key);
}

/** A token: made afresh, so an iPhone gives it this item's setting (see above). */
async function writeTokenItem(key: string, value: string): Promise<void> {
    if (isWeb) {
        localStorage.setItem(key, value);
        return;
    }
    await SecureStore.deleteItemAsync(key);
    await SecureStore.setItemAsync(key, value, PULSE_TOKEN_ITEM_OPTIONS);
}

/** The list of channels: written over, never removed first, so a failed write can't lose it. It holds no secret. */
async function writeChannels(channels: string[]): Promise<void> {
    const raw = JSON.stringify(channels);
    if (isWeb) {
        localStorage.setItem(PULSE_TOKEN_CHANNELS_KEY, raw);
        return;
    }
    await SecureStore.setItemAsync(PULSE_TOKEN_CHANNELS_KEY, raw, PULSE_TOKEN_ITEM_OPTIONS);
}

async function removeItem(key: string): Promise<void> {
    if (isWeb) {
        localStorage.removeItem(key);
        return;
    }
    await SecureStore.deleteItemAsync(key);
}

/** The channels on the list; null when there is no list at all. */
async function channelsWithTokens(): Promise<string[] | null> {
    const raw = await readItem(PULSE_TOKEN_CHANNELS_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string' && c.length > 0) : [];
    } catch {
        return [];
    }
}

/** Every change to the tokens and their list waits its turn, so two writes can't lose a channel from the list. */
let turn: Promise<unknown> = Promise.resolve();
function inTurn<T>(job: () => Promise<T>): Promise<T> {
    const run = turn.then(job);
    turn = run.catch(() => {});
    return run;
}

export function readPulseToken(channelId: string): Promise<string | null> {
    return readItem(pulseTokenKey(channelId));
}

/** Keeps a channel's token: on the list first, so a token is never on the phone without the list naming it. */
export function writePulseToken(channelId: string, raw: string): Promise<void> {
    return inTurn(async () => {
        const channels = (await channelsWithTokens()) ?? [];
        if (!channels.includes(channelId)) await writeChannels([...channels, channelId]);
        await writeTokenItem(pulseTokenKey(channelId), raw);
    });
}

/** Removes a channel's token (Disconnect), then its place on the list. */
export function deletePulseToken(channelId: string): Promise<void> {
    return inTurn(async () => {
        await removeItem(pulseTokenKey(channelId));
        const channels = await channelsWithTokens();
        if (channels?.includes(channelId)) await writeChannels(channels.filter((c) => c !== channelId));
    });
}

/**
 * Every Pulse token on this phone goes, as the account leaves it. Never throws: the account's leaving is never held up by
 * it. A token that can't be removed stays on the list, so the next account to leave the phone tries it again; why goes to
 * the log. With no list, nothing in secure storage is touched.
 */
export function forgetAllPulseTokens(): Promise<void> {
    return inTurn(async () => {
        const channels = await channelsWithTokens();
        if (channels === null) return;
        const kept: string[] = [];
        for (const channelId of channels) {
            try {
                await removeItem(pulseTokenKey(channelId));
            } catch (e) {
                console.error('[Pulse] A channel token could not be removed from this phone', e);
                kept.push(channelId);
            }
        }
        if (kept.length > 0) await writeChannels(kept);
        else await removeItem(PULSE_TOKEN_CHANNELS_KEY);
    }).catch((e) => {
        console.error('[Pulse] The channel tokens could not be removed from this phone', e);
    });
}
