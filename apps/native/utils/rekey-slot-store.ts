/**
 * Where a re-key ask's record lives on the phone (utils/rekey-redeem.ts `RekeySlot`): the secure store, as the phone's
 * identity, because a key the ask made is in it, words and all, until the admin binds it. The web build keeps it in
 * localStorage, beside its identity. One record: a phone asks for one account at a time.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { KEY_ITEM_OPTIONS } from './identity';
import type { RekeySlot, RekeySlotStore } from './rekey-redeem';

const KEY = 'beanpool-rekey-ask';
const isWeb = Platform.OS === 'web';

function parse(raw: string | null): RekeySlot | null {
    if (!raw) return null;
    try {
        const s = JSON.parse(raw);
        return s && typeof s.community === 'string' && typeof s.code === 'string' && typeof s.publicKey === 'string' ? s as RekeySlot : null;
    } catch {
        return null;
    }
}

export const rekeySlotStore: RekeySlotStore = {
    async get() {
        try {
            return parse(isWeb ? localStorage.getItem(KEY) : await SecureStore.getItemAsync(KEY));
        } catch {
            return null;
        }
    },
    async set(slot) {
        const raw = JSON.stringify(slot);
        if (isWeb) localStorage.setItem(KEY, raw);
        else await SecureStore.setItemAsync(KEY, raw, KEY_ITEM_OPTIONS);
    },
    async clear() {
        if (isWeb) localStorage.removeItem(KEY);
        else await SecureStore.deleteItemAsync(KEY);
    },
};
