fetch("https://mullum1.beanpool.org/api/members")
  .then(res => res.json())
  .then(data => console.log(data.find(m => m.callsign === "Marty party")))
  .catch(console.error);
