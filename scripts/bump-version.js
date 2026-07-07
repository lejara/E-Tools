const fs = require('fs');
const path = require('path');

const type = process.argv[2] || 'patch';
if (!['major', 'minor', 'patch'].includes(type)) {
  console.error(`Unknown bump type: ${type}. Use major|minor|patch.`);
  process.exit(1);
}

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'manifest.json');
const pkgPath = path.join(root, 'package.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const [major, minor, patch] = manifest.version.split('.').map(Number);
const nextParts = {
  major: [major + 1, 0, 0],
  minor: [major, minor + 1, 0],
  patch: [major, minor, patch + 1],
}[type];
const next = nextParts.join('.');

manifest.version = next;
pkg.version = next;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`Bumped ${major}.${minor}.${patch} -> ${next}`);
