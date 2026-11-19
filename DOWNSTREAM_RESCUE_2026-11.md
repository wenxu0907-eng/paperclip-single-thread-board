# Rescue runbook — Paperclip instance broken after pulling `master` (2026-11-17/18)

**Who this is for:** anyone whose Paperclip instance stopped working after running `git pull` on a
clone of `paperclipai/paperclip` (our fork) on or after **2026-11-17 22:48 UTC**.

**What happened, in one line:** our fork's default branch `master` was moved onto a new,
upstream-based code line that adds **4,937 commits, 15,280 files and 312 database migrations**. A
`git pull` fast-forwards onto it silently, and starting the dev server after that pull **applies all
312 migrations automatically with no prompt**. That is a one-way change. This was our sequencing
mistake, not anything you did wrong.

**Written before diagnosis, deliberately.** We do not yet know which failure you hit. Step 1 is
safe and time-critical regardless of cause — **do it before anything else**, including before
trying any fix you may have already found on your own.

> **Scope note (added when this file was carried forward onto the re-based line).** This runbook
> describes the **2026-11-17 incident** specifically: the line that briefly sat on `master` as PR #113,
> whose ledger ends at **497**. It is kept here, unchanged in substance, so that the recovery path
> survives the default-branch flip instead of disappearing from the default branch along with the old
> `master` README.
>
> If you are reading this because you are doing a **planned, deliberate** upgrade onto the current
> re-based line, this is **not** your document — use [`MIGRATING.md`](./MIGRATING.md) §4 and §6.5
> instead. The current line's ledger ends at **490**, not 497, because the two colliding fork-local
> migration slots were renumbered in Phase 3 (MIGRATING.md §6.1). Step 2B's "~497" check below is
> still the right test for *incident* recovery; do not apply it to a planned upgrade.

---

## ⚠️ Step 1 — Stop the server and take a cold copy of the database directory. Do this first.

Right now you have **no pre-upgrade backup**, which means every repair option below is one-way.
This step manufactures the backup you don't have. It takes about a minute.

```bash
# 1. Stop the dev server completely. Ctrl-C is often not enough — confirm nothing is left:
pkill -f 'dev-runner|paperclipai/server' || true
sleep 3
pgrep -fl 'dev-runner|paperclipai/server'        # expect NO output

# 2. Confirm Postgres is stopped too. The embedded data directory is:
#      ~/.paperclip/instances/<instance>/db          (<instance> is usually "default")
ls ~/.paperclip/instances/default/db/PG_VERSION    # should exist
pgrep -fl postgres                                  # if this prints anything, see note below

# 3. Cold-copy the whole directory. Do NOT skip this.
cp -a ~/.paperclip/instances/default/db \
      ~/paperclip-db-snapshot-$(date +%Y%m%d-%H%M)
du -sh ~/paperclip-db-snapshot-*
```

Notes:
- **It must be a cold copy.** Copying the data directory while Postgres is running produces a
  corrupt, unusable snapshot. If `pgrep postgres` still shows a process after step 1, stop it and
  re-check before copying — do not copy "anyway".
- **Use `cp -a`, not the app's own backup command.** Do not rely on `pnpm db:backup` for this:
  on our line that script has a known defect (tracked as COM-529) — it **drops all 39 CHECK
  constraints** from the dump and restoring it is a two-step process. It is not a safe rescue
  snapshot. A filesystem copy of a stopped data directory is.
- Keep this snapshot until your instance is working again and you're happy with it.

Once step 1 is done, nothing below can lose data permanently. Take your time from here.

---

## Step 2 — Tell us which of two very different situations you're in

The single most important unknown: **did the migrations actually run?** If they did not, your
recovery is easy and complete. If they did, your options narrow. Please run this and send us the
output.

```bash
cd <your paperclip checkout>

# A. Which code line are you on?
git log --oneline -1
git rev-parse HEAD

# B. Did the database get migrated? Count applied migrations:
#    (adjust port if yours differs; 54329 is the usual embedded port)
psql "postgresql://paperclip:paperclip@127.0.0.1:54329/paperclip" \
  -c "select count(*) from __drizzle_migrations;" \
  -c "select * from __drizzle_migrations order by id desc limit 3;"

# C. What did it fail with? Last 200 lines of the server log:
tail -200 ~/.paperclip/instances/default/logs/dev-runner.out

# D. Your Node version — this matters, see Step 3:
node --version
```

Read the result of **(B)** like this:

| Applied migration count | What it means | Go to |
| --- | --- | --- |
| **~185** | Migrations never ran. Your database is **untouched**. | **Step 4 — clean rollback** |
| **~497** | Migrations ran. Your database is on the new schema. | **Step 5 — forward repair** |
| Something in between, or the query errors | Partial / interrupted migration. **Stop and send us the output** before running anything else. | — |

If step (B) can't connect at all, that's expected when the server won't boot — the embedded
Postgres is started by the server. Try step 3 first, then come back.

---

## Step 3 — The two most likely reasons it won't boot (both are independent of the database)

These are the causes we can predict from the diff. Both are quick to check and both are fixable
whichever direction you end up going.

### 3a. Your `node_modules` is stale — most likely cause

The new line rewrote `pnpm-lock.yaml` (**13,816 lines changed**), added **8 new workspace
packages** (37 → 45), and bumped a patched dependency (`acpx` 0.12.0 → 0.22.0). Your installed
`node_modules` is from the old line, so the server fails to start with `ERR_MODULE_NOT_FOUND`,
`Cannot find package`, or `Command "tsx" not found`.

```bash
grep -iE 'ERR_MODULE_NOT_FOUND|Cannot find (package|module)|tsx.*not found' \
  ~/.paperclip/instances/default/logs/dev-runner.out | tail -5
```

Fix — **but read the warning first**:

```bash
pnpm install
```

> **Warning:** running `pnpm install` is only safe here because **your server is already stopped**
> (Step 1). Never run it against a *running* Paperclip dev checkout — it prunes `server/node_modules`
> out from under the live process and the server cannot recover on its own.

### 3b. Node is too old — `engines.node` went `>=20` → `>=24.11.0`

The new line requires **Node 24.11.0 or newer**. The old line required only Node 20. This is not
enforced at install time (there's no `engine-strict`), so `pnpm install` will *warn* rather than
refuse — and then the server fails later with syntax or API errors that look unrelated.

If `node --version` from Step 2 is below `v24.11.0`, you have two choices, and they point in
opposite directions:

- **Going forward** (Step 5) → you must upgrade Node to 24.11+ first.
- **Rolling back** (Step 4) → leave Node where it is; the old line is happy on Node 20.

---

## Step 4 — Clean rollback (only if Step 2B showed ~185 migrations)

This is the good case: your database was never migrated, so returning the code returns the whole
instance.

**Use the tag below.** When this runbook was first written, the `master-legacy` branch pointed at
`2744b2a7` — **two commits behind** the real pre-flip tip, missing PR #95 (gstack skills) and
**PR #112, the fix that accepts legacy plugin secret references instead of freezing your config**.
Rolling back to it would have handed you a different bug.

**Fixed 2026-11-18:** `master-legacy` has since been fast-forwarded to `5fd63cb6`, so the branch and
the tag now agree. It was a fast-forward, never a force-push, so an existing clone just needs
`git fetch`. The tag remains the target we recommend, because a tag cannot move under you:

```bash
cd <your paperclip checkout>
git fetch origin --tags

# The true pre-flip tip of the old line: 5fd63cb6
git checkout -B my-line legacy/old-master-final-2026-11
git log --oneline -1          # expect 5fd63cb6 "Add gstack skill pack ... (#95)"

pnpm install                  # server must still be stopped
pnpm dev
```

Then confirm it's actually up:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/     # expect 200
```

**If you had your own commits on top of `master`**, they are not lost — they're still in your
reflog and on any branch you made. Find them with `git reflog` / `git branch --contains`, and
cherry-pick them onto `my-line`. Ask us if that's awkward; we have to do the same thing for our own
open PRs.

**To stay safe from this recurring:** your clone now tracks a branch that moves under you. Pin
yourself to the old line rather than the default branch:

```bash
git branch --set-upstream-to=origin/master-legacy my-line   # or simply don't `git pull` master
```

We have committed to never force-pushing or deleting the old line, so this stays valid.

---

## Step 5 — Forward repair (if Step 2B showed ~497 migrations)

Read this part carefully, because the honest answer is uncomfortable.

### Why you cannot simply "revert the code"

Your database is now on schema 497. The old code expects schema 185. **Reverting the code alone
leaves you broken in a new way** — the application and the schema disagree. A rollback from this
state needs the *pair*: old code **and** a pre-upgrade database. You don't have the second half,
which is why Step 1 mattered and why forward repair is the recommended direction.

So the plan is: get the **current** line running, rather than go back.

```bash
# server stopped, Step 1 snapshot taken
node --version                 # must be >= v24.11.0 — upgrade first if not (Step 3b)
cd <your paperclip checkout>
git log --oneline -1           # expect e95ef3a1 or later
pnpm install
pnpm dev
tail -f ~/.paperclip/instances/default/logs/dev-runner.out
```

### What the upgrade changed about your data, stated plainly

Some of this is gone and we cannot bring it back. None of it is your core work — no issues,
companies, agents or comments were dropped — but you should know:

| Migration | What it did | Impact on you |
| --- | --- | --- |
| `0224_unified_adapter_auth_sessions` | **`DELETE FROM adapter_auth_sessions`** — wipes all in-flight adapter logins | **You will have to re-authenticate your AI adapters** (e.g. re-run the Claude login). This alone can make a working instance look dead: the server boots, but every agent run fails to authenticate. Check this early. |
| `0196_drop_cloud_upstream_tables` | Drops `cloud_upstream_runs`, `cloud_upstream_connections` | Experimental host-to-host sync, off by default. Its history is discarded. Replaced by Import/Export. |
| `0225_drop_claude_setup_token_sessions` | Drops `claude_setup_token_sessions` | Superseded by the unified table above. |
| `0229` / `0289` / `0190` | Drop `companies.brand_color`, `companies.attachment_max_bytes`, `user.keyboard_shortcuts`, `status_cards.instructions` | Cosmetic/config columns. If you had set a brand colour or custom keyboard shortcuts, re-set them. |

**If agent runs fail but the UI loads, go re-authenticate your adapters first.** That is the single
most likely post-migration symptom.

### One more thing to check — a silent hazard

If you had **locally modified any migration file** under `packages/db/src/migrations/`, tell us
before you go further. Our migrator identifies applied migrations by content **hash**; a
byte-divergent local copy degrades it into a timestamp fallback that can **silently skip
migrations and still report success**. That produces a half-migrated database that looks fine. We'd
rather check your ledger against ours than have you discover it in a month.

```bash
cd <your paperclip checkout>
git status --porcelain packages/db/src/migrations/    # expect NO output
```

---

## Step 6 — What we're doing on our side

- **`master` has been put back on the legacy line** (`5fd63cb6`), so a fresh `git pull` stops handing
  people an unverified application. This was done with a **revert commit, not a force-push**, so no
  clone that already pulled is invalidated — `git pull` will simply bring you back. The new line now
  lives on the non-default branch `upstream-rebase-2026-11` (also tagged
  `rebase/phase2-merged-2026-11`) until it has actually been booted and has a rollback runbook.
- **The default-branch flip is now gated.** It becomes the explicit *last* step of the re-base work,
  allowed only after the new line is verified green, booted as a live instance, and announced to you
  with two weeks' notice. No re-base PR targets `master` before that.
- The new line has **never been run as a live instance** — that verification (and the rollback
  runbook, and the two weeks' notice we owe you) was scheduled *after* the merge that reached you.
  That ordering was the mistake.
- The old line is tagged, branch-protected, and **will never be force-pushed or deleted**:
  `legacy/old-master-final-2026-11` (`5fd63cb6`) and `legacy/pre-upstream-rebase-2026-11`
  (`2744b2a7`), plus the `master-legacy` branch.

## If you're stuck

Send us: the output of **Step 2** (all four commands), and whether you completed the **Step 1**
snapshot. With those we can tell you exactly which path you're on instead of guessing. Don't run
`pnpm db:backup`, don't `git pull` again, and don't delete the snapshot.
