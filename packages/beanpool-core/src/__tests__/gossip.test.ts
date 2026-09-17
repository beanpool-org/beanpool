import { describe, it, expect } from 'vitest';
import { GossipManager } from '../gossip.js';
import { PassportManager } from '../passport.js';
import { RouterManager, ResourcePin } from '../router.js';

describe('GossipManager', () => {
    it('should process incoming gossip correctly with LWW logic', () => {
        const passportManager = new PassportManager('node-1');
        const routerManager = new RouterManager();
        const gossipManager = new GossipManager(passportManager, routerManager);

        const pin1: ResourcePin = {
            id: 'pin1',
            providerId: 'node1',
            type: 'Offer',
            location: { lat: 0, lng: 0 },
            description: 'desc1',
            updatedAt: new Date('2026-01-01').toISOString(),
            expiresAt: new Date('2026-12-31').toISOString(),
        };

        routerManager.addPin(pin1);

        const incomingPin1Newer: ResourcePin = {
            id: 'pin1',
            providerId: 'node1',
            type: 'Offer',
            location: { lat: 0, lng: 0 },
            description: 'desc1-updated',
            updatedAt: new Date('2026-01-02').toISOString(),
            expiresAt: new Date('2026-12-31').toISOString(),
        };

        const incomingPin2New: ResourcePin = {
            id: 'pin2',
            providerId: 'node2',
            type: 'Need',
            location: { lat: 0, lng: 0 },
            description: 'desc2',
            updatedAt: new Date('2026-01-01').toISOString(),
            expiresAt: new Date('2026-12-31').toISOString(),
        };

        const payload = JSON.stringify({
            nodeId: 'node2',
            standing: 10,
            pins: [incomingPin1Newer, incomingPin2New],
            timestamp: new Date().toISOString(),
        });

        gossipManager.processIncomingGossip(payload);

        const updatedPins = routerManager.getPins();
        expect(updatedPins.length).toBe(2);
        const p1 = updatedPins.find(p => p.id === 'pin1');
        expect(p1?.description).toBe('desc1-updated');
        const p2 = updatedPins.find(p => p.id === 'pin2');
        expect(p2?.id).toBe('pin2');
    });
});
