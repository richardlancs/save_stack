/// <reference types="node" />
// Shared plumbing for the end-to-end runs: launch Chromium with the built extension, talk to it over the real RPC path,
// scroll a page like a person would, and wait for the capture pipeline to catch up with what the mock served.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import type { CaptureStatus } from '../src/platforms/capture-protocol';

export const EXT = path.resolve('.output-e2e/chrome-mv3');

export interface Session { ctx: BrowserContext; profile: string; sw: () => Promise<Worker> }

export function makeChecker() {
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); };
  return { failures, check };
}

export function newProfile(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'scroganize-e2e-')); }

/** Best effort: on Windows the browser may hold the profile for a moment after it closes; a leftover temp dir is not a test failure. */
export function cleanup(profile: string): void { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ } }

/** Browser flags that make a run hermetic: nothing but the mock is reachable (see mock-tiktok.ts start()). */
export interface Net { args: string[] }
export const NO_NETWORK: Net = { args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] };

export async function launch(profile: string, net: Net, extra: { headless?: boolean } = {}): Promise<Session> {
  if (!fs.existsSync(path.join(EXT, 'manifest.json'))) throw new Error(`no e2e build at ${EXT}; run: npm run build:e2e`);
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: extra.headless ?? true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...net.args],
    viewport: { width: 1000, height: 720 },
  });
  const sw = async (): Promise<Worker> => {
    // After the browser stops the worker, Playwright can keep the dead handle listed for a while: prefer the newest one.
    const listed = ctx.serviceWorkers().filter((w) => w.url().startsWith('chrome-extension://'));
    if (listed.length > 0) return listed[listed.length - 1]!;
    return ctx.waitForEvent('serviceworker', { timeout: 30_000 });
  };
  await sw();
  return { ctx, profile, sw };
}

let seq = 0;
/** One RPC through the service worker's real request handler (also answers getCaptureStatus). Throws on an error response. */
export async function rpc<T = any>(s: Session, method: string, params?: unknown): Promise<T> {
  const res = await rpcRaw(s, method, params);
  if (!res.ok) throw new Error(`${method}: ${res.error.code}: ${res.error.message}`);
  return res.result as T;
}
export async function rpcRaw(s: Session, method: string, params?: unknown): Promise<any> {
  const request = { v: 1, id: `e2e-${seq++}`, method, params };
  for (let attempt = 0; ; attempt++) {
    try {
      const w = await s.sw();
      // evaluate() on a worker the browser has stopped never settles, so every attempt is bounded
      return await Promise.race([
        w.evaluate((r) => (globalThis as any).__scroganize.rpc(r), request),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('service worker did not answer (stopped?)')), 8000)),
      ]);
    } catch (e) {
      // the service worker may have been stopped between lookup and call; the next lookup starts it again
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

export const captureStatus = (s: Session): Promise<CaptureStatus> => rpc<CaptureStatus>(s, 'getCaptureStatus');
export const rejectedTotal = (st: CaptureStatus): number => Object.values(st.rejected).reduce((a, b) => a + (b ?? 0), 0);
export const outcomes = (st: CaptureStatus): number => st.pages + st.duplicates + rejectedTotal(st);

/** Scroll the mock page with real wheel events until its list is exhausted. Returns how many wheel gestures were needed. */
export async function drain(page: Page, maxGestures = 120): Promise<number> {
  await page.waitForFunction(() => (window as any).__mock?.state.ready === true, undefined, { timeout: 20_000 });
  await page.mouse.move(400, 400);
  for (let i = 0; i < maxGestures; i++) {
    if (await page.evaluate(() => (window as any).__mock.state.done)) return i;
    await page.mouse.wheel(0, 1800);
    await page.waitForFunction(() => !(window as any).__mock.state.loading, undefined, { timeout: 10_000 });
    await page.waitForTimeout(25);
  }
  throw new Error(`the page never finished loading its list after ${maxGestures} scrolls`);
}

/** Wait until the pipeline has produced one outcome for every allowed response the mock served since `baseline`. */
export async function settle(s: Session, baselineOutcomes: number, servedBaseline: number, servedNow: () => number, timeoutMs = 20_000): Promise<CaptureStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await captureStatus(s);
    const want = servedNow() - servedBaseline;
    if (outcomes(st) - baselineOutcomes >= want) {
      await new Promise((r) => setTimeout(r, 150)); // let any stray extra outcome show up, so an over-count is caught too
      return captureStatus(s);
    }
    if (Date.now() > deadline) throw new Error(`capture never caught up: served ${want} allowed responses, pipeline recorded ${outcomes(st) - baselineOutcomes}`);
    await new Promise((r) => setTimeout(r, 60));
  }
}

/** Everything the page's own scripts could see the hook post (the hook talks over window.postMessage). */
export async function pageSeenMessages(page: Page): Promise<string[]> {
  return page.evaluate(() => ((window as any).__captured ?? []) as string[]).catch(() => []);
}

// ------------------------------------------------------------------------------------------------ sync helpers

export const FAST_DRIVER = { minDelayMs: 40, maxDelayMs: 90, settleMaxMs: 3000, settlePollMs: 40, stallSteps: 4, longPauseEvery: [10_000, 10_001], longPauseMs: [1, 2] };

/** Use faster pacing and tighter limits in the end-to-end build (production always uses the human-like defaults). */
export async function setSyncOptions(s: Session, o: { sync?: Record<string, unknown>; driver?: Record<string, unknown> } | null): Promise<void> {
  const w = await s.sw();
  await w.evaluate((opts) => (globalThis as any).__scroganize.setSyncOptions(opts ?? {}), o);
}

export const syncStatus = (s: Session): Promise<any> => rpc(s, 'getSyncStatus');

/** Poll the sync state until `pred` holds. Throws with the last state on timeout. */
export async function waitSync(s: Session, pred: (st: any) => boolean, label: string, timeoutMs = 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  for (;;) {
    last = await syncStatus(s);
    if (pred(last)) return last;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}. Last sync state: status=${last.status} phase=${last.phase} attention=${last.attention?.reason ?? '-'} saved.pages=${last.saved?.pages} error=${last.error ?? '-'}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}
export const terminal = (st: any): boolean => ['completed', 'failed', 'cancelled'].includes(st.status);

/** Run a hook exposed by the end-to-end service worker. */
export async function swHook(s: Session, name: string, ...args: unknown[]): Promise<any> {
  const w = await s.sw();
  return w.evaluate(({ name, args }) => (globalThis as any).__scroganize[name](...args), { name, args });
}

/** The tiktok pages currently open (the sync window's page among them). */
export const tiktokPages = (s: Session) => s.ctx.pages().filter((p) => p.url().startsWith('https://www.tiktok.com'));

/** Prove the run is hermetic: the real internet is unreachable, and tiktok.com is the mock. */
export async function assertHermetic(s: Session, check: (ok: boolean, what: string) => void): Promise<void> {
  const page = await s.ctx.newPage();
  let real = 'reached';
  try { await page.goto('https://example.com/', { timeout: 8000 }); } catch { real = 'unreachable'; }
  check(real === 'unreachable', 'the test browser cannot reach the real internet');
  await page.close();
  const mockPage = await s.ctx.newPage(); // a fresh page: the failed navigation above left an error page behind
  await mockPage.goto('https://www.tiktok.com/');
  check((await mockPage.title()).startsWith('Mock TikTok'), 'https://www.tiktok.com/ is the local mock, not the real site');
  await mockPage.close();
}

/** The extension's id (from its service worker's address). */
export async function extensionId(s: Session): Promise<string> {
  const w = await s.sw();
  return new URL(w.url()).host;
}
