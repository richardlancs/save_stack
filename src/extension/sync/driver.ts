// The page driver: the logic that runs INSIDE the sync window's page (an isolated-world content script) and scrolls the
// platform's list the way a person would, so the platform's own app loads the next page (which the capture hook then reads).
//
// Written against a small `DriverEnv` so the whole loop is unit-tested with virtual time and a fake page. It does only what a
// person's hand does: scroll, and wait. It never reads or writes anything else on the page, never clicks, and stops the moment
// the page shows a login wall or a verification challenge.
//
// Findings it is built around (docs/TIKTOK_FINDINGS.md section 5): in a hidden or occluded tab programmatic scrolling silently
// stalls, so the driver refuses to scroll while hidden and says so; and it detects "the list stopped growing" instead of looping.

import type { PageState, PageSnapshot, PageView } from '../../core/sync/types';

export interface DriverConfig {
  /** Random pause between scroll steps (a person does not scroll on a metronome). */
  minDelayMs: number;
  maxDelayMs: number;
  /** After a scroll, wait up to this long for the list to grow (the platform is fetching the next page). */
  settleMaxMs: number;
  settlePollMs: number;
  /** Consecutive steps with no growth before reporting a stall. */
  stallSteps: number;
  /** Every N steps (random in this range) take a longer pause. */
  longPauseEvery: [number, number];
  longPauseMs: [number, number];
  /** After this many steps without growth, also dispatch a synthetic wheel event (some lazy loaders listen for it). */
  nudgeAfterStuck: number;
}

export const DEFAULT_DRIVER_CONFIG: DriverConfig = {
  minDelayMs: 700,
  maxDelayMs: 1500,
  settleMaxMs: 6000,
  settlePollMs: 150,
  stallSteps: 6,
  longPauseEvery: [8, 14],
  longPauseMs: [3000, 6000],
  nudgeAfterStuck: 2,
};

export type DriverEvent =
  | { type: 'ready'; handle?: string; id?: string; pageState: PageState; view: PageView }
  | { type: 'hidden' }
  | { type: 'visible' }
  | { type: 'stalled' }
  | { type: 'blocked'; pageState: 'login' | 'captcha' };

export type DriverCommand =
  /** `reveal`: once, before scrolling, click the control that opens the list (for platforms where the list sits behind a tab). */
  | { cmd: 'start'; reveal?: boolean; config?: Partial<DriverConfig> }
  | { cmd: 'stop' }
  /** Report the current page again (used when the service worker resumes and needs to know where the window is). */
  | { cmd: 'probe' };

export interface DriverEnv {
  sleep(ms: number): Promise<void>;
  random(): number;
  visible(): boolean;
  scrollHeight(): number;
  scrollToBottom(): void;
  /** A synthetic wheel event at the list, for lazy loaders that listen for it instead of scroll position. */
  nudge(): void;
  /** Click the control that opens the list, if the platform has one and it is on the page. Returns whether something was clicked. */
  reveal(): boolean;
  snapshot(): PageSnapshot;
}

export interface DriverPlatform {
  detectPageState(snapshot: PageSnapshot): PageState;
  classifyPage(snapshot: PageSnapshot): PageView;
}

export interface PageDriver {
  handle(command: DriverCommand): void;
  /** Report the page (called on load). */
  announce(): void;
  /** Call when document visibility changes: reports 'visible' if a 'hidden' was reported before. */
  visibilityChanged(): void;
  isRunning(): boolean;
}

const between = (env: DriverEnv, min: number, max: number): number => Math.round(min + env.random() * Math.max(0, max - min));

export function createPageDriver(env: DriverEnv, platform: DriverPlatform, emit: (e: DriverEvent) => void): PageDriver {
  let token = 0; // bumped by every start/stop: a loop whose token is stale exits at its next check
  let running = false;
  let cfg: DriverConfig = DEFAULT_DRIVER_CONFIG;
  let watching = 0;
  let hiddenAnnounced = false;

  function report(): PageState {
    const snap = env.snapshot();
    const pageState = platform.detectPageState(snap);
    emit({ type: 'ready', ...(snap.viewer !== undefined ? { handle: snap.viewer } : {}), ...(snap.viewerId !== undefined ? { id: snap.viewerId } : {}), pageState, view: platform.classifyPage(snap) });
    return pageState;
  }

  /** After a page that is not the real one yet (interstitial), keep looking and report again when it becomes the real page. */
  function watchUntilReal(): void {
    const mine = ++watching;
    void (async () => {
      for (let i = 0; i < 40 && mine === watching; i++) {
        await env.sleep(1500);
        if (mine !== watching) return;
        const state = platform.detectPageState(env.snapshot());
        if (state === 'ok' || state === 'login' || state === 'captcha') { report(); return; }
      }
    })();
  }

  async function waitForGrowth(before: number, myToken: number): Promise<boolean> {
    for (let waited = 0; waited < cfg.settleMaxMs; waited += cfg.settlePollMs) {
      if (myToken !== token) return false;
      if (env.scrollHeight() > before) return true;
      await env.sleep(cfg.settlePollMs);
    }
    return env.scrollHeight() > before;
  }

  async function loop(myToken: number, reveal: boolean): Promise<void> {
    running = true;
    if (reveal && env.reveal()) await env.sleep(between(env, cfg.minDelayMs, cfg.maxDelayMs) + 1000); // let the list open
    let stuck = 0;
    let steps = 0;
    let nextLongPause = between(env, cfg.longPauseEvery[0], cfg.longPauseEvery[1]);
    try {
      while (myToken === token) {
        // Think before every scroll, the first one included: a person does not scroll the instant a page appears.
        await env.sleep(between(env, cfg.minDelayMs, cfg.maxDelayMs));
        if (myToken !== token) return;

        // A hidden window cannot be scrolled reliably (findings section 5): say so and stop. When it becomes visible again,
        // visibilityChanged() reports it and the coordinator restarts the loop.
        if (!env.visible()) { hiddenAnnounced = true; emit({ type: 'hidden' }); return; }

        const state = platform.detectPageState(env.snapshot());
        if (state === 'login' || state === 'captcha') { emit({ type: 'blocked', pageState: state }); return; }

        const before = env.scrollHeight();
        env.scrollToBottom();
        if (stuck >= cfg.nudgeAfterStuck) env.nudge();

        const grew = await waitForGrowth(before, myToken);
        if (myToken !== token) return;
        stuck = grew ? 0 : stuck + 1;
        steps += 1;
        if (stuck >= cfg.stallSteps) { emit({ type: 'stalled' }); return; }
        if (steps >= nextLongPause) {
          nextLongPause = steps + between(env, cfg.longPauseEvery[0], cfg.longPauseEvery[1]);
          await env.sleep(between(env, cfg.longPauseMs[0], cfg.longPauseMs[1]));
        }
      }
    } finally {
      if (myToken === token) running = false;
    }
  }

  return {
    handle(command) {
      switch (command.cmd) {
        case 'start':
          cfg = { ...DEFAULT_DRIVER_CONFIG, ...(command.config ?? {}) };
          token += 1;
          void loop(token, command.reveal === true);
          return;
        case 'stop':
          token += 1;
          running = false;
          return;
        case 'probe':
          if (report() !== 'ok') watchUntilReal();
          return;
      }
    },
    announce() {
      if (report() !== 'ok') watchUntilReal();
    },
    visibilityChanged() {
      if (hiddenAnnounced && env.visible()) { hiddenAnnounced = false; emit({ type: 'visible' }); }
    },
    isRunning: () => running,
  };
}

// ------------------------------------------------------------------------------------------------ wire validation
// The service worker and the driver talk over chrome.runtime. Neither trusts the other's shapes: everything is re-validated.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, min: number, max: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined);

/**
 * Validate a command received by the driver. `allowConfig` is false in production builds: pacing is then always the human-like
 * default, so nothing that reaches the page driver can make it scroll faster than a person would.
 */
export function parseDriverCommand(raw: unknown, allowConfig: boolean): DriverCommand | undefined {
  if (!isObj(raw)) return undefined;
  if (raw.cmd === 'stop') return { cmd: 'stop' };
  if (raw.cmd === 'probe') return { cmd: 'probe' };
  if (raw.cmd !== 'start') return undefined;
  const out: Extract<DriverCommand, { cmd: 'start' }> = { cmd: 'start' };
  if (raw.reveal === true) out.reveal = true;
  if (allowConfig && isObj(raw.config)) {
    const c = raw.config;
    const config: Partial<DriverConfig> = {};
    const set = <K extends keyof DriverConfig>(k: K, v: DriverConfig[K] | undefined) => { if (v !== undefined) config[k] = v; };
    set('minDelayMs', num(c.minDelayMs, 0, 60_000));
    set('maxDelayMs', num(c.maxDelayMs, 0, 60_000));
    set('settleMaxMs', num(c.settleMaxMs, 0, 60_000));
    set('settlePollMs', num(c.settlePollMs, 10, 5_000));
    set('stallSteps', num(c.stallSteps, 1, 100));
    set('nudgeAfterStuck', num(c.nudgeAfterStuck, 0, 100));
    const pair = (v: unknown): [number, number] | undefined => (Array.isArray(v) && v.length === 2 && num(v[0], 0, 600_000) !== undefined && num(v[1], 0, 600_000) !== undefined ? [v[0] as number, v[1] as number] : undefined);
    set('longPauseEvery', pair(c.longPauseEvery));
    set('longPauseMs', pair(c.longPauseMs));
    out.config = config;
  }
  return out;
}

const HANDLE = /^[A-Za-z0-9._]{1,64}$/;
const COLLECTION_ID = /^\d{1,24}$/;

/** Validate an event received from a driver. Rebuilds it field by field so nothing extra is carried. */
export function parseDriverEvent(raw: unknown): DriverEvent | undefined {
  if (!isObj(raw)) return undefined;
  switch (raw.type) {
    case 'hidden': return { type: 'hidden' };
    case 'visible': return { type: 'visible' };
    case 'stalled': return { type: 'stalled' };
    case 'blocked': return raw.pageState === 'login' || raw.pageState === 'captcha' ? { type: 'blocked', pageState: raw.pageState } : undefined;
    case 'ready': {
      const states = ['ok', 'login', 'captcha', 'interstitial', 'unknown'] as const;
      const pageState = states.find((s) => s === raw.pageState);
      if (!pageState || !isObj(raw.view)) return undefined;
      const kinds = ['home', 'profile', 'collection', 'other'] as const;
      const kind = kinds.find((k) => k === (raw.view as Record<string, unknown>).kind);
      if (!kind) return undefined;
      const v = raw.view as Record<string, unknown>;
      const view: PageView = { kind };
      if (typeof v.pageHandle === 'string' && HANDLE.test(v.pageHandle)) view.pageHandle = v.pageHandle;
      if (typeof v.collectionId === 'string' && COLLECTION_ID.test(v.collectionId)) view.collectionId = v.collectionId;
      const ev: DriverEvent = { type: 'ready', pageState, view };
      if (typeof raw.handle === 'string' && HANDLE.test(raw.handle)) ev.handle = raw.handle;
      if (typeof raw.id === 'string' && /^\d{1,24}$/.test(raw.id)) ev.id = raw.id;
      return ev;
    }
    default: return undefined;
  }
}
