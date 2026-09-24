// Drives the M0 spike: loads the BUILT extension (.output/chrome-mv3) into Playwright's Chromium
// (branded Chrome 137+ ignores --load-extension, so we use Chromium), asks the service worker to run
// the offscreen-document/Worker/OPFS spike, and writes bench/results/spike-<timestamp>.json.
//
//   npm run spike                       # full 50k run, headless
//   ITEMS=10000 npm run spike           # smaller run
//   HEADED=1 npm run spike              # show the browser window
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ext = path.resolve('.output/chrome-mv3');
if (!fs.existsSync(path.join(ext, 'manifest.json'))) {
  console.error('No build found at', ext, '- run `npx wxt build` first.');
  process.exit(1);
}

const opts = {};
if (process.env.ITEMS) opts.items = Number(process.env.ITEMS);
if (process.env.VARIANT_ITEMS) opts.variantItems = Number(process.env.VARIANT_ITEMS);
if (process.env.RUNS) opts.runs = Number(process.env.RUNS);
if (process.env.MAIN_VARIANT) opts.mainVariant = process.env.MAIN_VARIANT;

// PROFILE_DIR keeps the browser profile (and therefore the OPFS database) between runs, so
// `MODE=bench` can re-benchmark queries against an already-built 50k database.
const persist = !!process.env.PROFILE_DIR;
const profile = persist ? path.resolve(process.env.PROFILE_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'scroganize-spike-'));
if (persist) fs.mkdirSync(profile, { recursive: true });
if (process.env.MODE) opts.mode = process.env.MODE;
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !process.env.HEADED,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('service worker up:', sw.url());
  console.log('browser:', ctx.browser()?.version(), '| options:', JSON.stringify(opts));

  const started = Date.now();
  let done = false;
  const poll = (async () => {
    while (!done) {
      await new Promise((r) => setTimeout(r, 2000));
      if (done) break;
      try {
        const lines = await sw.evaluate(() => globalThis.__scroganize.drainLogs());
        for (const l of lines) console.log(`  [${((Date.now() - started) / 1000).toFixed(1)}s] ${l}`);
      } catch { /* worker restarting; keep going */ }
    }
  })();

  const reply = await sw.evaluate((o) => globalThis.__scroganize.runSpike(o), opts);
  done = true;
  await poll;
  if (!reply?.ok) {
    console.error('SPIKE FAILED:\n', reply?.error ?? JSON.stringify(reply));
    process.exitCode = 1;
  } else {
    const outDir = path.resolve('bench/results');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(outDir, `${opts.mode === 'bench' ? 'bench' : 'spike'}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({ browser: ctx.browser()?.version(), options: opts, ...reply.result }, null, 2));
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${path.relative(process.cwd(), file)}`);
  }
} finally {
  await ctx.close();
  if (!persist) fs.rmSync(profile, { recursive: true, force: true });
}
