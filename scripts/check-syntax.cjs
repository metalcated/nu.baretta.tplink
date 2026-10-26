'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['app.js', 'api.js'];

function collect(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(filename);
    else if (entry.isFile() && /\.(c?js)$/.test(entry.name)) files.push(path.relative(root, filename));
  }
}

for (const directory of ['drivers', 'lib', 'scripts', 'test']) collect(path.join(root, directory));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `Syntax validation failed: ${file}\n`);
    process.exit(result.status || 1);
  }
}
console.log(`Syntax verified: ${files.length} JavaScript files`);
