/**
 * The Start something sheet's rows, order and navigation targets (Fable 5.1 design §3.2, §5 S1, S2).
 * Pure row table comes from @beanpool/core; native adds its startTarget navigation helper.
 */

export {
    startRows,
    type StartRow,
    type StartRowKey,
    type StartRowSection,
    type StartRowsOptions,
} from '@beanpool/core';
import type { StartRowKey } from '@beanpool/core';

export type StartTarget =
    | { modal: 'chat' }
    | { modal: 'decision' }
    | { pathname: '/propose-project'; params: { kind: 'bounded' | 'ongoing' } }
    | { pathname: '/(tabs)/market'; params: { new: 'poll' | 'event' } };

/**
 * Pure target for each row: route with parameters or modal identifier.
 */
export function startTarget(key: StartRowKey): StartTarget {
    switch (key) {
        case 'chat':
            return { modal: 'chat' };
        case 'project':
            return { pathname: '/propose-project', params: { kind: 'bounded' } };
        case 'enterprise':
            return { pathname: '/propose-project', params: { kind: 'ongoing' } };
        case 'decision':
            return { modal: 'decision' };
        case 'poll':
            return { pathname: '/(tabs)/market', params: { new: 'poll' } };
        case 'event':
            return { pathname: '/(tabs)/market', params: { new: 'event' } };
    }
}
