const http = require('http');

const data = JSON.stringify({
  password: "Un1versal",
  publishLocation: false,
  publishMembers: false,
  publishContacts: false,
  publishHealth: false,
  serviceRadius: { lat: -28.5, lng: 153.5, radiusKm: 50 }
});

const options = {
  hostname: 'localhost',
  port: 8080,
  path: '/api/local/admin/node/config',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, res => {
  console.log(`STATUS: ${res.statusCode}`);
  res.on('data', d => {
    process.stdout.write(d);
  });
});

req.on('error', error => {
  console.error(error);
});

req.write(data);
req.end();
