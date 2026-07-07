const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');

if (!fs.existsSync(envPath)) {
  console.error(`Missing .env at ${envPath}`);
  console.error('Create it with:');
  console.error('  WEB_EXT_API_KEY=user:xxxxx:xx');
  console.error('  WEB_EXT_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  process.exit(1);
}

for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq === -1) continue;
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (!(key in process.env)) process.env[key] = value;
}

if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  console.error('WEB_EXT_API_KEY and WEB_EXT_API_SECRET must be set in .env');
  process.exit(1);
}

const result = spawnSync(
  'npx',
  ['web-ext', 'sign', '--channel=unlisted', ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: root, shell: true }
);
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
