// Mutation spot-check: deliberately break critical logic and confirm the test suite notices.
//   npm run mutate                 # all mutations
//   npm run mutate -- planner      # only mutations whose name contains "planner"
//
// A mutation the suite does NOT catch means a test is vacuous (or missing). The script fails loudly if a `find` string
// is not present (so a refactor can never make a mutation silently do nothing) and ALWAYS restores the file afterwards.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const M = [
  // ---------------- M1: storage
  { name: 'storage: saved_at provenance always replaces', file: 'src/core/ingest/normalize.ts', find: 'return incoming !== undefined && SAVED_AT_RANK[incoming] > SAVED_AT_RANK[existing];', replace: 'return incoming !== undefined;' },
  { name: 'storage: rollback keeps a stale hashtag cache', file: 'src/core/storage/sqlite/sqlite-adapter.ts', find: 'this.tagIds.clear(); // the rolled-back', replace: '/* MUTATED */ // the rolled-back' },
  { name: 'storage: collection rename does not refresh full-text rows', file: 'src/core/storage/sqlite/sqlite-adapter.ts', find: 'for (const collId of renamed) {', replace: 'for (const collId of [] as number[]) {' },
  // ---------------- M2: search
  { name: 'planner: multiword chip forgets the concatenated hashtag', file: 'src/core/search/planner.ts', find: 'return `((${parts.join(\' AND \')}) OR "${tokens.join(\'\')}"*)`;', replace: 'return `(${parts.join(\' AND \')})`;' },
  { name: 'planner: prefix matching disabled', file: 'src/core/search/planner.ts', find: 'i === last && t.length >= MIN_PREFIX_LENGTH', replace: 'false' },
  { name: 'planner: mode "all" joins with OR', file: 'src/core/search/planner.ts', find: "parts.length === 0 ? null : parts.join(mode === 'all' ? ' AND ' : ' OR ')", replace: "parts.length === 0 ? null : parts.join(' OR ')" },
  { name: 'planner: related-terms budget ignored', file: 'src/core/search/planner.ts', find: 'if (expanding <= 1) return MAX_RELATED_TERMS;', replace: 'return MAX_RELATED_TERMS;' },
  { name: 'search: tier 2 (related-only matches) never queried', file: 'src/core/storage/sqlite/search.ts', find: 'if (ids.length < depth && plan.hasRelated && total > ids.length) {', replace: 'if (false) {' },
  { name: 'search: LIKE wildcards not escaped', file: 'src/core/storage/sqlite/search.ts', find: "`%${word.replace(/[!%_]/g, (c) => `!${c}`)}%`", replace: '`%${word}%`' },
  { name: 'search: "recently saved" orders by id instead', file: 'src/core/storage/sqlite/search.ts', find: "recently_saved: 'i.saved_at',", replace: "recently_saved: 'i.id'," },
  { name: 'search: cursor loses the total', file: 'src/core/storage/sqlite/search.ts', find: '${Number(last[1])}:${Number(last[0])}:${total}`', replace: '${Number(last[1])}:${Number(last[0])}:0`' },
  { name: 'search: too-broad threshold never triggers', file: 'src/core/storage/sqlite/search.ts', find: "if (total > TOO_BROAD) return this.ordered(plan, { set: set!, orderedBy: 'recently_saved', cur: null, knownTotal: total });", replace: '' },
  { name: 'service: platform hashtags (fyp) suggested as chips', file: 'src/core/search/service.ts', find: "const NOISE_TAGS = new Set(['fyp',", replace: "const NOISE_TAGS = new Set(['fypXX'," },
  { name: 'service: did-you-mean never offered', file: 'src/core/search/service.ts', find: 'if (guess !== undefined) info.didYouMean = guess;', replace: '' },
  { name: 'expander: per-chip term cap not enforced', file: 'src/core/search/expander.ts', find: 'if (terms.length >= MAX_RELATED_TERMS) break;', replace: '' },
  { name: 'chips: CJK/emoji never routed to substring matching', file: 'src/core/search/chips.ts', find: 'return NEEDS_SUBSTRING.test(text.normalize(\'NFKC\'));', replace: 'return false;' },
  { name: 'chips: duplicate chips kept', file: 'src/core/search/chips.ts', find: 'if (seen.has(id)) continue;', replace: '' },
  { name: 'search: a cursor issued for one sort is accepted under another', file: 'src/core/storage/sqlite/search.ts', find: "if (ks && ks.sort !== SORT_LETTER[orderedBy]) throw new SearchInputError('this cursor was issued for a different sort');", replace: '' },
  { name: 'search: a cursor total is trusted unclamped', file: 'src/core/storage/sqlite/search.ts', find: "direct: m[1] === 'd', sort: m[2]!, v: Number(m[3]), id: Number(m[4]), total: Math.min(Number(m[5]), TOTAL_CAP) }", replace: "direct: m[1] === 'd', sort: m[2]!, v: Number(m[3]), id: Number(m[4]), total: Number(m[5]) }" },
  { name: 'search: hashtag matches beyond 500 silently dropped', file: 'src/core/storage/sqlite/search.ts', find: 'if (tags.length > INLINE_IDS) {', replace: 'if (false) {' },
  { name: 'search: collection-name matches beyond 500 silently dropped', file: 'src/core/storage/sqlite/search.ts', find: 'if (cols.length > INLINE_IDS) {', replace: 'if (false) {' },
  { name: 'search: own-words listing forgets its d: cursor', file: 'src/core/storage/sqlite/search.ts', find: "`${o.direct ? 'd' : 'k'}:", replace: "`${'k'}:" },
  { name: 'search: raw_json is hydrated into results', file: 'src/core/storage/sqlite/search.ts', find: 'SELECT ${RESULT_COLUMNS} FROM items WHERE id IN', replace: 'SELECT * FROM items WHERE id IN' },
  { name: 'service: a duplicate chip gets no chipInfo entry', file: 'src/core/search/service.ts', find: 'chips: all.map((n) => ({ ...infoByPlan.get(plans.get(n.id)!)!, chipId: n.id }))', replace: 'chips: [...infoByPlan.values()]' },
  { name: 'adapter: search vocabulary cache never invalidated', file: 'src/core/storage/sqlite/sqlite-adapter.ts', find: 'new SqliteSearch(this.db, () => this.dataVersion)', replace: 'new SqliteSearch(this.db, () => 0)' },
  { name: 'gate: superseded searches are not dropped (no yield)', file: 'src/extension/rpc/search-gate.ts', find: 'if (isSearchLike(msg)) await yieldToLoop();', replace: '' },
  { name: 'rpc: search input errors surface as INTERNAL', file: 'src/extension/rpc/server.ts', find: "if (e instanceof SearchInputError) return fail(id, 'BAD_REQUEST', e.message);", replace: '' },
];

const only = process.argv[2];
const list = only ? M.filter((m) => m.name.includes(only)) : M;
let escaped = 0;
const results = [];
for (const m of list) {
  const file = path.resolve(m.file);
  const original = fs.readFileSync(file, 'utf8');
  if (!original.includes(m.find)) { console.error(`MUTATION TARGET NOT FOUND: ${m.name}\n  file: ${m.file}\n  find: ${m.find}`); process.exit(2); }
  try {
    fs.writeFileSync(file, original.replace(m.find, () => m.replace));
    const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vitest', 'run', '--reporter=dot'], { encoding: 'utf8', shell: true });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const failed = /(\d+) failed/.exec(out)?.[1] ?? (r.status === 0 ? '0' : '?');
    const caught = r.status !== 0;
    if (!caught) escaped++;
    results.push({ name: m.name, caught, failed });
    console.log(`${caught ? 'caught ' : 'ESCAPED'}  ${m.name}  (${failed} test(s) failed)`);
  } finally {
    fs.writeFileSync(file, original);
  }
}
console.log(`\n${results.length - escaped}/${results.length} mutations caught`);
process.exit(escaped === 0 ? 0 : 1);
