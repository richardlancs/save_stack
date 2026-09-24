// The page driver's scroll loop, with virtual time and a fake page: pacing, growth/stall detection, hidden windows, challenges.
import { describe, expect, it } from 'vitest';
import { createPageDriver, DEFAULT_DRIVER_CONFIG, type DriverEnv, type DriverEvent, type DriverPlatform } from '../../src/extension/sync/driver';
import type { PageSnapshot, PageState } from '../../src/core/sync/types';

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A fake page whose list grows after each scroll, for as long as `pages` remain. */
function fakePage(o: { pages?: number; growDelayMs?: number; visible?: boolean; state?: () => PageState; random?: () => number } = {}) {
  let clock = 0;
  let height = 1000;
  let pages = o.pages ?? 5;
  const due: Array<{ at: number; grow: number }> = [];
  const sleeps: number[] = [];
  const scrolls: number[] = []; // virtual time of each scroll
  let nudges = 0;
  let reveals = 0;
  let visible = o.visible ?? true;
  const settleDue = () => { for (let i = due.length - 1; i >= 0; i--) if (due[i]!.at <= clock) { height += due[i]!.grow; due.splice(i, 1); } };
  let onScroll: (() => void) | undefined;
  const env: DriverEnv = {
    sleep: async (ms) => { sleeps.push(ms); clock += ms; settleDue(); await Promise.resolve(); },
    random: o.random ?? (() => 0.5),
    visible: () => visible,
    scrollHeight: () => height,
    scrollToBottom: () => {
      scrolls.push(clock);
      if (pages > 0) { pages--; due.push({ at: clock + (o.growDelayMs ?? 400), grow: 800 }); }
      onScroll?.();
    },
    nudge: () => { nudges++; },
    reveal: () => { reveals++; return true; },
    snapshot: (): PageSnapshot => ({ pathname: '/x', search: '', title: 't', viewer: 'me', hasBootstrap: true, present: {} }),
  };
  const platform: DriverPlatform = {
    detectPageState: () => (o.state ? o.state() : 'ok'),
    classifyPage: () => ({ kind: 'profile', pageHandle: 'me' }),
  };
  const events: DriverEvent[] = [];
  const driver = createPageDriver(env, platform, (e) => events.push(e));
  return { driver, events, sleeps, scrolls, nudges: () => nudges, reveals: () => reveals, setVisible: (v: boolean) => { visible = v; }, onScroll: (f: () => void) => { onScroll = f; }, clock: () => clock };
}

describe('page driver', () => {
  it('scrolls while the list keeps growing, then reports a stall after the configured number of steps with no growth', async () => {
    const p = fakePage({ pages: 5 });
    p.driver.handle({ cmd: 'start' });
    await settle();
    expect(p.events).toEqual([{ type: 'stalled' }]);
    expect(p.scrolls.length).toBe(5 + DEFAULT_DRIVER_CONFIG.stallSteps);
    expect(p.driver.isRunning()).toBe(false);
  });

  it('paces itself: every step waits a random delay within bounds, and it takes a longer pause every so often', async () => {
    let i = 0;
    const p = fakePage({ pages: 40, random: () => [0.1, 0.9, 0.5, 0.3, 0.7][i++ % 5]! });
    p.onScroll(() => { if (p.scrolls.length >= 40) p.driver.handle({ cmd: 'stop' }); });
    p.driver.handle({ cmd: 'start' });
    await settle();
    const { minDelayMs, maxDelayMs, longPauseMs, settlePollMs } = DEFAULT_DRIVER_CONFIG;
    const stepDelays = p.sleeps.filter((ms) => ms >= minDelayMs && ms <= maxDelayMs);
    const longPauses = p.sleeps.filter((ms) => ms >= longPauseMs[0] && ms <= longPauseMs[1]);
    expect(stepDelays.length).toBeGreaterThanOrEqual(35);
    expect(new Set(stepDelays).size).toBeGreaterThan(2); // not a metronome
    expect(longPauses.length).toBeGreaterThanOrEqual(2);
    expect(p.sleeps.every((ms) => ms === settlePollMs || (ms >= minDelayMs && ms <= maxDelayMs) || (ms >= longPauseMs[0] && ms <= longPauseMs[1]))).toBe(true);
  });

  it('does not scroll the instant it starts: the first scroll waits a human think-time too', async () => {
    const p = fakePage({ pages: 3 });
    p.onScroll(() => { if (p.scrolls.length >= 3) p.driver.handle({ cmd: 'stop' }); });
    p.driver.handle({ cmd: 'start' });
    await settle();
    expect(p.scrolls[0]).toBeGreaterThanOrEqual(DEFAULT_DRIVER_CONFIG.minDelayMs);
  });

  it('never scrolls faster than the minimum delay allows', async () => {
    const p = fakePage({ pages: 20 });
    p.onScroll(() => { if (p.scrolls.length >= 20) p.driver.handle({ cmd: 'stop' }); });
    p.driver.handle({ cmd: 'start' });
    await settle();
    const gaps = p.scrolls.slice(1).map((t, i) => t - p.scrolls[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(DEFAULT_DRIVER_CONFIG.minDelayMs);
  });

  it('stop ends the loop with no further scrolls, and a fresh start works', async () => {
    const p = fakePage({ pages: 50 });
    p.onScroll(() => { if (p.scrolls.length === 3) p.driver.handle({ cmd: 'stop' }); });
    p.driver.handle({ cmd: 'start' });
    await settle();
    expect(p.scrolls.length).toBe(3);
    expect(p.driver.isRunning()).toBe(false);
    p.onScroll(() => undefined);
    p.driver.handle({ cmd: 'start', config: { stallSteps: 2 } });
    await settle();
    expect(p.scrolls.length).toBeGreaterThan(3);
  });

  it('restarting never runs two loops at once', async () => {
    const p = fakePage({ pages: 6 });
    p.driver.handle({ cmd: 'start' });
    p.driver.handle({ cmd: 'start' });
    p.driver.handle({ cmd: 'start' });
    await settle();
    // one loop's worth of scrolls (plus at most the first scroll each superseded loop managed before it noticed)
    expect(p.scrolls.length).toBeLessThanOrEqual(6 + DEFAULT_DRIVER_CONFIG.stallSteps + 2);
    expect(p.events.filter((e) => e.type === 'stalled')).toHaveLength(1);
  });

  it('clicks the list-opening control once before scrolling, only when asked to', async () => {
    const a = fakePage({ pages: 2 });
    a.driver.handle({ cmd: 'start', reveal: true });
    await settle();
    expect(a.reveals()).toBe(1);
    const b = fakePage({ pages: 2 });
    b.driver.handle({ cmd: 'start' });
    await settle();
    expect(b.reveals()).toBe(0);
  });

  it('adds a synthetic wheel nudge only once the list has stopped growing', async () => {
    const p = fakePage({ pages: 3 });
    p.driver.handle({ cmd: 'start' });
    await settle();
    expect(p.nudges()).toBeGreaterThan(0);
    expect(p.nudges()).toBeLessThan(p.scrolls.length); // not on every step
    const healthy = fakePage({ pages: 30 });
    healthy.onScroll(() => { if (healthy.scrolls.length >= 20) healthy.driver.handle({ cmd: 'stop' }); });
    healthy.driver.handle({ cmd: 'start' });
    await settle();
    expect(healthy.nudges()).toBe(0);
  });

  it.each(['login', 'captcha'] as const)('stops at once when the page shows a %s wall', async (state) => {
    let current: PageState = 'ok';
    const p = fakePage({ pages: 50, state: () => current });
    p.onScroll(() => { if (p.scrolls.length === 4) current = state; });
    p.driver.handle({ cmd: 'start' });
    await settle();
    expect(p.events).toEqual([{ type: 'blocked', pageState: state }]);
    expect(p.scrolls.length).toBe(4);
  });

  it('does not scroll a hidden window: reports it, and reports again when it becomes visible', async () => {
    const p = fakePage({ pages: 5, visible: false });
    p.driver.handle({ cmd: 'start' });
    await settle();
    expect(p.events).toEqual([{ type: 'hidden' }]);
    expect(p.scrolls).toEqual([]);
    p.driver.visibilityChanged(); // still hidden: nothing
    expect(p.events).toHaveLength(1);
    p.setVisible(true);
    p.driver.visibilityChanged();
    expect(p.events).toEqual([{ type: 'hidden' }, { type: 'visible' }]);
    p.driver.visibilityChanged(); // only once per hidden
    expect(p.events).toHaveLength(2);
    p.driver.handle({ cmd: 'start' });
    await settle();
    expect(p.scrolls.length).toBeGreaterThan(0);
  });

  it('a window that turns hidden mid-run stops scrolling and says so', async () => {
    const p = fakePage({ pages: 50 });
    p.onScroll(() => { if (p.scrolls.length === 3) p.setVisible(false); });
    p.driver.handle({ cmd: 'start' });
    await settle();
    expect(p.events).toEqual([{ type: 'hidden' }]);
    expect(p.scrolls.length).toBe(3);
  });

  it('visibility changes with nothing hidden reported before are ignored', () => {
    const p = fakePage();
    p.driver.visibilityChanged();
    expect(p.events).toEqual([]);
  });

  it('announce and probe report who is signed in, the page kind and its state', () => {
    const p = fakePage();
    p.driver.announce();
    p.driver.handle({ cmd: 'probe' });
    expect(p.events).toEqual([
      { type: 'ready', handle: 'me', pageState: 'ok', view: { kind: 'profile', pageHandle: 'me' } },
      { type: 'ready', handle: 'me', pageState: 'ok', view: { kind: 'profile', pageHandle: 'me' } },
    ]);
  });

  it('after an interstitial it keeps watching and reports again once the real page appears', async () => {
    let state: PageState = 'interstitial';
    const p = fakePage({ state: () => state });
    p.driver.announce();
    expect(p.events).toMatchObject([{ type: 'ready', pageState: 'interstitial' }]);
    await settle();
    state = 'ok';
    await settle();
    // the watcher slept virtually; give it one more pass now that the state changed
    p.driver.handle({ cmd: 'probe' });
    expect(p.events.filter((e) => e.type === 'ready' && e.pageState === 'ok').length).toBeGreaterThanOrEqual(1);
  });

  it('gives up watching an interstitial that never goes away', async () => {
    const p = fakePage({ state: () => 'interstitial' });
    p.driver.announce();
    await settle();
    expect(p.events.filter((e) => e.type === 'ready')).toHaveLength(1);
    expect(p.clock()).toBeLessThanOrEqual(40 * 1500 + 1);
  });
});

import { parseDriverCommand, parseDriverEvent } from '../../src/extension/sync/driver';

describe('driver wire validation', () => {
  it('accepts the three commands and nothing else', () => {
    expect(parseDriverCommand({ cmd: 'stop' }, false)).toEqual({ cmd: 'stop' });
    expect(parseDriverCommand({ cmd: 'probe', extra: 1 }, false)).toEqual({ cmd: 'probe' });
    expect(parseDriverCommand({ cmd: 'start' }, false)).toEqual({ cmd: 'start' });
    expect(parseDriverCommand({ cmd: 'start', reveal: true }, false)).toEqual({ cmd: 'start', reveal: true });
    for (const bad of [null, undefined, 5, 'start', [], {}, { cmd: 'eval', code: 'x' }, { cmd: 'START' }, { cmd: 7 }]) expect(parseDriverCommand(bad, true), String(bad)).toBeUndefined();
  });

  it('production ignores any pacing config, so nothing can make the driver scroll faster than a person', () => {
    expect(parseDriverCommand({ cmd: 'start', config: { minDelayMs: 0, maxDelayMs: 0, stallSteps: 1 } }, false)).toEqual({ cmd: 'start' });
  });

  it('test builds accept a bounded, typed config and drop everything else', () => {
    const c = parseDriverCommand({ cmd: 'start', config: { minDelayMs: 5, maxDelayMs: 10, stallSteps: 3, longPauseEvery: [2, 3], longPauseMs: [1, 2], bogus: 1, settleMaxMs: -1, nudgeAfterStuck: 'x' } }, true);
    expect(c).toEqual({ cmd: 'start', config: { minDelayMs: 5, maxDelayMs: 10, stallSteps: 3, longPauseEvery: [2, 3], longPauseMs: [1, 2] } });
    expect(parseDriverCommand({ cmd: 'start', config: { minDelayMs: 1e12, longPauseMs: [1] } }, true)).toEqual({ cmd: 'start', config: {} });
  });

  it('validates driver events and rebuilds them without extras', () => {
    expect(parseDriverEvent({ type: 'hidden', junk: 1 })).toEqual({ type: 'hidden' });
    expect(parseDriverEvent({ type: 'visible' })).toEqual({ type: 'visible' });
    expect(parseDriverEvent({ type: 'stalled' })).toEqual({ type: 'stalled' });
    expect(parseDriverEvent({ type: 'blocked', pageState: 'captcha' })).toEqual({ type: 'blocked', pageState: 'captcha' });
    expect(parseDriverEvent({ type: 'blocked', pageState: 'ok' })).toBeUndefined();
    expect(parseDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: { kind: 'collection', pageHandle: 'me', collectionId: '7000000000000000501', cookie: 'x' }, cookie: 'y' }))
      .toEqual({ type: 'ready', handle: 'me', pageState: 'ok', view: { kind: 'collection', pageHandle: 'me', collectionId: '7000000000000000501' } });
    expect(parseDriverEvent({ type: 'ready', handle: 'a b', pageState: 'ok', view: { kind: 'other', pageHandle: '<x>', collectionId: 'abc' } })).toEqual({ type: 'ready', pageState: 'ok', view: { kind: 'other' } });
    expect(parseDriverEvent({ type: 'ready', handle: 'me', id: '7000000000000000099', pageState: 'ok', view: { kind: 'home' } })).toEqual({ type: 'ready', handle: 'me', id: '7000000000000000099', pageState: 'ok', view: { kind: 'home' } });
    expect(parseDriverEvent({ type: 'ready', handle: 'me', id: 'abc', pageState: 'ok', view: { kind: 'home' } })).toEqual({ type: 'ready', handle: 'me', pageState: 'ok', view: { kind: 'home' } });
    for (const bad of [null, 5, 'x', [], {}, { type: 'ready' }, { type: 'ready', pageState: 'weird', view: { kind: 'home' } }, { type: 'ready', pageState: 'ok', view: { kind: 'nope' } }, { type: 'ready', pageState: 'ok', view: null }, { type: 'other' }])
      expect(parseDriverEvent(bad), JSON.stringify(bad)).toBeUndefined();
  });
});
