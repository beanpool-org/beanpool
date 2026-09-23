/**
 * Emitting a DeviceEventEmitter event from code that also runs outside React Native.
 *
 * `utils/db.ts` is loaded by the vitest suite in plain Node, where a top-level
 * `import 'react-native'` blows up — which is why the emitters in it have always reached
 * DeviceEventEmitter through a lazy `require` wrapped in a try/catch.
 *
 * That works on a phone and is invisible to a test: `require` does not merely return a mock
 * under vitest, it THROWS (it tries to parse React Native's own flow-typed source), so the
 * catch swallows every emit and `vi.mock('react-native')` never gets a look in. Anything that
 * decides WHETHER to emit — such as "did this sync really change the viewer's own row?" —
 * could not be tested at all.
 *
 * One named seam fixes that: the rule lives in db.ts and is testable by mocking this module,
 * while the untestable RN plumbing is isolated here where there is nothing left to get wrong.
 */
export function emitAppEvent(name: string, payload?: unknown): void {
    try {
        const { DeviceEventEmitter } = require('react-native');
        DeviceEventEmitter.emit(name, payload);
    } catch {
        // Not in a React Native runtime (vitest, a script) — nothing is listening anyway.
    }
}
