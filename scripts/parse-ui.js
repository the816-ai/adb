const fs = require('fs');
const xml = fs.readFileSync(process.argv[2], 'utf8');
const re = /<node[^>]*>/g;
let m;
const items = [];
while ((m = re.exec(xml))) {
  const t = m[0];
  const text = (t.match(/text="([^"]*)"/) || [])[1] || '';
  const desc = (t.match(/content-desc="([^"]*)"/) || [])[1] || '';
  const pkg = (t.match(/package="([^"]*)"/) || [])[1] || '';
  const rid = (t.match(/resource-id="([^"]*)"/) || [])[1] || '';
  const bounds = (t.match(/bounds="([^"]*)"/) || [])[1] || '';
  if (pkg.includes('trill') && (text || desc)) {
    items.push({ text, desc, rid, bounds });
  }
}
console.log(JSON.stringify(items, null, 2));
