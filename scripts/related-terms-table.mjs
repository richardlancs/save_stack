// Generates docs/RELATED_TERMS.md from src/core/search/related-terms.json: a table you can read and mark up.
//   node scripts/related-terms-table.mjs
import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync('src/core/search/related-terms.json', 'utf8'));
const cats = Object.entries(data.categories).sort(([a], [b]) => a.localeCompare(b));
const aliasesByCategory = new Map();
for (const [alias, cat] of Object.entries(data.aliases)) {
  if (!aliasesByCategory.has(cat)) aliasesByCategory.set(cat, []);
  aliasesByCategory.get(cat).push(alias);
}

const lines = [];
lines.push('# Related words: review table');
lines.push('');
lines.push('Generated from `src/core/search/related-terms.json` by `node scripts/related-terms-table.mjs`. **This is the list to review.**');
lines.push('');
lines.push('How it is used: when you type a category (a chip), the search also matches the words listed for it, in the videos\' caption, hashtags, author, sound and collection names. So `food` also finds a pasta video that never says "food". Matching uses stemming, so `recipe` also covers `recipes`. Typing an alias (for example `recipes` for `food`) uses that category\'s words. You can switch related words off per search ("Include related words"), and the panel always shows which related words a search used.');
lines.push('');
lines.push('What to look for: **words that are too generic** (they cause false positives: "best", "easy", "game"), **words that belong elsewhere**, **missing words your own videos use**, and **categories you would like added**. Edit the JSON directly (plain data, base word forms, at most 30 words per category) or tell me the changes. The measured quality on a hand-labelled library is in `docs/SEARCH_PERFORMANCE.md`.');
lines.push('');
lines.push(`${cats.length} categories, ${Object.keys(data.aliases).length} aliases.`);
lines.push('');
lines.push('| Category | Also matches (related words) | Aliases: typing these uses this category |');
lines.push('|---|---|---|');
for (const [cat, terms] of cats) {
  const aliases = (aliasesByCategory.get(cat) ?? []).sort();
  lines.push(`| **${cat}** | ${terms.join(', ')} | ${aliases.join(', ')} |`);
}
lines.push('');
fs.writeFileSync('docs/RELATED_TERMS.md', lines.join('\n'));
console.log(`wrote docs/RELATED_TERMS.md (${cats.length} categories)`);
