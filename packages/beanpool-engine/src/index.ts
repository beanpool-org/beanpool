// @beanpool/engine — the shared, db-backed node engine.
//
// Sits between @beanpool/core (pure protocol math, no database) and the apps
// (the node server and the fleet manager). Every function here takes a
// better-sqlite3 `Database` handle as its first argument rather than closing
// over a module-level singleton, so the exact same logic can run against the
// node's live database OR against any number of replica databases the manager
// holds — the property that lets the manager independently verify what nodes
// self-report without maintaining a second, drifting copy of the rules.
export * from './trust.js';
export * from './audit.js';
export * from './members.js';


