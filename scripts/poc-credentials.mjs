// Admin credentials for the local PoC stack, taken from the environment only.
// There is deliberately no literal fallback: a committed default password trips
// secret scanners (GitGuardian flagged this repo on 2026-10-26) and, worse, lets a
// harness log in to whatever stack happens to be listening instead of failing loudly.
export function adminCredentials(script) {
  const pass = process.env.NEW_API_ADMIN_PASS;
  if (!pass) {
    console.error('missing NEW_API_ADMIN_PASS.');
    console.error('The PoC admin password is whatever was entered at /setup; it is not stored in this repo.');
    console.error(`Pass it explicitly, e.g.:  NEW_API_ADMIN_PASS=<setup password> node scripts/${script}`);
    console.error('See docs/OPERATIONS.md §1 (first login) and §9 (what must never be committed).');
    process.exit(1);
  }
  return { user: process.env.NEW_API_ADMIN_USER || 'root', pass };
}
