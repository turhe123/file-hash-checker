// Generates the small fictional text fixtures used by smoke.spec.js and window.__demo.
// Run with: node tests/make-fixtures.js
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'fixtures');
fs.writeFileSync(path.join(dir, 'sample.txt'), 'The quick brown fox visits the Maple Street bakery\n');
fs.writeFileSync(path.join(dir, 'abc.txt'), 'abc');
fs.writeFileSync(path.join(dir, 'empty.txt'), '');
