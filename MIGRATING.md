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
| Migration collision | **two** collisions, both resolved in Phase 3 (§6.1): ours ended at `0184_board_only_on_parents.sql` + `0185_plugin_secret_ref_object_form.sql`, while **upstream's own 0184/0185 are `0184_routable_blocked.sql` / `0185_status_cards.sql`**. Renumbered to `0488` / `0489` on an upstream chain ending at `0487`. |

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

- `master` stays exactly where it is, with a permanent **`master-legacy`** branch and the immutable tag
  **`legacy/old-master-final-2026-11`**. The new line ships on a *new* branch; only the repo's
  **default branch** flips. Your `git pull` will not fail — you simply stop receiving updates until you
  choose to move. (**Correction:** earlier revisions of this bullet named
  `legacy/pre-upstream-rebase-2026-11` as the ref to stay on. That tag is the Phase 0 *freeze point* and
  sits 2 commits behind the real legacy tip — see §7 for the full ref map.)
- **The database upgrade is one-way.** This fork's schema ends at migration `0185`; upstream ends at
  `0487`, and *upstream's own `0184` and `0185` are different migrations than ours* — both of our
  fork-local slots collide, and both were renumbered to the end of upstream's chain (`0488`, `0489`).
  Moving to the new line applies **305 migrations** and there is no downgrade path. **Back up your
  database first, or start a fresh one.** We can only rehearse this upgrade against *our* database — if
  your data matters to you, restore a copy and rehearse it yourself before upgrading in place. §6 records
  our rehearsal and gives you the exact commands to repeat it on yours.
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
- **New system requirement: Rust 1.97.1.** The Paperclip Runner (`packages/paperclip-runner`) is now
  the default harness on `darwin-arm64` and `linux-aarch64`. Its native binary is built from source at
  startup via `cargo build --release` against the pinned toolchain in
  `packages/paperclip-runner/rust-toolchain.toml`. **No prebuilt binary ships in the repository.**
  If `cargo` is not on your `PATH`, `pnpm dev` fails immediately with `sh: cargo: command not found`.
  Install Rust via [rustup](https://rustup.rs/), then run `rustup override set 1.97.1` in the repo root
  (or let `rust-toolchain.toml` pick it up automatically). First build takes ~2–3 minutes. This is a
  one-time cost; subsequent starts reuse the compiled binary. The legacy line never required Rust.

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
| 26 (server) | Agent-memory service, routes, shared types | `d3671cfb` | Pure addition. Originally added `js-yaml` + a lockfile change; that was wrong and is reverted — upstream's dependency-free frontmatter parser handles top-level lists, now exposed as `parseYamlDocument`. Dropped the codex-local auth-symlink work the fork had interleaved into the same `routes/agents.ts` hunks — not a survivor. |
| 26 (UI) | Memories tab | `77bd8d80` | Upstream rewrote `AgentDetail.tsx` and moved tab bodies into their own files, so the fork's ~350 inline lines became `ui/src/pages/agent-detail/AgentMemoriesTab.tsx` instead of being replayed in place. Upstream also replaced the flat tab strip with a sectioned `AGENT_DETAIL_NAVIGATION` plus path-segment routes, so the view is registered there (`memories`, in the "Agent" section) with a `memory` → `memories` URL alias. Upstream's exhaustive `Record<AgentLocalDetailView, …>` maps caught two sibling sites the fork had no equivalent of — the contextual-sidebar icon map and the storybook description map — both updated. The one upstream test edited is `agent-detail-navigation.test.ts`'s "complete information architecture" assertion, which enumerates the tab set by design; no behaviour was changed to suit a test. |
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
- Memories-tab render coverage: 7 tests in `ui/src/pages/agent-detail/AgentMemoriesTab.test.tsx`
  (harness-vs-para empty-state wording, the project-memory-only case, read-only project
  selections, and the yaml parse-error path). The fork had none — the tab was inline.
- **The full CI suite has now been run.** See "CI: what the full suite says" below for the
  measured baseline and the per-suite attribution; CI green at the branch tip is the one
  remaining gate.

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

### The base-relative gates that cannot go green on this PR

`ci / policy` and `review` are **base-relative** gates, and that is why they stay red
here. Both diff the branch against the fork's `master`:

* `policy` runs `git diff --name-only "$trusted_base...$HEAD_SHA"` and rejects any PR
  whose changed-file set includes `pnpm-lock.yaml` ("CI owns lockfile updates"). A
  branch rooted on upstream `master` *necessarily* carries upstream's lockfile, which
  differs from the fork's by ~13,800 lines of accumulated dependency drift.
* `review` (dependency review) reads the same comparison and reports upstream's own
  additions — e.g. `+ thiserror@2.0.20` — plus their advisories.

Neither is satisfiable by cleaning up the branch: the re-base *is* a wholesale
lockfile replacement. Landing therefore still needs a fast-forward of `master`
(`merge --ff-only`) or an admin-override merge.

A **third** gate has the same root cause, and it only shows up locally because the
fork's CI never reaches it: upstream's migration-compatibility gate
(`packages/db` `check:migrations`) baselines on `origin/master`, so against *fork*
master it flags **70 upstream migrations** as unclassifiable. It also runs inside
`pnpm db:migrate`, which is why Phase 3 has to follow landing rather than precede it —
once `origin/master` *is* the upstream-rooted tree, the gate starts working for us
instead of against us. The same is true of `policy` and `review`. All three assume the
branch is a small delta on fork master; a re-base replaces the base, which is the one
thing they cannot express. That asymmetry is the argument for `--ff-only` over an admin
override: a fast-forward leaves all three gates answerable afterwards, an override
leaves them permanently reporting on a tree they never evaluated.

**`ci / e2e` is a real suite, not a cascade.** An earlier revision of this section said
it "only asserts that `policy` passed". That was wrong: shard 2/8 runs
`ai-personal-connection-recovery.spec.ts`, and its failure is a genuine assertion
("Answered the pending follow-up once." never appears). Attribution is pending — see
the baseline experiment below.

### Why PR #113 has CI at all: the `-s ours` merge is load-bearing

The fork's `pr.yml` is `pull_request`-triggered, and GitHub runs those workflows only
once `refs/pull/N/merge` can be built. A branch rooted on upstream `master` cannot
merge into fork `master`, so **no** `pull_request` workflow fires — only `review`,
which is `pull_request_target` and needs no merge ref.

PR #113 therefore has CI *solely* because it carries the `-s ours` merge of fork
`master`, which was recorded above as conflict housekeeping. Without that merge a
re-base branch in this repo is un-testable through a PR at all. This was discovered the
hard way while standing up the baseline below: opening it as a draft produced only
`review` (the fork's trigger list has no `ready_for_review`), an empty commit for
`synchronize` produced only `review`, and only the `-s ours` merge unlocked the suite.

### The attribution baseline — PR #114

Three reds have been *asserted* here to be upstream's rather than ours. Asserting is not
evidence, so PR #114 carries upstream `master` @ `c5218f5ec4` **verbatim** — zero commits
of ours, tree verified byte-identical (`git diff --stat upstream/master..HEAD` empty),
plus the same `-s ours` merge so the two PRs are comparable. Marked DO NOT MERGE.

Any check red on #114 is red for an upstream-rooted tree in this fork's CI and is not
attributable to the ports. Any check red on #113 but green on #114 is ours.

Supporting evidence for the `static checks` row while that runs: upstream's most recent
commit touching `stage-runner-binary.test.mjs` is **#21787**, *"remove coreutils and
pid-file timing assumptions from static checks"* — they were actively fixing environment
sensitivity in that exact file.

One real defect did hide behind this, though, and it is now fixed: the agent-memory
port (row 26) had added `js-yaml`, which was the only reason the branch's own diff
*against upstream* touched the lockfile. That tripped the `Runner support suite`
(stale SDK input registry + report-lock) independently of the base-relative gates.
`pnpm-lock.yaml` and `server/package.json` are now byte-identical to upstream.

### The six defects the ports introduced

All six are the same failure: a port widened a shared contract without propagating
to the sites that already depended on it. Four were fixed in `4fa35076`; two more
were found afterwards.

| Red checks | Cause |
| --- | --- |
| `Typecheck` test-tree-1/-2 | Row 25 widened `BackupRetentionPolicy` and `RunDatabaseBackupResult`, breaking upstream's own backup fixtures. `createDatabaseBackupOwner` now takes a `BackupRetentionPolicyInput` and resolves it via `normalizeBackupRetention`. |
| `Typecheck` paperclipai | `boardOnlyOnParents` became required on `Company` + the portability manifest; the CLI's three fixtures were not updated. |
| **10 checks** — 4 `General tests (server)` shards, 6 `Verify serialized server suites` | Row 26 built `projectService(db)` at `agentRoutes` construction time, so all 11 upstream test files that mock `../services/index.js` failed. Now constructed per call. |
| `Runner support suite` | The `js-yaml` dependency above, plus a stale `source-sdk-public-inputs.json` (13 pinned inputs changed by the ports). Registry re-pinned. |

Two more of the same shape, found after `4fa35076`:

| Fix | Cause |
| --- | --- |
| `b0e3948ff2` | The row-25 fix above was itself wrong. `createDatabaseBackupOwner` normalized retention *before* calling `runDatabaseBackup`, which is redundant — `planBackupPruning` normalizes its own input and `RunDatabaseBackupOptions.retention` is typed `BackupRetentionPolicyInput` — and it changed the observable call, breaking two upstream fixtures that assert the *configured* subset reaches the backup. Worse, `4fa35076` had "fixed" one of them by editing the upstream test to match the new behaviour, which is exactly the kind of quiet contract drift this re-base exists to avoid. Reverted; the owner now passes the caller's value straight down and keeps the resolved policy only for the response and log line. All four `server-startup-feedback-export` failures shared one root cause: the assertion threw *inside* the fake `runDatabaseBackup`, so the backup looked like it had failed and left the idle wake marker behind. |
| `6c9967837c` | The ported COM-467 backfill (`0489`) is a whole-table `UPDATE`, which upstream's migration-compat classifier reads as a lock hazard, so `packages/db typecheck` refused the branch. Now declared `online_compatible` with reasoning. Verified: `--check --base upstream/master` → 2 new migrations, none unclassified. |

Verified locally after both: `database-backup-owner` + `server-startup-feedback-export`
**143/143**; the four interaction suites that cover the COM-294 fold
(`issue-thread-interactions-service`, `issue-thread-interaction-routes`,
`agent-interaction-acceptance`, `chat-interaction-publications`) **307/307**; and
`tsc --noEmit` clean in **all five** packages — `server`, `ui`, `cli`,
`packages/shared`, `packages/db`. That last sweep is the systematic version of the
P14 check: every type-level dependent of a widened contract is now propagated.

`stage-runner-binary.test.mjs` (2 tests, under `Verify Paperclip Runner (static
checks)`) is believed **not** ours — it is an upstream file and this branch changes
nothing in `packages/paperclip-runner` — but that is now being measured rather than
asserted, via PR #114 above.

#### `ci / e2e shard (2/8)` — measured, and the first hypothesis was wrong

The red is `tests/e2e/ai-personal-connection-recovery.spec.ts:55`: after *Use connection
and continue*, the agent's reply never arrives.

An earlier revision of this section guessed the cause: the COM-294 port adds a
best-effort goal-block fold **inside** the accept transaction, and a `try/catch` cannot
deliver on "best-effort" in Postgres, so a failed fold would take the acceptance down
with it. The job log falsifies that for this red on two counts. First, the adopt call
returned `200` and the continuation run *was* created — so nothing took the acceptance
down. Second, `connection_intent` resolution does not go through `accept()` at all: the
route calls `intents.complete()` → `resolveConnectionIntent`, which never reaches the
fold. What actually happened:

```
20:10:44 WARN  swept stale issue lock columns {"cleared":1,"issueIds":["15b1ba20…"]}
20:10:46 INFO  POST …/connection-intents/…/adopt 200
20:10:46 INFO  claimQueuedRun: withheld queued run at the execution gate
                {"runId":"d7c25848…","outcome":"cancelled","errorCode":"issue_not_in_progress"}
```

The recovery sweeper (`server/src/services/recovery/service.ts`) fired in the two-second
window between the spec's deliberately-failed first run and the adopt, clearing the chat
issue's lock columns; the resumed run then lost the `in_progress` precondition at
`claimQueuedRun`'s execution gate (`server/src/services/heartbeat/queue.ts:1379`). Both
files are untouched by this branch — `git diff --name-only upstream/master...HEAD --
server/src/services/heartbeat server/src/services/recovery` is empty — and the delta
contains no issue-status, lock, or gate write anywhere outside test files.

Timing corroborates: same spec, same shard position on both PRs; control #114 passed it
in 18.0s with the sweeper message appearing **zero** times in its shard-2 log, while
#113 failed at 23.9s with the sweeper firing **once**, in exactly the wrong window. The
spec also passes at the port tip locally — 3/3 under `--repeat-each 3`, throwaway
instance on port 3199. Verdict: an upstream-owned timing race the slow runner exposed,
not a port defect.

(Shard *membership* also differs between the two PRs — #114's shard 2 additionally ran
`completed-task-paused-assignee.spec.ts`. That is expected: the e2e lane selects by
changed-file profile and the two PRs have very different change sets. `tests/` is
byte-identical between `upstream/master` and this branch, so no spec was dropped.)

The transaction-poisoning concern was wrong about *this* red but right about the code:
as written, a failing fold statement would still poison whichever accept/decline
transaction does reach it. That is now fixed at the source — the fold runs inside a
`SAVEPOINT` (Drizzle's nested `transaction()`), so it keeps its atomicity on success and
on failure rolls back only itself. Moving it past the commit boundary would also work
but would reintroduce exactly the gap the port closes: a lost fold means a stale
standing decision overrides a fresh board approval on resume.

### Not yet landed (explicitly deferred, not dropped)

Nothing. Row 26's UI half — the Memories tab — landed on upstream's rewritten
`AgentDetail` IA (`c71b4e4551`) with its own test file (`8711dbc44b`), so all eight
Phase-1 `port` rows plus the two post-triage carry-forwards (#95, #112) are on the
branch.

Rows **336** and **426** remain Phase-4 smoke-list items, per §2 — not Phase-2 work.

### On the §3 rows

Nothing in Phase 2 was conditional on the downstream user. The board withdrew the §4.2
questions ("proceed on my assumptions", 2026-11-16) and plan rev 7 resolved §3's three
rows as `drop`, moving the check to the Phase-4 hand-verification gate — per rev 7's own
rule that no verdict may depend on an answer we decided not to obtain. The one row he
would have been asked about that is already a `port` — the Memories tab — was never at
risk.

---

## 6. Phase 3 — the migration renumber, and the upgrade rehearsed on a restored copy

Phase 3 of COM-521 (COM-526). This is the irreversible step, so it was rehearsed only against a
**restored copy** of the pinned Phase 0 snapshot. The live database was never migrated.

### 6.1 Both fork-local slots collided, and both were renumbered

The plan anticipated one collision on `0184`. There were **two** — the Phase 0 runbook flagged the
second one, and both are now resolved:

| Fork-local migration | Old slot | Collided with upstream's | New slot |
|---|---|---|---|
| `board_only_on_parents` | `0184` | `0184_routable_blocked` | **`0488`** |
| `plugin_secret_ref_object_form` | `0185` | `0185_status_cards` | **`0489`** |

Journal rebuilt and verified: 488 entries, no duplicate tags, no file-vs-journal mismatch in either
direction, and all **182** migrations shared with the legacy line are **byte-identical** to it.
`pnpm --filter @paperclipai/db check:migrations` (numbering + safety + compatibility) passes.

The journal's duplicate `idx 178` and missing `idx 126, 130, 177` are **inherited from
`upstream/master` unchanged** — they are not artefacts of our renumber, and were deliberately left
alone rather than "tidied", so the chain stays diffable against upstream.

### 6.2 The applied-migration ledger needed no surgery — but only because of how this fork migrates

Worth writing down, because the obvious reading is wrong and dangerous.

Under **stock drizzle**, the applied set is derived from `MAX(created_at)` in
`drizzle.__drizzle_migrations`. Our pre-upgrade ledger's max `created_at` is `1787270400000`, which is
*newer* than the journal `when` of upstream migrations `0184`–`0226`. On that reading, **43 upstream
migrations would have been silently skipped** — a corrupt schema that reports success.

This fork does not use the stock migrator. `packages/db/src/client.ts` resolves the applied set by
**SHA-256 of each migration's SQL** (`listAppliedMigrations` → `mapHashesToMigrationFiles`), and only
falls back to `created_at` if *no* hash resolves at all. The apply loop then re-checks each file by
hash and skips it if already recorded. Because all 182 shared migrations are byte-identical, hash
resolution is complete and the `created_at` path never executes.

The rehearsal confirms this rather than assuming it: the migrator reported exactly **305 pending**,
which is the hash-based count. The `created_at` path would have reported 263.

Two ledger rows (`id=112`, `id=185`) hash to no migration SQL in any ref — residue of files edited
after being applied. Under hash-keyed resolution they are simply ignored, which is why the ledger
reconciles with no manual intervention. Both runs confirm it.

> **If you are on a clone and your migration files differ from ours byte-for-byte** — local patches,
> hand-edited SQL, a partially-applied chain — hash resolution degrades and the `created_at` fallback
> can engage, which is where the silent-skip hazard lives. Verify after upgrading that
> `select count(*) from drizzle.__drizzle_migrations` is **490**, and re-run the migrator: it must say
> `No pending migrations`.

### 6.3 Rehearsal result — clean, twice, from a fresh restore each time

Both runs restored `com521-prerebase-paperclip-20261116-092022.sql.gz` (sha256 `d37c12a9…`, verified
each time) into a scratch database, applied the 39 CHECK constraints the backup tool omits, then
migrated. **Run 2's assertions are identical to run 1's in every field.**

- **305 migrations applied, 0 errors, ~39 s.** Ledger **185 → 490**.
- **Re-running the migrator reports `No pending migrations`** — the upgrade is stable, not
  re-entrant-dirty.

| Assertion | Before | After |
|---|---|---|
| Base tables (`public`) | 158 | 330 |
| Indexes (`public`) | 723 | 1374 |
| Foreign keys | 520 | 992 |
| CHECK constraints | 41 | 171 |
| Primary keys / unique / not-null | 221 / 52 / 1358 | 391 / 71 / 2880 |
| Migrations applied | 185 | 490 |
| Extensions | `fuzzystrmatch, pg_trgm, plpgsql` | unchanged |
| **Total rows across all tables** | **13,406,834** | **13,407,289** |
| Companies / agents / issues | 9 / 65 / 3082 | 9 / 65 / 3082 |
| `companies.board_only_on_parents` | present | **present** |

**No table lost a single row.** The two tables dropped by the chain
(`cloud_upstream_connections`, `cloud_upstream_runs`) were **both empty**. The `+455` row delta is
fully accounted for: backfills into three existing tables (`issue_attachments` +113,
`principal_permission_grants` +40, `activity_log` +31) and four newly-seeded tables
(`resource_lifecycle_events` 254, `company_skill_source_entries` 8, `user_company_preferences` 7,
`company_skill_sources` 2).

That `board_only_on_parents` survives is the assertion that matters for the renumber: it proves
moving our migration to `0488` carried the fork-local schema change forward instead of losing it.

### 6.4 The upgraded schema vs a greenfield install

The upgraded copy was compared object-by-object (columns + types + nullability, indexes, constraints)
against a **fresh empty database migrated through the same chain** (488 migrations from zero):

- **Zero objects missing from the upgraded database.** Every column, index and constraint a greenfield
  install creates is present. The upgraded schema is a strict superset.
- It carries **two extra tables** — `agent_fallback_chains` and `agent_fallback_chain_state` — which
  are legacy fork tables upstream never had, so nothing in its chain drops them. **Both are empty
  before and after**, and no migration or schema source on the new line references them. They are
  inert residue of a dropped fork feature, not a schema conflict. Left in place: dropping tables is
  not something to do as a side-effect of an upgrade rehearsal.

### 6.5 Reproduce it on your own data

This is the walkthrough §4 promised. Substitute your own dump. **Never point this at your live
database** — restore to a scratch database and migrate that.

```bash
export PGPASSWORD=...                     # your DB password
PSQL=/opt/homebrew/bin/psql               # your psql
HOST=127.0.0.1; PORT=54329; USER=paperclip
DB=upgrade_rehearsal                      # scratch target, NOT your live DB
DUMP=/path/to/your-backup.sql.gz

# 1. fresh scratch target
$PSQL -h $HOST -p $PORT -U $USER -d postgres \
  -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;"

# 2. restore schema + data
gunzip -c "$DUMP" | $PSQL -h $HOST -p $PORT -U $USER -d $DB -v ON_ERROR_STOP=1 -q

# 3. if your dump came from `paperclipai db:backup`, re-add the CHECK constraints
#    it omits (see Phase 0 runbook) — otherwise the copy accepts rows the real schema forbids.

# 4. record BEFORE assertions — at minimum per-table row counts and the ledger
$PSQL -h $HOST -p $PORT -U $USER -d $DB -At \
  -c "select count(*) from drizzle.__drizzle_migrations"

# 5. migrate the COPY
cd /path/to/your/checkout            # on the new upstream-based line
DATABASE_URL="postgres://$USER:$PGPASSWORD@$HOST:$PORT/$DB" \
  pnpm --filter @paperclipai/db migrate

# 6. AFTER: ledger must read 490, and a second run must say "No pending migrations"
DATABASE_URL="postgres://$USER:$PGPASSWORD@$HOST:$PORT/$DB" \
  pnpm --filter @paperclipai/db migrate
```

Compare row counts before and after. Expect growth only from the backfills listed in §6.3 and no
table to lose rows. If any pre-existing table shrinks, stop and do not upgrade in place.

**The upgrade remains one-way.** There is no downgrade migration. Rolling back means restoring your
backup *and* moving your checkout back to `master-legacy` — the pair, not one or the other (see the
Phase 0 runbook on rollback pairs). We can only rehearse against our own data; §4's residual risk
stands, which is precisely why this walkthrough exists.

---

## 7. Which ref should I be on?

There are several permanent refs, and **two of them differ by two commits** — enough to matter if you
pick the wrong one. Every hash below was resolved against `origin` on 2026-11-19.

| Ref | Commit | Line | Use it for |
| --- | --- | --- | --- |
| `master` | `33fa9a2c` | legacy | **Staying put.** The current default branch content: the legacy tip plus three documentation files. This is what you already have if you pulled before the flip. |
| `master-legacy` | `5fd63cb6` | legacy | **The permanent legacy branch.** Identical code to `master`, without the three docs commits. Rollback target for the pair in §6.5. |
| `legacy/old-master-final-2026-11` | `5fd63cb6` | legacy | Immutable tag for the same commit as `master-legacy`. Prefer this if you want a ref that can never move. |
| `legacy/pre-upstream-rebase-2026-11` | `2744b2a7` | legacy | **Historical marker only — not an install target.** This is the Phase 0 freeze point, taken *before* two further legacy commits landed. It is **2 commits behind** the real legacy tip. Earlier revisions of §4 named this tag as the place to stay; use `master-legacy` or `legacy/old-master-final-2026-11` instead. |
| `upstream-rebase-2026-11` | `caf3c55d` | **new** | **The re-based line.** This is the branch the default-branch flip points at, and the only ref you should upgrade onto. |
| `rebase/phase2-merged-2026-11` | `e95ef3a1` | new | **Historical marker only — not an install target.** Marks the Phase 2 merge, now **5 commits behind** `upstream-rebase-2026-11`, and it predates the Phase 3 migration renumber (§6.1). A checkout at this tag will try to apply migrations in the colliding `0184`/`0185` slots. Do not install from it. |
| `rebase/phase2-prhead-2026-11` | `d1018d99` | new | Historical marker only — the Phase 2 pull-request head. Same caveat as above. |

**Short version:** stay on `master-legacy`, or move to `upstream-rebase-2026-11`. The four `legacy/…`
and `rebase/…` tags exist so our own audit trail is reproducible; none of them is a supported
starting point except `legacy/old-master-final-2026-11`.

None of these refs will ever be deleted or force-pushed. The two `rebase/…` tags are deliberately
**not** being moved forward — a tag that moves is worse than a tag that is honestly labelled stale.

---

## 8. How this fork tracks upstream from now on

The 4,909-commit gap happened because this fork tracked upstream by *occasional manual merge* with no
trigger and no cadence. That is the thing being fixed, not just the gap it produced.

**From the cutover forward, this fork follows upstream's `stable` channel.** Upstream ships on four
channels — `stable`, `beta`, `nightly`, `canary` (see [doc/CHANNELS.md](doc/CHANNELS.md)). `stable`
moves every week or two, and only after a release has soaked as a `beta` for at least three days.

One thing to be precise about: upstream's channels are documented as **npm dist-tags and Docker image
tags**, for people who *install* Paperclip. This fork is a **git clone**, so it cannot "install from a
dist-tag." Following `stable` here means something concrete and different:

- **Sync against upstream's stable release tags, never against `upstream/master`.** Upstream's stable
  releases carry calver tags (`YYYY.MDD.P`). Those are the only commits that have been vetted and
  promoted; `upstream/master` is the `canary` channel by definition, and merging it is how a fork
  acquires other people's un-soaked regressions.
- **Cadence: one sync per upstream stable release, or monthly, whichever comes first.** A one-release
  gap is a readable diff. A twelve-release gap required a 5-phase project, a revert, and a downstream
  outage.
- **Verify the tag resolves to what you think it does.** This is not hypothetical: the local
  `v2026.1106.0` tag in this repository resolves to `d69631b01b`, dated **2026-10-22**, three weeks
  and 2,597 commits behind the November tip. An earlier revision of the COM-521 plan measured the
  upstream gap against that tag and was wrong because of it (see the correction note at the top of
  this document). Always `git show --no-patch --format='%H %ci' <tag>` before you measure anything
  against it.
