# L3 — Native platform wake events (retire hand-rolled watchdogs)

**Status:** Design, approved direction (board chose L3 on COM-333, 2026-08-12)
**Owner:** Wen's Executive Assistant (CEO agent)
**Problem class:** _"Agent claims a watcher, it silently stops."_ (COM-333)

---

## 1. The defect class (not one repo, not one case)

Paperclip agents run as **ephemeral heartbeat sessions**. Any liveness an agent sets up
_inside_ a run — a background `gh pr checks --watch &`, a `nohup` loop, a `setInterval`, or just
a promise to "keep watching" — **dies when that run ends**, but the agent has already reported
that it is monitoring. The board then has to notice the stall manually.

Concrete instances that produced COM-333:

- **COM-294 PR #59** and **COM-331 PR #60** both went CI-green, and neither was picked up — the
  issues sat in `in_review` until the board flagged it. The in-run watcher that "should have"
  merged them was already dead.
- The _previous_ COM-333 repair itself hit the same trap: it claimed "已改用 server-side routine
  兜底" but **no such routine existed** in the company routine list.

Per-case cron routines (e.g. `e9e821c7` "Green-PR pickup watchdog") only band-aid each instance.
**Every hand-rolled watchdog routine is the symptom of a missing platform event.** L3 removes the
root cause: the platform emits a native wake on the state transitions agents currently poll for,
so no repo ever has to build a watcher.

## 2. Target native events

| Event | Fires when | Retires |
|---|---|---|
| `external_object.ci_green` | A mentioned GitHub PR's check-run rollup transitions **not-green → all-green** | green-PR pickup watchdogs (incl. `e9e821c7`) |
| `external_object.pr_mergeable` | A mentioned PR transitions **not-mergeable → mergeable** (mergeable + required reviews approved, not draft, not blocked) | same |
| `interaction.accepted` | An interaction is accepted/rejected | _already native_ — see §5, use as the reference implementation |

Wake payload (all events): `{ issueId, objectId, providerKey, transition, statusCategory }`, woken
on the mentioning issue's current assignee, with `reason` set to the event name and an
`idempotencyKey` of `wake:{event}:{objectId}:{remoteVersion}` so a re-poll of the same state never
double-wakes.

## 3. Grounded hook-point map (real files @ `23c7517c2`)

### Wake primitive (shared)
- `enqueueWakeup(agentId, opts)` — `server/src/services/heartbeat.ts:15549`. The single function
  that creates every wake (writes `agentWakeupRequests` + queues a heartbeat run). `opts.reason`
  is a free-form string today; `opts.idempotencyKey` already gives us dedupe.

### Scheduler (where a native poll gets ticked)
- `server/src/index.ts:1028–1157` — the single `setInterval` scheduler tick already calls
  `tickTimers`, `tickScheduledTriggers`, and several `sweep*` helpers. **This is where a new
  `external-objects` refresh sweep must be wired in** (see §4, gap #1).

### PR state source
- `pullRequestSnapshot(...)` — `server/src/services/github-external-object-provider.ts:191`.
  Today it reads `state`, `merged`, `draft`, `reviewDecision` — it does **not** fetch `mergeable`
  or check-run/status rollup. CI-green and mergeable signals do not exist yet.

### Transition observation point
- `refreshObject(...)` — `server/src/services/external-objects.ts:771`. Already computes
  `objectChanged(prev, next)`, logs `external_object.status_changed`, and publishes a live event —
  but **never calls `enqueueWakeup`**. This is the exact seam where a green/mergeable transition
  must emit a native wake.

### Object → issue → assignee link
- `externalObjectMentions` (`packages/db/src/schema/external_object_mentions.ts:9`) maps each
  external object to its `sourceIssueId`. Resolve `sourceIssueId → issue.assigneeAgentId` to pick
  the wake target.

### TTL sweep (exists, unwired)
- `refreshDueObjects(companyId, limit, now)` — `server/src/services/external-objects.ts:906`.
  Selects non-terminal objects whose `nextRefreshAt <= now` and refreshes them. **Currently only
  called from tests** — nothing in the scheduler drives it, so PR objects never refresh in the
  background. This is why no CI-green transition is ever observed.

## 4. Two gaps to close

1. **Nothing polls PR objects in the background.** Wire `refreshDueObjects` into the
   `index.ts:1028` scheduler tick (a new `sweepDueExternalObjects`, batched per active company,
   respecting `nextRefreshAt`/TTL so we stay within GitHub rate limits).
2. **The transition emits no wake.** In `refreshObject`, after computing `objectChanged`, detect
   the specific PR transitions (green rollup, mergeable) and call `enqueueWakeup` on the mentioning
   issue's assignee with the payload/idempotency from §2.

And a prerequisite in the provider: **extend `pullRequestSnapshot`** to fetch and store check-run
rollup + `mergeable`/`mergeable_state` in `snapshot.data`, so the transition detector has fields to
compare. (GitHub check-runs are a separate `/commits/{sha}/check-runs` call; keep it behind the
existing `ghFetch` TTL cache.)

## 5. `interaction.accepted` is already the reference

Accept is a **synchronous HTTP transition** that already emits a native wake:
`POST /issues/:id/interactions/:id/accept` (`routes/issues.ts:9385`) →
`acceptInteraction` (`services/issue-thread-interactions.ts:1589`) →
`queueResolvedInteractionContinuationWakeup` (`routes/issues.ts:1928`, called at `:9515`). CI-green
and mergeable have no equivalent only because their transitions happen inside a **polling refresh**,
not an HTTP handler. L3 gives the poll path the same "transition → `enqueueWakeup`" bridge that the
accept path already has. Build the poll-side events to mirror this handler.

## 6. Phasing

- **Phase 1 — Capture** (small, isolated, unit-testable): extend `pullRequestSnapshot` with
  `mergeable` + check-run rollup fields; add a pure transition helper
  `detectPrWake(prev, next)` returning `null | "ci_green" | "pr_mergeable"`. No behavior change to
  wakes yet — pure data + logic, fully covered by unit tests on synthetic PR bodies.
- **Phase 2 — Sweep**: wire `refreshDueObjects` into the `index.ts` scheduler as a rate-limited
  background sweep. Now transitions are actually observed.
- **Phase 3 — Emit**: in `refreshObject`, on `detectPrWake(...) != null`, resolve mention →
  assignee and `enqueueWakeup` with the §2 payload + idempotency. Add integration coverage
  mirroring the accept-path test.
- **Phase 4 — Retire**: once native green-PR/mergeable events are live and observed, **retire the
  `e9e821c7` watchdog routine** and codify "no in-run watchers; liveness must be a registered
  first-class object" as the standing rule. Keep `e9e821c7` as a safety net **only until Phase 3
  is deployed and observed once** — retiring it earlier would re-strand green PRs.

## 7. Why this is the right altitude

- **Single source of truth (P14):** one platform emitter replaces N per-repo watchdogs; every
  company benefits from one change.
- **Liveness becomes unforgeable:** agents no longer _claim_ to watch — the platform wakes them.
  This is the structural version of the L1 instruction ("liveness must be a registered object") and
  the L2 run-end check, made unnecessary for this class because the event now exists natively.
- **Enumerate-and-retire:** each remaining watchdog routine in the fleet is a checklist item — it
  names exactly which native event is still missing.

## 8. Retirement record (Phase 4 — shipped & observed)

All four phases are live. Phases 1–3 merged and deployed (capture #62, sweep #64, emit #65; emit at
`external-objects.ts:972`, reasons `external_object_ci_green` / `external_object_pr_mergeable`). The
`enableExternalObjects` experimental flag is enabled on the live instance (board confirmation
`8fb6788b`, 2026-08-12).

**First live native wake observed (2026-08-12).** PR
`wenxu0907-eng/paperclip-single-thread-board#70` was captured as external object
`c3e2b544-1a00-4979-ac56-34c02374fbf5` with a real red baseline (`checksState=failure`). When CI
went green (`checksState=success`, `mergeable=true`), the poll-side transition bridge fired
end-to-end: `detectPrWake` → resolve mention → `sourceIssueId` (COM-336) → assignee →
`enqueueWakeup`. The emitted wake, verified in `agent_wakeup_requests`:

- `reason`: `external_object_ci_green`
- `source`: `automation` · `requested_by_actor_type`: `system` (platform-emitted, not agent-claimed)
- `idempotency_key`:
  `pr-wake:5778b05c…(COM-336):c3e2b544…(obj #70):ci_green:2026-08-12T19:26:54Z(remoteVersion)`
- `coalesced_count`: 0 · claimed by the woken run

This is the accept-path guarantee (§5) now extended to the poll path: the platform *wakes* the
assignee on a CI-green transition — no in-run watcher, no cron poll.

**Watchdog retired.** With one live native wake observed, the `e9e821c7` green-PR pickup watchdog
routine (COM-333 safety net) was set to `archived` — the native subsystem is now the sole path.

### Standing rule (codified, in effect)

> **No in-run watchers, no cron watchdog for external-object liveness.** When work must react to an
> external state transition — PR CI-green, PR-mergeable, or an async job/render completion — do
> **not** hand-roll an in-run background watcher (it dies when the heartbeat ends) or a polling cron
> routine. Model the thing being watched as a **registered first-class external object** and let the
> platform emit the native wake. Each such transition is a platform event to add here and enumerate,
> not a per-repo watcher to maintain. New scope (COM-367): async job/render completion joins this
> class as `external_object_async_job_done`.
