import { updateNodeConfig, getNodeConfig } from './dist/state-engine.js';
import { db } from './dist/db/db.js';

let c = updateNodeConfig({ publishLocation: false, publishMembers: false, publishContacts: false, publishHealth: false, serviceRadius: {lat: 1, lng: 1, radiusKm: 10} });
console.log("update:", c);
console.log("get:", getNodeConfig());
