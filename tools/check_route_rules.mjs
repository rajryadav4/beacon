// Runs tests/route-rules-cases.json against the browser's copy of the route rules (recommend.js).
// The Java rules run the same file in RouteRulesSharedCasesTest. Usage, from the repository root:
//   node tools/check_route_rules.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { recommend } from '../CrimeRadar/src/main/webapp/assets/js/recommend.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { cases } = JSON.parse(readFileSync(join(root, 'tests/route-rules-cases.json'), 'utf8'));
let failed = 0;
for (const c of cases) {
  const result = recommend(c.routes, c.mode, c.preference);
  const problems = [];
  if (result.recommendedId !== c.expect.recommendedId) problems.push(`recommended ${result.recommendedId}, expected ${c.expect.recommendedId}`);
  for (const text of c.expect.explanationContains || []) {
    if (!result.explanation.includes(text)) problems.push(`explanation lacks "${text}": ${result.explanation}`);
  }
  if (problems.length) {
    failed++;
    console.log(`FAIL  ${c.name}\n      ${problems.join('\n      ')}`);
  } else {
    console.log(`PASS  ${c.name}`);
  }
}
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
