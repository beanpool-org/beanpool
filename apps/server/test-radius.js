const fs = require('fs');

async function test() {
  const update = {
    publishLocation: false,
    publishMembers: false,
    publishContacts: false,
    publishHealth: false,
    serviceRadius: { lat: -28.5483333, lng: 153.5011111, radiusKm: 50 }
  };
  console.log("Mocking UI payload:", update);
}

test();
