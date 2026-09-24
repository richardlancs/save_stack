/// <reference types="node" />
// M5 end-to-end: the REAL side panel page (opened as a tab: same page, same chrome.runtime messaging as the docked panel), driven the way a
// person would, on top of the real extension and a library filled by a real sync of the mock tiktok.com.   npm run e2e:panel
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { assertHermetic, cleanup, extensionId, FAST_DRIVER, launch, makeChecker, newProfile, rpc, setSyncOptions, syncStatus, terminal, waitSync, type Session } from './harness';
import { createMockTikTok, expectedLibrary, VIEWER } from './mock-tiktok';

const { failures, check } = makeChecker();
const profile = newProfile();
let s: Session | undefined;
const mock = createMockTikTok();
const server = await mock.start();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SHOTS = path.resolve('docs/screenshots');
const clientErrors: string[] = [];

const text = async (p: Page, testId: string): Promise<string> => ((await p.locator(`[data-testid="${testId}"]`).first().textContent({ timeout: 10_000 })) ?? '').trim();
const waitCount = (p: Page, expected: string, timeout = 15_000) => p.waitForFunction((e) => document.querySelector('[data-testid="count"]')?.textContent?.trim() === e, expected, { timeout });
const rows = (p: Page) => p.locator('[data-testid="result"]').count();
async function typeChip(p: Page, word: string) { const input = p.getByRole('textbox', { name: 'Add a category to search for' }); await input.fill(word); await input.press('Enter'); }
const search = (p: Page) => p.getByRole('button', { name: 'Search', exact: true }).click();
/** True if the element shows up within a few seconds (locator.isVisible() does not wait). */
const appears = (l: { waitFor(o: { timeout: number }): Promise<void> }, timeout = 10_000): Promise<boolean> => l.waitFor({ timeout }).then(() => true, () => false);
const chips = (p: Page) => p.locator('ul[aria-label="Categories in this search"] li .chip-text').allTextContents();

try {
  s = await launch(profile, server);
  await assertHermetic(s, check);
  await rpc(s, 'wipeData');
  await setSyncOptions(s, { driver: FAST_DRIVER });
  const exp = expectedLibrary(mock.account);

  // ---------------------------------------------------------------- a library, filled by a real sync
  await rpc(s, 'startSync', { mode: 'full' });
  await waitSync(s, terminal, 'the sync that fills the library', 60_000);
  check((await rpc(s, 'getStats')).items === exp.items, `the library holds ${exp.items} videos from a real sync of the mock`);
  // a hostile caption, to prove captions are only ever text
  await rpc(s, 'upsertBatch', { items: [{ platform: 'tiktok', externalId: '99999', authorHandle: 'evil', caption: '<img src=x onerror="window.__pwned=1"> hello <script>window.__pwned=2</script> xss', hashtags: ['xss'], savedAt: 1, savedAtSource: 'exact' }] });

  const id = await extensionId(s);
  const panel = await s.ctx.newPage();
  panel.on('pageerror', (e) => clientErrors.push(`pageerror: ${e.message}`));
  panel.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_NAME_NOT_RESOLVED/.test(m.text())) clientErrors.push(`console: ${m.text()}`); });
  await panel.setViewportSize({ width: 420, height: 900 });
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);

  // ---------------------------------------------------------------- first paint
  await waitCount(panel, `${exp.items + 1} videos`);
  check(true, `the panel opens on everything saved, newest first: "${await text(panel, 'count')}"`);
  check((await rows(panel)) === 30, 'and shows the first page of 30 videos');
  check(/94 videos · 4 collections/.test(await text(panel, 'stats')), `the footer shows the library size: "${await text(panel, 'stats')}"`);
  check(/Sync finished/.test(await text(panel, 'sync-headline')), `the sync card shows the last run: "${await text(panel, 'sync-headline')}"`);
  check((await panel.locator('.thumb.placeholder').count()) > 0, 'dead thumbnails fall back to a placeholder instead of an error');
  await panel.screenshot({ path: path.join(SHOTS, 'panel-browse-light.png'), fullPage: false }).catch(() => undefined);

  // cold open (prompt section 9: first render under 300 ms): a fresh page, time until the first result is on screen; best of three (a noisy machine)
  const opens: number[] = [];
  for (let i = 0; i < 3; i++) {
    const fresh = await s.ctx.newPage();
    await fresh.goto(`chrome-extension://${id}/sidepanel.html`, { waitUntil: 'commit' });
    const at = await fresh.waitForFunction(() => (document.querySelector('[data-testid="result"]') ? performance.now() : false), undefined, { timeout: 15_000, polling: 10 });
    opens.push(Math.round((await at.jsonValue()) as number));
    await fresh.close();
  }
  check(Math.min(...opens) < 300, `the panel's cold open to the first result takes ${Math.min(...opens)} ms (budget 300; runs: ${opens.join(', ')} ms)`);

  // ---------------------------------------------------------------- the chip flow: staged edits, Search to apply
  await typeChip(panel, 'makeup');
  check((await chips(panel)).join() === 'makeup', 'typing a category and pressing Enter puts a chip under the search bar');
  check(await panel.getByTestId('stale').isVisible(), 'the panel says "Filters changed. Press Search" and the results are NOT updated yet');
  check((await text(panel, 'count')) === `${exp.items + 1} videos`, 'the results still show the previous search');
  await search(panel);
  await waitCount(panel, `${exp.byTheme('makeup').length} videos`);
  check(!(await panel.getByTestId('stale').isVisible().catch(() => false)), `Search applies it: ${await text(panel, 'count')}, and the notice goes away`);
  check(((await panel.locator('.chipinfo').textContent()) ?? '').includes('makeup'), 'per-category counts appear under the results');

  await typeChip(panel, 'pasta');
  await search(panel);
  await waitCount(panel, 'No videos found');
  const zero = (await panel.locator('.notice').first().textContent()) ?? '';
  check(/Try fewer categories/.test(zero), `two categories that never occur together say why: "${zero.trim().slice(0, 90)}..."`);
  await panel.locator('label.seg', { hasText: 'Any category' }).click(); // the radio itself is visually hidden; a person clicks its label
  check(await panel.getByTestId('stale').isVisible(), 'switching to "Any category" is also a pending change');
  await search(panel);
  await waitCount(panel, `${exp.byTheme('makeup').length + exp.byTheme('cooking').length} videos`);
  check(true, `"Any category" widens it: ${await text(panel, 'count')}`);

  // removing a chip with its x changes only the draft
  await panel.getByRole('button', { name: 'Remove the category pasta' }).click();
  check((await chips(panel)).join() === 'makeup', 'the x removes the chip from the draft');
  check((await text(panel, 'count')) === `${exp.byTheme('makeup').length + exp.byTheme('cooking').length} videos`, 'but the results do not change until Search is pressed');
  check(await panel.getByTestId('stale').isVisible(), 'and the panel says so');
  await search(panel);
  await waitCount(panel, `${exp.byTheme('makeup').length} videos`);
  check(true, `Search applies the removal: ${await text(panel, 'count')}`);

  // "did you mean"
  await panel.getByRole('button', { name: 'Remove the category makeup' }).click();
  await typeChip(panel, 'makup');
  await search(panel);
  await waitCount(panel, 'No videos found');
  const dym = panel.getByRole('button', { name: /Did you mean "makeup"\?/ });
  check(await appears(dym), 'a typo offers "Did you mean makeup?"');
  await dym.click();
  check((await chips(panel)).join() === 'makeup', 'accepting it edits the chip (still a draft change)');
  await search(panel);
  await waitCount(panel, `${exp.byTheme('makeup').length} videos`);

  // why did this match
  await panel.getByRole('button', { name: 'Why this matched' }).first().click();
  await panel.waitForFunction(() => /makeup/.test(document.querySelector('[aria-label="Why this matched"]')?.textContent ?? ''), undefined, { timeout: 10_000 }).catch(() => undefined);
  const whyText = (await panel.getByRole('region', { name: 'Why this matched' }).first().textContent()) ?? '';
  check(whyText.includes('makeup'), `a result explains why it matched, on demand: "${whyText.trim().slice(0, 80)}"`);

  // related words
  await panel.getByRole('button', { name: 'Remove the category makeup' }).click();
  await typeChip(panel, 'food');
  await search(panel);
  await panel.waitForFunction(() => /also matched/.test(document.querySelector('.chipinfo')?.textContent ?? ''), undefined, { timeout: 10_000 });
  check(true, `related words are shown for transparency: "${((await panel.locator('.chipinfo').textContent()) ?? '').trim().slice(0, 100)}"`);

  // a category that only exists as text in a hostile caption
  await panel.getByRole('button', { name: 'Remove the category food' }).click();
  await typeChip(panel, 'xss');
  await search(panel);
  await waitCount(panel, '1 video');
  const evilRow = (await panel.locator('[data-testid="result"]').first().textContent()) ?? '';
  check(evilRow.includes('<img src=x') || evilRow.includes('<script>'), `a caption with HTML in it is shown as plain text: "${evilRow.trim().slice(0, 100)}"`);
  check((await panel.locator('.result img[src="x"]').count()) === 0 && (await panel.evaluate('window.__pwned')) === undefined, 'and nothing in it was ever executed or turned into an element');

  // ---------------------------------------------------------------- browsing and paging
  await panel.getByRole('button', { name: 'Remove the category xss' }).click();
  await search(panel);
  await waitCount(panel, `${exp.items + 1} videos`);
  for (let i = 0; i < 3; i++) { const more = panel.getByRole('button', { name: 'Show more' }); if (await more.isVisible().catch(() => false)) { await more.click(); await panel.waitForTimeout(400); } }
  check((await rows(panel)) === exp.items + 1, `"Show more" pages through everything (${await rows(panel)} rows)`);
  check(!(await panel.getByRole('button', { name: 'Show more' }).isVisible().catch(() => false)), 'and disappears at the end');

  // ---------------------------------------------------------------- keyboard
  const input = panel.getByRole('textbox', { name: 'Add a category to search for' });
  await input.focus();
  await panel.keyboard.type('travel');
  await panel.keyboard.press('Enter');
  await panel.keyboard.type('pets,');
  check((await chips(panel)).join() === 'travel,pets', 'Enter and a comma both finish a category from the keyboard');
  await panel.keyboard.press('Backspace');
  check((await chips(panel)).join() === 'travel', 'Backspace in the empty box removes the last chip');
  // a string script (an IIFE): serialized functions carry the bundler's helper names into the page
  await panel.evaluate("(() => { const el = document.querySelector('#category-input'); const dt = new DataTransfer(); dt.setData('text', 'sports\\ndance, cooking'); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()");
  await panel.waitForFunction(() => document.querySelectorAll('ul[aria-label="Categories in this search"] li').length >= 4, undefined, { timeout: 5000 }).catch(() => undefined); // the panel repaints a moment after the event
  const pasted = (await chips(panel)).join();
  check(pasted === 'travel,sports,dance,cooking', `pasting a list (commas or line breaks) makes one chip per category (got "${pasted}")`);
  for (let i = 0; i < 3; i++) await panel.keyboard.press('Backspace');
  await panel.keyboard.press('Enter'); // empty box + Enter = Search
  await waitCount(panel, `${exp.byTheme('travel').length} videos`);
  check(true, `Enter in an empty box searches: ${await text(panel, 'count')}`);
  check((await panel.locator('[role="status"][aria-live="polite"]').count()) > 0, 'result counts are announced to screen readers (aria-live)');
  await panel.screenshot({ path: path.join(SHOTS, 'panel-results-light.png') }).catch(() => undefined);

  // ---------------------------------------------------------------- preferences persist
  await panel.getByLabel('Include related words').uncheck();
  await panel.getByLabel('Results per page').selectOption('10');
  await sleep(300);
  const prefs = await rpc(s, 'getSettings');
  check(prefs.relatedWords === false && prefs.pageSize === 10, `preferences are saved (${JSON.stringify(prefs)})`);
  await panel.reload();
  await panel.waitForFunction(() => document.querySelectorAll('[data-testid="result"]').length === 10, undefined, { timeout: 15_000 });
  check(!(await panel.getByLabel('Include related words').isChecked()) && (await panel.getByLabel('Results per page').inputValue()) === '10', 'and survive closing and reopening the panel: related words off, 10 videos per page');
  await typeChip(panel, 'food');
  await search(panel);
  await panel.waitForFunction(() => document.querySelector('.chipinfo') !== null, undefined, { timeout: 10_000 });
  check(!/also matched/.test((await panel.locator('.chipinfo').textContent()) ?? ''), 'with related words off, a category matches only its own words');
  await panel.getByRole('button', { name: 'Remove the category food' }).click();
  await panel.getByLabel('Include related words').check();
  await panel.getByLabel('Results per page').selectOption('30');
  await sleep(300);
  await search(panel);
  await waitCount(panel, `${exp.items + 1} videos`);

  // two preference changes arriving together must both land (the service worker serializes its read-modify-write of the stored object)
  await Promise.all([rpc(s, 'setSettings', { sort: 'newest' }), rpc(s, 'setSettings', { pageSize: 50 })]);
  const both = await rpc(s, 'getSettings');
  check(both.sort === 'newest' && both.pageSize === 50, `two preference changes at once both land (${JSON.stringify(both)})`);
  await rpc(s, 'setSettings', { sort: 'relevance', pageSize: 30 });

  // ---------------------------------------------------------------- export, wipe, import
  const before = await rpc(s, 'getStats');
  const [download] = await Promise.all([panel.waitForEvent('download', { timeout: 15_000 }), panel.getByRole('button', { name: 'Export', exact: true }).click()]);
  const exportPath = path.join(path.dirname(profile), `scroganize-export-e2e-${Date.now()}.json`);
  await download.saveAs(exportPath);
  const bundle = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  check(bundle.format === 'scroganize-export' && bundle.items.length === before.items && bundle.accounts?.[0]?.handle === VIEWER, `Export downloads the whole library (${bundle.items.length} videos, account ${bundle.accounts?.[0]?.handle})`);

  await panel.getByRole('button', { name: 'Wipe library' }).click();
  await panel.getByRole('button', { name: 'Keep it' }).click();
  check((await rpc(s, 'getStats')).items === before.items, 'the wipe needs a second, deliberate confirmation ("Keep it" changes nothing)');
  await panel.getByRole('button', { name: 'Wipe library' }).click();
  await panel.getByRole('button', { name: 'Yes, wipe' }).click();
  await panel.waitForFunction(() => /Nothing here yet/.test(document.body.textContent ?? ''), undefined, { timeout: 15_000 });
  check((await rpc(s, 'getStats')).items === 0 && (await rpc(s, 'getAccount', { platform: 'tiktok' })) === null, 'Wipe empties the library and its account binding, and the panel explains how to fill it');
  await panel.screenshot({ path: path.join(SHOTS, 'panel-empty-light.png') }).catch(() => undefined);

  await panel.locator('input[type="file"]').setInputFiles(exportPath);
  await panel.waitForFunction(() => /Imported/.test(document.body.textContent ?? ''), undefined, { timeout: 15_000 });
  const imported = await rpc(s, 'getStats');
  check(imported.items === before.items && (await rpc(s, 'getAccount', { platform: 'tiktok' }))?.handle === VIEWER, `Import restores the library and its account (${imported.items} videos)`);
  fs.rmSync(exportPath, { force: true });

  // ---------------------------------------------------------------- sync from the panel
  await rpc(s, 'wipeData');
  mock.state.latencyMs = 500;
  await panel.reload();
  await panel.waitForFunction(() => /Nothing here yet/.test(document.body.textContent ?? ''), undefined, { timeout: 15_000 });
  await panel.getByRole('button', { name: 'Sync', exact: true }).click();
  await panel.getByRole('button', { name: 'Pause' }).waitFor({ timeout: 15_000 });
  check(/Reading|Opening/.test(await text(panel, 'sync-headline')), `Sync starts from the panel and says what it is doing: "${await text(panel, 'sync-headline')}"`);
  check(await appears(panel.getByRole('progressbar')), 'a progress bar shows while it works');
  await panel.screenshot({ path: path.join(SHOTS, 'panel-syncing-light.png') }).catch(() => undefined);
  await panel.getByRole('button', { name: 'Pause' }).click();
  await panel.getByRole('button', { name: 'Resume' }).waitFor({ timeout: 15_000 });
  check((await text(panel, 'sync-headline')) === 'Paused', 'Pause pauses');
  await panel.getByRole('button', { name: 'Resume' }).click();
  await panel.waitForFunction(() => /Sync finished/.test(document.querySelector('[data-testid="sync-headline"]')?.textContent ?? ''), undefined, { timeout: 90_000 });
  await waitCount(panel, `${exp.items} videos`);
  check(true, `the results and the numbers refresh when the sync ends: ${await text(panel, 'count')}, ${await text(panel, 'stats')}`);
  mock.state.latencyMs = 0;

  // needs the user
  mock.state.viewer = null;
  await panel.getByRole('button', { name: 'Sync', exact: true }).click();
  await panel.getByText('The sync needs you').waitFor({ timeout: 20_000 });
  check(/Sign in/.test((await panel.locator('.attention').textContent()) ?? ''), 'when it needs you, it says what to do');
  await panel.screenshot({ path: path.join(SHOTS, 'panel-attention-light.png') }).catch(() => undefined);
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await panel.getByText('Sync cancelled').waitFor({ timeout: 15_000 });
  mock.state.viewer = VIEWER;

  // "TikTok changed something"
  mock.state.extraItemKey = true;
  await panel.getByRole('button', { name: 'Sync', exact: true }).click();
  await panel.waitForFunction(() => /Sync finished/.test(document.querySelector('[data-testid="sync-headline"]')?.textContent ?? ''), undefined, { timeout: 90_000 });
  check(await appears(panel.getByTestId('drift')), 'when TikTok adds fields the parser has never seen, the panel says results may be incomplete');
  mock.state.extraItemKey = false;

  // ---------------------------------------------------------------- dark mode
  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.screenshot({ path: path.join(SHOTS, 'panel-results-dark.png') }).catch(() => undefined);

  check(clientErrors.length === 0, clientErrors.length === 0 ? 'no script errors in the panel during the whole run' : `script errors in the panel: ${clientErrors.slice(0, 3).join(' | ')}`);
  void syncStatus;
  await s.ctx.close();
} catch (e) {
  console.error('E2E ERROR:', e);
  failures.push(`exception: ${(e as Error).message}`);
} finally {
  await s?.ctx.close().catch(() => undefined);
  cleanup(profile);
  await server.stop();
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED:\n - ${failures.join('\n - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
