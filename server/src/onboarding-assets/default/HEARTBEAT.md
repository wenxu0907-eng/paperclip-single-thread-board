# HEARTBEAT.md -- Memory Lifecycle (every agent, every heartbeat)

Run this on every heartbeat, alongside your task work. It keeps your file-based
memory alive so context survives session restarts. The mechanics (folder layout,
atomic-fact schema, decay, recall) live in the `para-memory-files` skill -- this
checklist is the trigger; the skill is the source of truth.

**All paths are absolute under `$AGENT_HOME`.** Confirm the anchor first:
`echo "$AGENT_HOME"`. If it is empty, stop and report it -- never write memory
relative to your current working directory.

## At the start of a run

1. Read today's plan/notes: `$AGENT_HOME/memory/$(date +%F).md` (the "## Today's Plan"
   section if present). Review what's done, blocked, and next.
2. Recall relevant past context before acting -- use `qmd` (or the ripgrep fallback)
   over `$AGENT_HOME`, per the para-memory-files skill.

## During the run

- Append timeline entries to `$AGENT_HOME/memory/$(date +%F).md` as things happen.

## Before you exit -- do not skip

3. **Extract.** If you wrote daily notes or learned a durable fact this run, distill
   it into the knowledge graph: append atomic facts to the relevant
   `$AGENT_HOME/life/<entity>/items.yaml` and refresh that entity's `summary.md`.
   Daily notes that never get distilled are not memory.
4. **Tacit.** If you learned a new operating pattern (how this company/user works),
   update `$AGENT_HOME/MEMORY.md`.
5. **Weekly synthesis.** On the first run of a new ISO week (detect from the latest
   `$AGENT_HOME/memory/*.md` dates), rewrite each active entity's `summary.md` from
   `items.yaml` by recency tier and bump access metadata.

Memory work is not optional busywork -- it is how you stop relearning the same
things every session. See the `para-memory-files` skill for full details.
