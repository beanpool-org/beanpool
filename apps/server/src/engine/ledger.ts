import { LedgerManager } from '@beanpool/core';

/**
 * Singleton LedgerManager instance for the server.
 * Shared across the state engine, audit services, and stateful wrappers.
 */
export const ledger = new LedgerManager();
