async function run() {
    const res = await fetch('http://localhost:3000/api/members');
    const data = await res.json();
    console.log(JSON.stringify(data.filter(m => m.callsign === "Marty party" || m.callsign === "Marty-new"), null, 2));
}
run();
