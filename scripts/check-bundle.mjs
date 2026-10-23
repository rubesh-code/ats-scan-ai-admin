// Fails the build check if anything secret-looking or mock-only reached dist/.
// Run after `npm run build`: `npm run check:bundle`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

const FORBIDDEN = [
  { name: 'Supabase service role reference', pattern: /service_role|SUPABASE_SERVICE/i },
  { name: 'JWT-shaped token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Razorpay secret reference', pattern: /RAZORPAY_KEY_SECRET|rzp_live_[A-Za-z0-9]{10,}/ },
  { name: 'Private key', pattern: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { name: 'Mock data module', pattern: /mock-password|Mock mode:|example\.com/ },
];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

let all;
try {
  all = files(DIST);
} catch {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}

const problems = [];
for (const file of all.filter((f) => /\.(js|css|html|map|json|txt)$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  for (const { name, pattern } of FORBIDDEN) {
    if (pattern.test(text)) problems.push(`${name} in ${relative(DIST, file)}`);
  }
}

if (problems.length) {
  console.error('Bundle check FAILED:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`Bundle check passed (${all.length} files scanned).`);
