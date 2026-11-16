# MIGRATING.md — re-basing `paperclip-single-thread-board` onto upstream Paperclip

**Audience:** two readers, one document. (1) The board, deciding how much of the fork survives.
(2) Anyone running a clone of this fork, who needs to know what changes under them.

**Status:** COM-524 / COM-521 Phase 1 deliverable. Read-only analysis — no code changed, no database
touched, no live checkout modified.

| | |
| --- | --- |
| Fork's last upstream merge | 2026-07-23 (merge-base `8a3cc8653`, 2026-07-22) |
| Upstream target | `upstream/master` @ **`c5218f5ec4`** (2026-11-15, PR #21852) |
| Gap | **4,909 commits** |
| Fork-local source footprint | 107 non-test source files, +9,089 / −696 lines |
| Migration collision | ours ends at `0184_board_only_on_parents.sql`; **upstream's own 0184 is `0184_routable_blocked.sql`** and upstream has **486** migrations |

### Correction to the plan, before the table

The local tag **`v2026.1106.0` does not point at the November release** — in this checkout it resolves to
`d69631b01b`, dated **2026-10-22** (PR #17269), covering only 2,312 of the 4,909 commits. Plan rev 4 §3
measured memory against that tag, so it was blind to three weeks of upstream work. **Everything in this
report is measured against the true tip `c5218f5ec4`.** The §3 conclusion survives re-checking:
`git ls-tree -r upstream/master | grep agent-memory` is still empty at the true tip.

---

## 1. Verdict table

Every row has a verdict. Every `drop` names the upstream artifact that replaces it. Verdicts are
`drop` (upstream does it), `port` (we still need it), `redesign` (the need is real but upstream's new
module boundaries mean a rewrite, not a patch replay).

| # | Our fork feature | Upstream equivalent at `c5218f5ec4` | Verdict | If port/redesign — insertion point |
| --- | --- | --- | --- | --- |
| 1 | **COM-178** — interaction-continuation wake recognized without payload mutation (`heartbeat.ts`) | `feat: queue approvals and answers during active runs` (**#13539**); `fix(server): wake interaction continuations from committed responses` (**#17653**); `fix(recovery): do not race a just-accepted interaction's own continuation wake` (**#19332**) | **drop** | — |
| 2 | **COM-180** — duplicate confirmation cards | `fix(queue): clear interaction receipts a run already delivered` (**#19376**); `fix(interactions): deliver question answers durably` (**#12307**) | **drop** | — |
| 3 | **COM-294** — platform-managed "Current Goal & Decisions" block in the issue description (`managed-goal-block.ts`, +611) | **None.** Upstream's `server/src/services/issue-goal-fallback.ts` resolves *project goal IDs* — an unrelated concept. No `PAPERCLIP:GOAL` marker, no description-managed block anywhere in the upstream tree. | **port** | Keep `managed-goal-block.ts` as an additive module. Re-hook at upstream's description write path in `server/src/routes/issues.ts` and at `issue-continuation-summary.ts::refreshIssueContinuationSummary` (both files still exist upstream). |
| 4 | **COM-296** — CJK font fallbacks + softer inline-code chips | **None.** `upstream/master:ui/src/index.css:157` still ships `--font-sans: "InterVariable", "Inter", …, sans-serif` with no CJK face. | **port** | 3 lines in `ui/src/index.css` `@theme inline` (append PingFang SC / Hiragino Sans GB / Microsoft YaHei / Noto Sans SC / WenQuanYi Micro Hei to `--font-sans` and `--font-mono`). Cheapest row in the table. |
| 5 | **COM-319** — hydrate newest comments + anchor `latestCommentId` on resolved-interaction wakes | **#13539**; **#19376**; `fix(wake-queue): deliver user comments whose wake a restart lost or a stale continuation dropped` (**#19992**) | **drop** | — |
| 6a | **COM-322a** — interrupt zombie ACPX runs on cancel | `refactor(heartbeat): extract run cancellation and cleanup` (**#15685**); `fix: fence native startup against cancellation` (**#13316**); `fix: settle interrupted preparation with a retained cancellation fence` (**#15022**); `fix(runtime): retain cancelled workspaces before reconstruction` (**#16700**). Also: ACPX is no longer the default lane — the Paperclip Runner is. | **drop** | — |
| 6b | **COM-322b** — reject issue-create from terminal runs | Upstream has a first-class run **terminal fence** on the issue write path: `upstream/master:server/src/routes/issues.ts:15802-15808` ("a run's terminal fence accepts the task it gave away… save an assignment its own terminal fence would then refuse"). | **drop** | — |
| 7 | **COM-331** — carry answered `ask_user_questions` answers into the resume wake | **#12307**; **#13539**; `fix(server): stop a queued answer from blocking saved-work recovery` (**#19318**) | **drop** | — |
| 8a | **COM-335a** — recovery escalation idempotence, owner-wake caps, emergency kill switches, self-excitation loop | `fix(recovery): a chat turn waiting on the person is not stranded work` (**#21302**); `feat(recovery): settle a claimed wake whose run finished without settling it` (**#19934**); `feat(recovery): model an unclaimed pending-cleanup item as owned by the cleanup queue` (**#19980**); `fix(recovery): continue runs that a server restart or replacement ended, without spending the failure budget` (**#21019**); plus upstream's budget-admission subsystem (#20484, #21185, #20391) | **drop** | — |
| 8b | **COM-335b** — reviewer-seat guard (assignee cannot be its own only reviewer) + pending execution-stage participant keeps issue write access | **None found.** Upstream enforces review *policy* on verdicts (`fix(server): enforce review policy on interaction verdicts`) but has no self-review seat-collapse guard and no pending-participant authz carve-out. | **port** | Reviewer-seat validation in upstream `server/src/routes/issues.ts` assignment/review handlers; the authz carve-out in `server/src/services/authorization.ts`. ~60 lines total. |
| 9 | **COM-336** — native wake events on PR CI-green / mergeable transitions (`external-objects.ts`, `detectPrWake`, background due-refresh sweep) | **Partial, by a different mechanism.** Upstream retired heartbeat polling with first-class **monitors**: `fix(server): schedule issue monitors without heartbeat polling` (**#17863**), `fix(recovery): default saved-monitor waits` (**#16686**), `fix: make Check now work for retained monitors on blocked tasks` (**#18061**). But upstream's GitHub check pipeline is explicitly *not* a wake source — `upstream/master:server/src/services/chat-github-checks.ts:29`: **"This outbox never schedules an agent."** | **redesign** | Adopt upstream monitors as the mechanism (that is what retires the polling routine, which was COM-336's actual purpose). Port **only** the `detectPrWake` green/mergeable predicate into a monitor evaluator if monitors prove too coarse in Phase 4. Do **not** replay the `external-objects.ts` sweep — upstream kept that file but never extended it this way. |
| 10 | **COM-355** — drop the stale "wait for review" next-action when the issue is back `in_progress` | **None.** `upstream/master:server/src/services/issue-continuation-summary.ts:110` still returns `previousNextAction` unguarded, and `continuationSummaryParksExecutor` still parks the continuation on it (`server/src/modules/run-dispatch/adapters/postgres.ts:674`, `domain/policy.ts:569`). The bug is live upstream. | **port** | 4-line guard in `inferNextAction` (`issue-continuation-summary.ts`), using upstream's own `WAITING_FOR_REVIEW_OR_APPROVAL_RE` (line 13) which already exists there. Highest value-per-line row in the table. |
| 11 | **COM-356** — live status badge (running / waiting-for-review / parked) | `feat(ui): add task status badges and inline blocker removal` (**#13097**); `fix(ui): surface live runtime status in the task-chat tail before the first transcript token` (**#11802**); `fix(runtime): stop Live badge and Working shimmer after task teardown` (**#10985**) | **drop** | — |
| 12 | **COM-361** — recency-precedence supersession for board decisions in the goal block | Same module as COM-294; fork-only. | **port** | Travels with `managed-goal-block.ts` (row 3). Not separable. |
| 13 | **COM-374** — scroll-to-page-end reaches the true page end, one SSOT (`scroll-to-page-end.ts`, 163 lines) | Upstream rewrote the same component for the same bug: `upstream/master:ui/src/components/ScrollToBottom.tsx` now has `resolveScrollTarget()` (picks `#main-content` vs window by computed `overflowY`) and `distanceFromBottom()` with the `document.scrollingElement` fallback. | **drop** | — Delete `ui/src/lib/scroll-to-page-end.ts` rather than porting it. |
| 14 | **COM-376** — `claude-agent-acp` 0.59.0 → 0.66.0 (persistent-session ~15s stall) | `fix(paperclip-runner): bump claude-agent-acp pin to 0.73.0` (**#13162**), via #10302 → #11314 → #11728 → #11873 | **drop** | — |
| 15 | **COM-382** — keep recent context visible above the New divider / pin running work below it | `fix(ui): bound the queued-message strip so it scrolls instead of covering the conversation` (**#19321**); `Restore chat contacts, agent pins, and scrollable recent navigation` (**#19685**); `perf(chat): load recent messages and page history on scroll` (**#18358**) | **drop** | — Note: our COM-382 is still `in_review` with the board's A/B/C design question **never answered**, and upstream rewrote `IssueChatThread.tsx` underneath it. Porting an unsettled design onto a rewritten component is the wrong move; if the board still wants this, it is a fresh design task against upstream's thread. |
| 16 | **COM-393** — productivity-review triggers + `long_active_duration` kill switch + high-churn exclusion | `refactor: remove automatic productivity reviews` (**#13263**). The feature is **deleted upstream**, replaced by the attention service (`packages/shared/src/types/attention.ts`, `docs/api/attention.md`). | **drop** | — We stop maintaining it entirely. |
| 17 | **COM-399** — stop escalating a pending review participant when a real decision is live (`review-participant-decision-gate.ts`) | **#21302** (`a chat turn waiting on the person is not stranded work`) — upstream's `recovery/assigned-work-invariant.ts` + `stranded-hold-continuation.ts` now model this natively. | **drop** | — |
| 18 | **COM-403** — recognize ACPX `Monitor`-tool CI waits as a live continuation path | **#17863**, **#16686**, `fix(native): settle completed results that retain a valid monitor` (**#17641**), `fix(ui): explain monitor waits during active runs` (**#19519**). Monitors are first-class upstream, so the blind spot that produced the ~9× repeat-card storm cannot form. | **drop** | — |
| 19 | **COM-406** — atomically release `checkoutRunId` on terminal run transition | `feat(recovery): settle stale issue execution and checkout locks on the shared ownership path` (**#20006**); `fix(server): keep a successor's issue lock when a finalizing native run releases its checkout` (**#19156**) | **drop** | — |
| 20 | **COM-413** — coding-agent fallback chain on quota/billing failure | **Nothing to port: we reverted it ourselves** (`a463e5cd46`, `557da20aea`). Upstream's answer is the BYO model gateway — OpenRouter / Bedrock / Gemini / Responses API (#21311, #21468, #19977). | **drop** | — |
| 21 | **COM-423** — keep thought-channel deltas out of the run summary | Upstream fixed it independently: `upstream/master:packages/adapter-utils/src/acpx-engine/execute.ts:5045` ("Summary accumulation collects output text only (never thought stream)"), `:3272`, `:5335` (`event.stream !== "thought"`); plus `fix: exclude thought text from automatic issue comments` (**#11801**) | **drop** | — |
| 22 | **COM-426** — bind initial runs to one canonical issue | **Partial.** Upstream scopes *continuations and retries* per issue — `fix(wake-queue): keep promoted Retry runs scoped to their issue` (**#18876**), `Keep interaction continuations scoped to the target task` — but I found no equivalent binding for a *first* run in upstream's `heartbeat.ts`. | **redesign** | Treat as unproven-fixed: do **not** port the `heartbeat.ts` patch (that file went 17,107 → 4,862 lines and the anchor is gone). Instead add "one issue assigned → exactly one initial run" to the **Phase 4 smoke list**, and only then re-implement against upstream's run-dispatch module if it reproduces. |
| 23 | **COM-456** — bound the backup directory with a real retention policy | **Upstream does NOT replace this.** `upstream/master:packages/db/src/backup-lib.ts:122` still reads *"Daily tier: keep ALL backups from the last `dailyDays` days"* — the exact behaviour that grew our live directory to 39 GB — and has **no** `maxTotalCount` / `maxTotalGb` backstop anywhere in the file. | **port** | `packages/db/src/backup-lib.ts::pruneOldBackups` (newest-per-calendar-day daily tier + the two hard caps + the always-keep-newest guard), with the settings surface in `packages/shared/src/types/instance.ts` and `ui/src/pages/InstanceGeneralSettings.tsx`. **This corrects plan rev 6 §2.1**, which listed COM-456 as replaced by #21588/#21571/#21579/#21595 — those are *native session / workspace* retention, a different subsystem. |
| 24 | **COM-459** — return a failed comment's text to the composer instead of dropping it | Upstream shipped a fuller version of the same fix: `upstream/master:ui/src/lib/comment-submit-draft.ts` (`restoreSubmittedCommentDraft`, `loadDraftSubmission`, `settleDraftSubmission`) wired into `IssueChatThread.tsx` as `draftRecovery` with cross-tab buffer preservation and attempt IDs. | **drop** | — Plan rev 6 §2.1 cited #19992 (wake-queue delivery) for this row; that is the wrong artifact — #19992 fixes *wake loss*, not *composer text loss*. The real replacement is the UI draft-recovery library above. |
| 25 | **`board_only_on_parents`** — board members may only be assigned to / review top-level issues (flag-gated, default off) + migration `0184` | **None.** No `boardOnly`/`board_only` concept in upstream's source (the only hits are in an unrelated `doc/plans/` OpenAPI script). | **port** | `server/src/services/board-only-on-parents.ts` is additive and carries no conflict. Re-hook the two guards in upstream `server/src/routes/issues.ts`. **Migration must be renumbered off the 0184 slot to 0487+** — this is the single hard database action in the whole re-base. |
| 26 | **Agent-memory tooling** (`agent-memory-files.ts` +582, `/api/agents/.../memory` routes, shared `agent-memory` types, the Memories tab: adapter-aware source, project-scoped harness memory, configured-cwd reads) | **None.** `git ls-tree -r upstream/master \| grep agent-memory` is empty at the true tip `c5218f5ec4`, and the string `auto-memory` appears nowhere upstream. Harness auto-memory is a Claude Code feature Paperclip does not model. | **port** | Fully additive server-side (new service + routes + shared types). UI side re-mounts as a tab on upstream's `AgentDetail` page. Already the named Phase-2 survivor in plan §8. |

### Totals

| Verdict | Count | Rows |
| --- | --- | --- |
| **drop** | **17** | 178, 180, 319, 322a, 322b, 331, 335a, 356, 374, 376, 382, 393, 399, 403, 406, 413, 423, 459 |
| **port** | **8** | 294, 296, 335b, 355, 361, 456, `board_only_on_parents`, agent-memory tooling |
| **redesign** | **2** | 336, 426 |

The plan predicted "well over half" of the patch set is redundant. Measured: **17 of 27 verdicts are
drops**, and the drops are concentrated in exactly the files that conflict worst — `heartbeat.ts`,
`recovery/service.ts`, `issue-thread-interactions.ts`, `acpx-engine/execute.ts`. Of the 8 ports, **5 are
purely additive** (294/361 share one module, agent-memory, `board_only_on_parents`) or near-trivial
(296 is 3 CSS lines, 355 is a 4-line guard). The genuinely invasive remainder is **two rows**: 335b
(authz/reviewer seats) and 456 (backup retention).

## 2. What this means for Phase 2

Port in this order — additive first, so nothing waits on a conflict:

1. `agent-memory-files.ts` + memory routes + shared types + Memories tab *(additive)*
2. `managed-goal-block.ts` (COM-294 + COM-361) *(additive module, two hooks)*
3. `board-only-on-parents.ts` + renumbered migration *(additive service, one migration)*
4. COM-296 CSS, COM-355 guard *(3 and 4 lines)*
5. COM-456 retention + settings surface *(modifies an upstream file)*
6. COM-335b reviewer-seat guard + participant authz *(modifies two upstream files)*

Rows 336 and 426 are **not Phase-2 work.** They become Phase-4 smoke-list items; re-implement only if the
symptom reproduces on upstream's base.

## 3. The three rows that were provisional — now resolved, verified by observation

**Updated 2026-11-16 (plan rev 7).** These three rows were left provisional pending an answer about which
fork behaviours the known downstream user actually relies on. **That question will not be asked** (board
decision), so the rows are no longer conditional on anyone's answer. Instead each stays at its triaged
verdict and is **verified by hand in Phase 4** against upstream's own implementation. A failed check flips
the row and this file is amended.

| Candidate | Verdict (final unless Phase 4 says otherwise) | How Phase 4 verifies it instead of asking |
| --- | --- | --- |
| The single-thread chat-style board (COM-374, 382, 356, 296 and the `IssueChatThread` patch set) | **drop** — upstream ships chat-style tasks as the default | Smoke upstream's default chat view for the three behaviours directly: (a) scrolling to the end of a long thread reaches the true last message; (b) recent context stays visible above the New divider, running work below it; (c) an issue's live state (running / waiting-for-review / parked) is legible at a glance. Any failure flips row 13 / 15 / 11 to **port**. COM-296 (CJK fonts) is already a **port** and unaffected. |
| The **Memories tab** | **port** (row 26) | No change — it was never at risk; upstream has no equivalent. |
| The plugin / secret-ref work (COM-430, COM-434) | **drop** — upstream moved AI credentials into Connections (v2026.916.0) | Activate a plugin that requires a secret on the re-based instance. If Connections cannot express the object-form secret-ref contract, the row flips to **redesign**. |

Nothing else in the table ever depended on those answers.

## 4. For anyone running a clone of this fork

Read this part if you have your own checkout or your own running instance.

**Your clone keeps working. Nothing is being deleted or force-pushed.**

- `master` stays exactly where it is, tagged **`legacy/pre-upstream-rebase-2026-11`**, with a permanent
  **`master-legacy`** branch. The new line ships on a *new* branch; only the repo's **default branch**
  flips. Your `git pull` will not fail — you simply stop receiving updates until you choose to move.
- **The database upgrade is one-way.** This fork's schema ends at migration `0184`; upstream is at `486`,
  and *upstream's own `0184` is a different migration*. Moving to the new line applies the whole
  `0184 → 0487+` chain and there is no downgrade path. **Back up your database first, or start a fresh
  one.** We can only rehearse this upgrade against *our* database — if your data matters to you, restore
  a copy and rehearse it yourself before upgrading in place.
- **If you have your own commits or branches** on top of this fork's `master`, they are rooted in the old
  history and have no useful merge-base with the new line. They will need re-authoring on the new base —
  the same thing we have to do with our own open PRs.
- **What you lose by moving:** the features in the `drop` column above — all 17 are replaced by upstream
  equivalents, named per row. **What you keep:** the 8 `port` rows, including the Memories tab and the
  board-only-on-parents model.
- **You get notice, and you get help.** The repo stays **public**, and the default-branch flip is
  announced roughly **two weeks** before it happens — the old line is protected and permanent either way,
  so there is no deadline for you to meet. A step-by-step upgrade walkthrough (back up → verify the backup
  restores → repoint your remote → run the one-way migration → roll back to `master-legacy` if you dislike
  it) lands here before the flip, along with the exact commands we used to rehearse the migration on a
  restored copy, so you can rehearse it on yours. What is *not* promised: support for a third-party
  instance, or holding our own cutover for your schedule.
- **What you gain:** the Paperclip Runner as the default harness, credentials in Connections, Decisions,
  an exact cost ledger, skills synced from GitHub, MCP assistants, a restart-chaos-tested reliability
  layer, and a supported upgrade channel instead of a 4,909-commit gap.

---

*Produced by COM-524 (Phase 1 of COM-521). Every upstream claim above is a `git grep` / `git show`
against `upstream/master` @ `c5218f5ec4` in a read-only checkout — no database, no live server, no
working-tree change. Rows marked provisional in §3 are the only ones not yet final.*

---

## 5. Phase 2 progress — the port branch

**Branch:** `upstream-rebase-2026-11`, branched off `upstream/master` @ `c5218f5ec4`.
Not a patch replay: every hook below was re-anchored on upstream's current module
boundaries. No work was done in the live dev-server checkout, and **no database was
migrated** — the one migration this re-base needs is added as a file, not applied.

### Landed

| Row | Feature | Commit | Re-anchoring that was needed |
| --- | --- | --- | --- |
| 4 | COM-296 CJK fonts + code chips | `7c1dd9ed` | Upstream funnels all mono surfaces through one `--font-paper-mono` token — the fallback goes there once instead of at 7 `--font-mono` sites. Chip weight uses upstream's `--font-weight-normal` token. |
| 10 | COM-355 stale wait-for-review guard | `499db10f` | Clean: reuses upstream's own `WAITING_FOR_REVIEW_OR_APPROVAL_RE`, already in that file. The fork's hunk also carried the goal-block hook; split out to row 3. |
| 26 (server) | Agent-memory service, routes, shared types | `d3671cfb` | Pure addition. Needed `js-yaml` (unused upstream) with the lockfile in the same commit. Dropped the codex-local auth-symlink work the fork had interleaved into the same `routes/agents.ts` hunks — not a survivor. |
| 3 + 12 | COM-294/361 managed goal block | `1fe30517` | Module lands unchanged (zero imports). Upstream moved interaction resolution, so the accept/decline folds were re-anchored on the current `acceptRequestConfirmation`/`rejectRequestConfirmation` transactions. The continuation-summary fold sits after upstream's new `conversationAgentId` early return, so chat-style tasks keep upstream semantics. |
| 25 | `board_only_on_parents` | `6a263efd` | **Migration renumbered `0184` → `0488`** (ours collided with upstream's `0184_routable_blocked`; upstream's highest is 0487), with a matching `_journal.json` entry. Column propagated to all 9 Company-shape sites — including `board-bootstrap.ts`'s `ZodType<Company>`, which fails to compile if it drifts. Two duplicated inline guards became one shared helper. |
| — (post-triage) | #95 gstack skill pack | `1d416572` | Landed on `master` *after* this triage was written, so no row covers it. Purely additive: 46 `SKILL.md` files under `catalog/optional/gstack` plus the generated manifest. Upstream has since split `optional/` into categories but kept the same builder contract, so the pack carries forward unchanged; `generated/catalog.json` regenerated with upstream's `build:manifest` (63 skills = upstream's 17 + 46), and `EXPECTED_OPTIONAL_KEYS` extended while keeping upstream's own two new entries. |
| — (post-triage) | #112 / COM-467 legacy bare-UUID plugin secret refs | `782dccab` | Also post-triage. The bug is present upstream verbatim, so the fix ports unchanged: `assertSecretRefBinding` coerces a bare UUID into a `latest` binding, `normalizeLegacySecretRefsInConfig()` added, the config-save route persists the upgrade. **Migration `0185` → `0489`** (+ journal entry), file added, not applied. One deliberate difference: upstream's validator now substitutes a binding with its secret id before validating (`secretRefsAsIds`), so the object form validates against a `type: "string"` field — the fork's "keep the legacy shape for string-typed fields" case no longer applies, and the ported test asserts the upgrade persists there too. |
| 23 + 8b | COM-456 backup retention + COM-335b reviewer-seat guard | `3888264e` | **COM-456:** `BackupRetentionPolicy` gains `hourlyHours`/`maxTotalCount`/`maxTotalGb` in `@paperclipai/shared`; `backup-lib.ts` replaces keep-all-daily with `planBackupPruning` (pure, unit-tested) + `readBackupEntries` + updated `pruneOldBackups` that logs each deletion. `InstanceGeneralSettings.tsx` adds hourly window, file count, and size cap pickers. **COM-335b:** `violatesSelfReviewSeatCollapse` added to `issues.ts`; seat-collapse rejected on top-level create, child create, and PATCH. `activeExecutionParticipantAgentId` carve-out wired into `assertAgentIssueMutationAllowed`. (Authorization.ts carve-out omitted — upstream's `decideVisibleIssueWrite` already allows review-participant writes in the PATCH path.) |

### Verified so far

- `typecheck` clean for `shared`, `server`, `cli`, `ui` (all 8 port rows).
- `check:tokens` and `check:module-boundaries` pass. (`check:tokens` is **red** on the
  fork's `master` — a side benefit of the re-base.)
- `packages/db` migration **numbering** and **safety** checks pass; `0488` raises no
  compatibility finding. The 69 compat errors that gate reports are all pre-existing
  upstream migrations, none touched here.
- Targeted suites green: agent-memory service + routes, managed-goal-block,
  board-only-on-parents, company-portability, companies-service,
  issue-thread-interactions(+resolution), issue-continuation-summary, the issue
  create-path route suites, and backup-lib (including the new `planBackupPruning` unit
  tests) — **531+ tests**, 0 failures. Upstream's own interaction and create-path tests
  pass unmodified against the new hooks.
- **The full CI suite has not been run yet.** That is the remaining gate on this branch.

### Resolving the merge back into `master` (PR #113)

PR #113 targets the fork's `master`, which diverged 4,909 commits ago, so GitHub
reported it `CONFLICTING`: **108 conflicting files**. Every one of them sits in code
this triage marked **drop** — the merge conflict *is* the re-base, re-stated.

Resolution: a `-s ours` merge commit (`aaded00d`) on the port branch. The branch tree
is kept byte-for-byte; fork `master` is recorded as a second parent, so no history is
lost, `master` is never force-pushed, and the legacy tag commitment holds. Resolving
the 108 files by hand would have meant re-litigating 17 already-decided `drop` rows
one hunk at a time, with each resolution being "take the port side" anyway.

The one real risk in `-s ours` is silently discarding `master` work the triage never
saw. That was checked explicitly rather than assumed: of the 317 files `master` changed
since the merge base, the ones absent from the port branch are all `drop`-row features
plus exactly two post-triage commits — #95 and #112 — which are carried forward as
their own commits above rather than dropped.

### Not yet landed (explicitly deferred, not dropped)

| Row | Feature | Why it is still open |
| --- | --- | --- |
| 26 (UI) | The Memories tab | Server side is landed and tested; the tab needs re-mounting on upstream's rewritten `AgentDetail` page. |

Rows **336** and **426** remain Phase-4 smoke-list items, per §2 — not Phase-2 work.

### On the §3 rows

Nothing in Phase 2 was conditional on the downstream user. The board withdrew the §4.2
questions ("proceed on my assumptions", 2026-11-16) and plan rev 7 resolved §3's three
rows as `drop`, moving the check to the Phase-4 hand-verification gate — per rev 7's own
rule that no verdict may depend on an answer we decided not to obtain. The one row he
would have been asked about that is already a `port` — the Memories tab — was never at
risk.
