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
  // ---------------- M3 + M4: capture, identity, storage fixes, sync
  { name: "capture: another extension may send captures", file: "src/extension/capture/pipeline.ts", find: "if (sender.id !== deps.ownExtensionId) return reject(s, 'sender');", replace: "" },
  { name: "capture: sub-frame senders accepted", file: "src/extension/capture/pipeline.ts", find: "if (sender.frameId !== undefined && sender.frameId !== 0) return reject(s, 'sender');", replace: "" },
  { name: "capture: sender origin not checked against the platform", file: "src/extension/capture/pipeline.ts", find: "if (!originMatchesAny(adapter.hostMatches, sender.origin)) return reject(s, 'sender', m.kind);", replace: "" },
  { name: "capture: signed-in user not required", file: "src/extension/capture/pipeline.ts", find: "if (!viewer) return reject(s, 'identity_unknown', m.kind);", replace: "" },
  { name: "capture: other people's profile pages accepted", file: "src/extension/capture/pipeline.ts", find: "if (lc(m.pageHandle) !== viewer) return reject(s, 'not_own_profile', m.kind);", replace: "" },
  { name: "capture: payload owner not compared with the signed-in user", file: "src/extension/capture/pipeline.ts", find: "if (parsed.ownerHandle !== undefined && lc(parsed.ownerHandle) !== viewer) return reject(s, 'owner_mismatch', m.kind);", replace: "" },
  { name: "capture: viewer never recorded in the status", file: "src/extension/capture/pipeline.ts", find: "s.viewerHandle = m.viewerHandle!;", replace: "" },
  { name: "capture: stable user id dropped from the account", file: "src/extension/capture/pipeline.ts", find: "const incoming: AccountRef = { platform: m.platform, handle: m.viewerHandle!, ...(m.viewerId !== undefined ? { id: m.viewerId } : {}) };", replace: "const incoming: AccountRef = { platform: m.platform, handle: m.viewerHandle! };" },
  { name: "capture: JSON that is not a page is ingested as empty", file: "src/extension/capture/pipeline.ts", find: "if (parsed.problems.some((p) => p.code === 'bad_envelope') && empty) return reject(s, 'bad_envelope', m.kind);", replace: "" },
  { name: "capture: a page counted as duplicate whatever it holds", file: "src/extension/capture/pipeline.ts", find: "const duplicate = batch.items.length > 0 && inserted === 0;", replace: "const duplicate = true;" },
  { name: "capture: captures are not serialized", file: "src/extension/capture/pipeline.ts", find: "const next = chain.then(fn, fn);", replace: "const next = fn();" },
  { name: "capture: status handed out by reference", file: "src/extension/capture/pipeline.ts", find: "getStatus: () => serial(async () => structuredClone(await load())),", replace: "getStatus: () => serial(async () => load())," },
  { name: "capture: reset keeps memberships waiting for a collection", file: "src/extension/capture/pipeline.ts", find: "pending.clear();", replace: "" },
  { name: "capture: memberships that beat their collection are never applied", file: "src/extension/capture/pipeline.ts", find: "const waiting = pending.get(c.externalId);", replace: "const waiting = undefined as Membership[] | undefined;" },
  { name: "capture: drift (unknown item keys) never reported", file: "src/extension/capture/pipeline.ts", find: "for (const key of parsed.shape.unknownItemKeys) {", replace: "for (const key of [] as string[]) {" },
  { name: "capture: status writes are not coalesced", file: "src/extension/capture/pipeline.ts", find: "saving ??= (async () => {", replace: "saving = (async () => {" },
  { name: "capture: a status that could not be read is overwritten", file: "src/extension/capture/pipeline.ts", find: "while (dirty && loaded && status) {", replace: "while (dirty && status) {" },
  { name: "capture: a broken status store breaks captures", file: "src/extension/capture/pipeline.ts", find: "catch { status ??= emptyCaptureStatus(); }", replace: "catch (e) { throw e; }" },
  { name: "validate: capture kinds not restricted to the platform allowlist", file: "src/platforms/validate-capture.ts", find: "if (typeof m.kind !== 'string' || !adapter.captureRules.some((r) => r.kind === m.kind)) return { ok: false, reason: 'unknown_kind' };", replace: "" },
  { name: "validate: stale/future timestamps accepted", file: "src/platforms/validate-capture.ts", find: "if (Math.abs(now - m.capturedAt) > MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'stale' };", replace: "" },
  { name: "validate: oversized bodies accepted", file: "src/platforms/validate-capture.ts", find: "if (m.body.length > MAX_BODY_CHARS) return { ok: false, reason: 'too_large' };", replace: "" },
  { name: "validate: cursor not restricted to digits", file: "src/platforms/validate-capture.ts", find: "const CURSOR = /^\\d{1,16}$/;", replace: "const CURSOR = /^.*$/;" },
  { name: "validate: stable user id not restricted to digits", file: "src/platforms/validate-capture.ts", find: "const USER_ID = /^\\d{1,24}$/;", replace: "const USER_ID = /^.*$/;" },
  { name: "allowlist: paths matched by substring, not exactly", file: "src/platforms/tiktok/capture-rules.ts", find: "const rule = TIKTOK_CAPTURE_RULES.find((r) => r.path === u.pathname);", replace: "const rule = TIKTOK_CAPTURE_RULES.find((r) => u.pathname.includes(r.path));" },
  { name: "allowlist: any origin accepted", file: "src/platforms/tiktok/capture-rules.ts", find: "if (u.origin !== TIKTOK_ORIGIN) return null;", replace: "" },
  { name: "allowlist: non-digit cursors forwarded", file: "src/platforms/tiktok/capture-rules.ts", find: "if (cursor !== null && DIGITS_16.test(cursor)) out.requestCursor = cursor;", replace: "if (cursor !== null) out.requestCursor = cursor;" },
  { name: "hook: the page is not handed its response back", file: "src/extension/capture/hook.ts", find: "          return res;", replace: "          return undefined as never;" },
  { name: "hook: failed responses are captured too", file: "src/extension/capture/hook.ts", find: "if (res && res.ok === true) res.clone()", replace: "if (res) res.clone()" },
  { name: "hook: messages posted to any origin", file: "src/extension/capture/hook.ts", find: "win.postMessage(message, win.location.origin);", replace: "win.postMessage(message, '*');" },
  { name: "hook: every request is read, not only allowlisted ones", file: "src/extension/capture/hook.ts", find: "const c = classify(args[0]);", replace: "const c = classify(args[0]) ?? { kind: 'favorites' };" },
  { name: "hook: a reused XHR reports a later request", file: "src/extension/capture/hook.ts", find: "if (tracked.get(xhr as unknown as object) !== rec) return;", replace: "" },
  { name: "hook: repeated send() stacks listeners", file: "src/extension/capture/hook.ts", find: "if (rec && !rec.sent) {", replace: "if (rec) {" },
  { name: "relay: messages from other windows/origins forwarded", file: "src/extension/capture/relay.ts", find: "if (ev.source !== self || ev.origin !== win.location.origin) return;", replace: "" },
  { name: "relay: invalid messages forwarded", file: "src/extension/capture/relay.ts", find: "if (!checked.ok) return;", replace: "" },
  { name: "router: web pages may call the database RPC", file: "src/extension/message-router.ts", find: "const fromOurPage = sender.id === deps.ownExtensionId && sender.origin === deps.extensionOrigin;", replace: "const fromOurPage = true;" },
  { name: "router: driver events accepted from any site", file: "src/extension/message-router.ts", find: "originMatchesAny(deps.platformMatches ?? [], sender.origin)", replace: "true" },
  { name: "identity: page handle not validated against the handle alphabet", file: "src/platforms/tiktok/page-identity.ts", find: "return HANDLE.test(h) ? h : undefined;", replace: "return h;" },
  { name: "saved-at: response cursor ignored (no interpolation)", file: "src/platforms/tiktok/saved-at.ts", find: "const lower = lowerCandidate !== undefined && lowerCandidate < upper ? lowerCandidate : undefined;", replace: "const lower = undefined as number | undefined;" },
  { name: "saved-at: save times may lie in the future", file: "src/platforms/tiktok/saved-at.ts", find: "const upper = Math.min(cursorMs(requestCursor) ?? capturedAt, capturedAt);", replace: "const upper = cursorMs(requestCursor) ?? capturedAt;" },
  { name: "saved-at: order-only estimates labelled as dates", file: "src/platforms/tiktok/parse.ts", find: "it.savedAtSource = est.bounded ? 'interpolated' : 'unknown';", replace: "it.savedAtSource = 'interpolated';" },
  { name: "parse: photo posts not detected", file: "src/platforms/tiktok/parse.ts", find: "const photo = imagePost !== undefined;", replace: "const photo = false;" },
  { name: "parse: non-https thumbnails stored", file: "src/platforms/tiktok/parse.ts", find: "v.startsWith('https://') && v.length <= 2048", replace: "v.length <= 2048" },
  { name: "parse: collection positions ignore the page offset", file: "src/platforms/tiktok/parse.ts", find: "position: offset + i }", replace: "position: i }" },
  { name: "parse: caption length not capped", file: "src/platforms/tiktok/parse.ts", find: "descRaw.slice(0, MAX_CAPTION)", replace: "descRaw" },
  { name: "parse: a missing caption becomes empty text", file: "src/platforms/tiktok/parse.ts", find: "const caption = descRaw === undefined ? undefined : descRaw.slice(0, MAX_CAPTION);", replace: "const caption = (descRaw ?? '').slice(0, MAX_CAPTION);" },
  { name: "parse: a page may carry unlimited videos", file: "src/platforms/tiktok/parse.ts", find: "list.slice(0, MAX_ITEMS_PER_PAGE).forEach(", replace: "list.forEach(" },
  { name: "parse: a list may carry unlimited collections", file: "src/platforms/tiktok/parse.ts", find: "list.slice(0, MAX_COLLECTIONS_PER_PAGE).forEach(", replace: "list.forEach(" },
  { name: "parse: unknown keys keep their full length", file: "src/platforms/tiktok/parse.ts", find: "unknown.add(k.slice(0, MAX_UNKNOWN_KEY_LENGTH))", replace: "unknown.add(k)" },
  { name: "parse: an empty page is a bad envelope", file: "src/platforms/tiktok/parse.ts", find: "body.itemList : emptyPage(body) ? [] : undefined;", replace: "body.itemList : undefined;" },
  { name: "parse: the first page is not flagged as the head of the list", file: "src/platforms/tiktok/parse.ts", find: "batch.headOfList = true;", replace: "" },
  { name: "storage: a stub record blanks the stored caption", file: "src/core/storage/sqlite/sqlite-adapter.ts", find: "caption: it.caption ?? String(existing[3] ?? ''),", replace: "caption: it.caption ?? ''," },
  { name: "storage: hashtags a record did not send are deleted", file: "src/core/storage/sqlite/sqlite-adapter.ts", find: "const mergedTags = it.hashtags === undefined", replace: "const mergedTags = false" },
  { name: "storage: a refused account still writes", file: "src/core/storage/sqlite/sqlite-adapter.ts", find: "if (batch.account !== undefined) this.bindAccount(batch.account);", replace: "" },
  { name: "storage: a different account is accepted", file: "src/core/storage/sqlite/sqlite-adapter.ts", find: "if (m === 'different') throw new AccountMismatchError(bound);", replace: "" },
  { name: "storage: a username change is not followed", file: "src/core/storage/sqlite/sqlite-adapter.ts", find: "if (m === 'renamed' || m === 'upgraded')", replace: "if (false)" },
  { name: "storage: wipe keeps the account binding", file: "src/core/storage/sqlite/sqlite-adapter.ts", find: "'hashtags', 'collections', 'meta']", replace: "'hashtags', 'collections']" },
  { name: "storage: new saves at the head keep page-boundary dates", file: "src/core/storage/sqlite/sqlite-adapter.ts", find: "if (dateByFirstSight) { newAtHead++;", replace: "if (false) { newAtHead++;" },
  { name: "storage: every batch counts as the head of the list", file: "src/core/storage/sqlite/sqlite-adapter.ts", find: "batch.headOfList === true && batch.items.length > 0", replace: "batch.items.length > 0" },
  { name: "account: stable ids ignored (handles only)", file: "src/core/ingest/account.ts", find: "if (bound.id !== undefined && incoming.id !== undefined) {", replace: "if (false) {" },
  { name: "sync: a list with a missing page is called complete", file: "src/core/sync/machine.ts", find: "if (s.chain.gap) return listIncomplete(s, now, fx, 'the saved list');", replace: "" },
  { name: "sync: incremental pass never stops early", file: "src/core/sync/machine.ts", find: "if (s.mode === 'incremental' && s.saved.knownStreak >= s.config.knownPagesToStop) {", replace: "if (false) {" },
  { name: "sync: an incremental request with no complete pass stays incremental", file: "src/core/sync/machine.ts", find: "mode: e.mode === 'incremental' && e.hasCompletedBefore ? ('incremental' as const) : ('full' as const),", replace: "mode: e.mode," },
  { name: "sync: an incremental pass reconciles (marks videos unavailable)", file: "src/core/sync/machine.ts", find: "if (s.mode === 'full') fx.push({ type: 'reconcile', scope: 'saved' });", replace: "fx.push({ type: 'reconcile', scope: 'saved' });" },
  { name: "sync: collections are never reconciled", file: "src/core/sync/machine.ts", find: "if (s.mode === 'full') fx.push({ type: 'reconcile', scope: 'collection', collectionId: c.id });", replace: "" },
  { name: "sync: a different signed-in account is not refused", file: "src/core/sync/machine.ts", find: "if (s.boundHandle !== undefined && matchAccount(ref(s.boundHandle, s.boundId), seenNow) === 'different') return attention(s, 'wrong_account', e.now, fx);", replace: "" },
  { name: "sync: an account switch in the middle of a run goes unnoticed", file: "src/core/sync/machine.ts", find: "if (s.handle !== undefined && matchAccount(ref(s.handle, s.accountId), seenNow) === 'different') return attention(s, 'wrong_account', e.now, fx);", replace: "" },
  { name: "sync: pause does not pause", file: "src/core/sync/machine.ts", find: "s.status = 'paused';", replace: "s.status = 'running';" },
  { name: "sync: a hidden window is not noticed", file: "src/core/sync/machine.ts", find: "case 'driver_hidden': return s.status === 'running' ? attention(s, 'tab_hidden', e.now, fx) : false;", replace: "case 'driver_hidden': return false;" },
  { name: "sync: a stalled list never continues once the user opens it", file: "src/core/sync/machine.ts", find: "if (s.status === 'needs_attention' && s.attention?.reason === 'stalled' && p.items > 0 && isCurrentList(s, p)) {", replace: "if (false) {" },
  { name: "sync: a stalled list is reloaded forever", file: "src/core/sync/machine.ts", find: "if (s.stallRetries >= s.config.maxStallRetries) return attention(s, 'stalled', now, fx);", replace: "" },
  { name: "sync: the per-run page cap is not enforced", file: "src/core/sync/machine.ts", find: "if (s.totals.pages < s.config.maxPages) return false;", replace: "return false;" },
  { name: "sync: a second run may start while one is active", file: "src/core/sync/machine.ts", find: "if (isActive(s)) return false; // one run at a time; the caller reports the refusal", replace: "" },
  { name: "sync: a new run keeps the previous run's leftovers", file: "src/core/sync/machine.ts", find: "for (const k of Object.keys(s)) delete (s as unknown as Record<string, unknown>)[k]; // nothing of the previous run may leak into this one", replace: "" },
  { name: "sync: unreadable responses never mean \"blocked\"", file: "src/core/sync/machine.ts", find: "if (s.badStreak >= s.config.maxBadPages) return attention(s, 'blocked', now, fx);", replace: "" },
  { name: "driver: no think-time before scrolling", file: "src/extension/sync/driver.ts", find: "await env.sleep(between(env, cfg.minDelayMs, cfg.maxDelayMs));", replace: "" },
  { name: "driver: a hidden window is scrolled anyway", file: "src/extension/sync/driver.ts", find: "if (!env.visible()) { hiddenAnnounced = true; emit({ type: 'hidden' }); return; }", replace: "" },
  { name: "driver: a login wall or challenge is ignored", file: "src/extension/sync/driver.ts", find: "if (state === 'login' || state === 'captcha') { emit({ type: 'blocked', pageState: state }); return; }", replace: "" },
  { name: "driver: production accepts a pacing override", file: "src/extension/sync/driver.ts", find: "if (allowConfig && isObj(raw.config)) {", replace: "if (isObj(raw.config)) {" },
  { name: "coordinator: videos marked unavailable after seeing implausibly few", file: "src/extension/sync/coordinator.ts", find: "if (stored >= MIN_LIBRARY_FOR_CHECK && ids.length < stored * MIN_PLAUSIBLE_SHARE) {", replace: "if (false) {" },
  { name: "coordinator: driver events accepted from any tab", file: "src/extension/sync/coordinator.ts", find: "if (!rec || sender.tabId !== rec.tabId) return; // only the sync window's own driver counts", replace: "if (!rec) return;" },
  { name: "coordinator: a collection that came back empty is emptied", file: "src/extension/sync/coordinator.ts", find: "if (ids.length === 0 && declared > 0) return warn(", replace: "if (false) return warn(" },
  { name: "coordinator: events are not processed in order", file: "src/extension/sync/coordinator.ts", find: "const next = chain.then(fn, fn);", replace: "const next = fn();" },
  // ---------------- M5 + M6: side panel state, settings, result links
  { name: "ui: removing a chip also changes the committed search", file: "src/ui/state/query.ts", find: "return { ...rest, draft: s.draft.filter((c) => c.id !== id) };", replace: "return { ...rest, draft: s.draft.filter((c) => c.id !== id), committed: s.committed.filter((c) => c.id !== id) };" },
  { name: "ui: a mode change is not a pending change", file: "src/ui/state/query.ts", find: "(!sameChips(s.draft, s.committed) || s.mode !== s.committedMode || s.sort !== s.committedSort)", replace: "(!sameChips(s.draft, s.committed) || s.sort !== s.committedSort)" },
  { name: "ui: an empty box + Enter does not search", file: "src/ui/state/query.ts", find: "if (normalizeChipText(s.input) === '') return { state: s, search: true };", replace: "if (normalizeChipText(s.input) === '') return { state: s, search: false };" },
  { name: "ui: duplicate chips are added", file: "src/ui/state/query.ts", find: "if (s.draft.some((c) => key(c.text) === key(text))) return { ...s, input: '', notice: `\"${text}\" is already there.` };", replace: "" },
  { name: "ui: the chip cap is not enforced", file: "src/ui/state/query.ts", find: "if (s.draft.length >= MAX_CHIPS) return", replace: "if (false) return" },
  { name: "ui: a comma does not finish a category", file: "src/ui/state/query.ts", find: "if (!value.includes(',')) return base;", replace: "return base;" },
  { name: "ui: new chips ignore the saved related-words preference", file: "src/ui/state/query.ts", find: "expand: s.defaultExpand };", replace: "expand: true };" },
  { name: "ui: an older search answer replaces a newer one", file: "src/ui/state/results.ts", find: "  if (res.requestId !== s.requestId) return s;\n  const { error: _e, nextCursor: _n, ...rest } = s;", replace: "  const { error: _e, nextCursor: _n, ...rest } = s;" },
  { name: "ui: paging shows the same video twice", file: "src/ui/state/results.ts", find: "...res.results.filter((r) => !have.has(r.item.externalId))", replace: "...res.results" },
  { name: "ui: an unknown save time is shown as a date", file: "src/ui/format.ts", find: "if (source === 'unknown') return '';", replace: "" },
  { name: "settings: any sort value is accepted", file: "src/core/settings.ts", find: "(SORTS as readonly string[]).includes(patch.sort)", replace: "true" },
  { name: "settings: any page size is accepted", file: "src/core/settings.ts", find: "PAGE_SIZES.includes(patch.pageSize)", replace: "true" },
  { name: "search: a failing link builder fails the search", file: "src/core/search/service.ts", find: "try { return this.urlFor?.(item); } catch { return undefined; }", replace: "return this.urlFor?.(item);" },
  { name: "ui: the related-words checkbox ignores the saved preference when no category exists", file: "src/ui/components/SearchBox.tsx", find: "q.draft.length === 0 ? q.defaultExpand : q.draft.every((c) => c.expand)", replace: "q.draft.length === 0 || q.draft.every((c) => c.expand)" },
  { name: "ui: a pasted line-break list is not recognised as a list", file: "src/ui/state/query.ts", find: "/[,\\n\\r]/.test(text)", replace: "/[,]/.test(text)" },
  { name: "ui: a pasted list overwrites what was typed in the box", file: "src/ui/state/query.ts", find: "return { ...next, input: s.input };", replace: "return next;" },
  { name: "ui: a pasted list becomes one chip", file: "src/ui/state/query.ts", find: "for (const part of text.split(/[,\\n\\r]+/)) next = addChip(next, part);", replace: "next = addChip(next, text);" },
  // ---------------- second code review: sync trust, restart, UI paging
  { name: "sync: captures from any tab move the run", file: "src/extension/sync/coordinator.ts", find: "return rec === undefined || rec.tabId !== from.tabId;", replace: "return false;" },
  { name: "sync: refusals from any tab move the run", file: "src/extension/sync/coordinator.ts", find: "if (await fromOtherTab(await load(), from)) return; // someone else's page", replace: "if (false) return; // someone else's page" },
  { name: "sync: the first page after a guided open is not remembered", file: "src/extension/sync/coordinator.ts", find: "(s.attention?.reason === 'open_collections' || s.attention?.reason === 'stalled'));", replace: "s.attention?.reason === 'open_collections');" },
  { name: "sync: a replayed page counts twice in the saved plausibility check", file: "src/extension/sync/coordinator.ts", find: "const ids = [...new Set(await env.store.seenRead(s.runId, 'saved'))];", replace: "const ids = await env.store.seenRead(s.runId, 'saved');" },
  { name: "sync: a collection is reconciled after seeing a sliver of it", file: "src/extension/sync/coordinator.ts", find: "if (expected >= MIN_LIBRARY_FOR_CHECK && ids.length < expected * MIN_PLAUSIBLE_SHARE) {", replace: "if (false) {" },
  { name: "sync: a run without a window of this session carries on by itself", file: "src/extension/sync/coordinator.ts", find: "if (s.status === 'running' && !(await env.store.loadWindow())) return dispatch({ type: 'tab_closed', now: env.now() });", replace: "" },
  { name: "sync: wipe or import keeps the last complete pass", file: "src/extension/sync/coordinator.ts", find: "await env.store.clearLast(env.spec.platform); // the next sync must read everything again, not stop after two known pages", replace: "" },
  { name: "sync: a hidden window that is closed stays hidden forever", file: "src/core/sync/machine.ts", find: "case 'tab_closed': return s.status === 'running' || (s.status === 'needs_attention' && s.attention?.reason === 'tab_hidden')", replace: "case 'tab_closed': return s.status === 'running'" },
  { name: "sync: a partial collection list is not reported", file: "src/core/sync/machine.ts", find: "if (p.hasMore === true && !s.warnings.includes(MORE_COLLECTIONS) && s.warnings.length < 20) s.warnings.push(MORE_COLLECTIONS);", replace: "" },
  { name: "sync: a window record of an earlier browser session is trusted", file: "src/extension/sync/chrome-env.ts", find: "if (!rec || rec.boot !== (await bootId())) return undefined;", replace: "if (!rec) return undefined;" },
  { name: "sync: closing the sync closes the whole window", file: "src/extension/sync/chrome-env.ts", find: "close: async (rec) => { await chrome.tabs.remove(rec.tabId); },", replace: "close: async (rec) => { await chrome.windows.remove(rec.windowId); }," },
  { name: "sync: the heartbeat is restarted by every event", file: "src/extension/sync/chrome-env.ts", find: "(a ? undefined : chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 }))", replace: "chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 })" },
  { name: "capture: the sender tab is not passed to the sync", file: "src/extension/capture/pipeline.ts", find: "source = sender.tabId !== undefined ? { tabId: sender.tabId } : {};", replace: "source = {};" },
  { name: "ui: a new search keeps the old search's paging cursor", file: "src/ui/state/results.ts", find: "const { nextCursor: _old, ...rest } = s;\n  return { ...rest, status: 'loading', requestId, loadingMore: false, chipInfo: [] };", replace: "return { ...s, status: 'loading', requestId, loadingMore: false, chipInfo: [] };" },
  { name: "ui: rows are not rebuilt for a new search", file: "src/ui/state/results.ts", find: "`${s.itemsFor ?? ''}:${item.platform}:${item.externalId}`", replace: "`${item.platform}:${item.externalId}`" },
  { name: "ui: text with no letter, number or emoji becomes a chip", file: "src/ui/state/query.ts", find: "if (!searchable(text)) return { ...s, notice: 'A category needs at least one letter, number or emoji.' };", replace: "" },
  { name: "ui: a hidden sync window is offered only Cancel", file: "src/ui/state/sync-view.ts", find: "buttons: ['resume', 'cancel'], // a hidden window", replace: "buttons: s.attention?.reason === 'tab_hidden' ? ['cancel'] : ['resume', 'cancel'], // a hidden window" },
];

const only = process.argv[2];
const list = only ? M.filter((m) => m.name.includes(only)) : M;
let escaped = 0;
const results = [];
const vitest = () => spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vitest', 'run', '--reporter=dot'], { encoding: 'utf8', shell: true });

// The file currently mutated, so an interrupt (Ctrl-C, kill) can put it back. A killed run must never leave broken source behind.
let mutated = null;
const restore = () => { if (mutated) { try { fs.writeFileSync(mutated.file, mutated.original); } catch { /* best effort */ } mutated = null; } };
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restore(); process.exit(130); });

// Without a green baseline every mutation would "fail the suite" and be reported as caught: prove the suite passes first.
const baseline = vitest();
if (baseline.status !== 0) { console.error('the test suite is not green BEFORE any mutation, so the results would mean nothing. Fix the tests first.\n' + ((baseline.stdout ?? '') + (baseline.stderr ?? '')).split('\n').slice(-25).join('\n')); process.exit(2); }
console.log('baseline: the suite is green');

for (const m of list) {
  const file = path.resolve(m.file);
  const original = fs.readFileSync(file, 'utf8');
  const crlf = original.includes('\r\n'); // Windows checkouts: match and mutate on LF text, write back with the file's own line endings
  const text = crlf ? original.replace(/\r\n/g, '\n') : original;
  if (!text.includes(m.find)) { console.error(`MUTATION TARGET NOT FOUND: ${m.name}\n  file: ${m.file}\n  find: ${m.find}`); process.exit(2); }
  try {
    mutated = { file, original };
    const changed = text.replace(m.find, () => m.replace);
    fs.writeFileSync(file, crlf ? changed.replace(/\n/g, '\r\n') : changed);
    const r = vitest();
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const failed = /(\d+) failed/.exec(out)?.[1] ?? (r.status === 0 ? '0' : '?');
    const caught = r.status !== 0;
    if (!caught) escaped++;
    results.push({ name: m.name, caught, failed });
    console.log(`${caught ? 'caught ' : 'ESCAPED'}  ${m.name}  (${failed} test(s) failed)`);
  } finally {
    restore();
  }
}
console.log(`\n${results.length - escaped}/${results.length} mutations caught`);
process.exit(escaped === 0 ? 0 : 1);
