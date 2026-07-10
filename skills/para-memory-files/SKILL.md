---
name: para-memory-files
description: >
  File-based memory system using Tiago Forte's PARA method. Use this skill whenever
  you need to store, retrieve, update, or organize knowledge across sessions. Covers
  three memory layers: (1) Knowledge graph in PARA folders with atomic YAML facts,
  (2) Daily notes as raw timeline, (3) Tacit knowledge about user patterns. Also
  handles planning files, memory decay, weekly synthesis, and recall via qmd.
  Trigger on any memory operation: saving facts, writing daily notes, creating
  entities, running weekly synthesis, recalling past context, or managing plans.
---

# PARA Memory Files

Persistent, file-based memory organized by Tiago Forte's PARA method. Three layers: a knowledge graph, daily notes, and tacit knowledge. All paths are relative to `$AGENT_HOME`.

## Critical: always anchor to `$AGENT_HOME`

Every memory path is **absolute under `$AGENT_HOME`** -- never relative to the current working directory.

- Always write the full path, e.g. `"$AGENT_HOME/memory/$(date +%F).md"`, not `memory/...`. Your cwd during a run is usually a project/issue workspace, **not** your home -- a bare `memory/` path silently lands in the wrong place and your memory will not be found later.
- Confirm the anchor before writing: `echo "$AGENT_HOME"`. If it is empty or unset, **stop and report it** -- do not guess a path or fall back to cwd.
- Never create a second `memory/`, `life/`, or `MEMORY.md` anywhere outside `$AGENT_HOME`.

## Three Memory Layers

### Layer 1: Knowledge Graph (`$AGENT_HOME/life/` -- PARA)

Entity-based storage. Each entity gets a folder with two tiers:

1. `summary.md` -- quick context, load first.
2. `items.yaml` -- atomic facts, load on demand.

```text
$AGENT_HOME/life/
  projects/          # Active work with clear goals/deadlines
    <name>/
      summary.md
      items.yaml
  areas/             # Ongoing responsibilities, no end date
    people/<name>/
    companies/<name>/
  resources/         # Reference material, topics of interest
    <topic>/
  archives/          # Inactive items from the other three
  index.md
```

**PARA rules:**

- **Projects** -- active work with a goal or deadline. Move to archives when complete.
- **Areas** -- ongoing (people, companies, responsibilities). No end date.
- **Resources** -- reference material, topics of interest.
- **Archives** -- inactive items from any category.

**Fact rules:**

- Save durable facts immediately to `items.yaml`.
- Weekly synthesis (no scheduler -- you trigger it): on the first run of a new ISO week (detect from the latest `$AGENT_HOME/memory/*.md` filenames), rewrite each active entity's `summary.md` from `items.yaml` by recency tier (hot/warm/cold) and bump access metadata. See [references/schemas.md](references/schemas.md) for the decay tiers.
- Never delete facts. Supersede instead (`status: superseded`, add `superseded_by`).
- When an entity goes inactive, move its folder to `$AGENT_HOME/life/archives/`.

**When to create an entity:**

- Mentioned 3+ times, OR
- Direct relationship to the user (family, coworker, partner, client), OR
- Significant project or company in the user's life.
- Otherwise, note it in daily notes.

For the atomic fact YAML schema and memory decay rules, see [references/schemas.md](references/schemas.md).

### Layer 2: Daily Notes (`$AGENT_HOME/memory/YYYY-MM-DD.md`)

Raw timeline of events -- the "when" layer.

- Write continuously during conversations.
- **Extraction is not optional.** Before you end any run in which you wrote daily notes or learned a durable fact, distill those notes into Layer 1: append atomic facts to the relevant `$AGENT_HOME/life/<entity>/items.yaml` and update its `summary.md`. Daily notes alone are not memory -- a timeline that never gets distilled means nothing accumulates.
- Update `$AGENT_HOME/MEMORY.md` (Layer 3) whenever you learn a new operating pattern.

### Layer 3: Tacit Knowledge (`$AGENT_HOME/MEMORY.md`)

How the user operates -- patterns, preferences, lessons learned.

- Not facts about the world; facts about the user.
- Update whenever you learn new operating patterns.

## Write It Down -- No Mental Notes

Memory does not survive session restarts. Files do.

- Want to remember something -> WRITE IT TO A FILE.
- "Remember this" -> update `$AGENT_HOME/memory/YYYY-MM-DD.md` or the relevant entity file.
- Learn a lesson -> update AGENTS.md, TOOLS.md, or the relevant skill file.
- Make a mistake -> document it so future-you does not repeat it.
- On-disk text files are always better than holding it in temporary context.

## Memory Recall -- Use qmd

Prefer `qmd` (hybrid BM25 + vector + reranking) over grepping -- it finds things even when the wording differs.

Index your personal folder once (and after large additions), then search:

```bash
qmd collection add "$AGENT_HOME"          # register your home as a collection
qmd update                                # (re)index; first run downloads models (~2GB, cached)
qmd query  "what happened at Christmas"   # hybrid search with query expansion + reranking
qmd search "specific phrase"              # BM25 keyword search
qmd vsearch "conceptual question"         # pure vector similarity
```

`qmd` needs Node >= 22; run `qmd doctor` if results look wrong. The first `update` downloads embedding/reranker models to `~/.cache/qmd/models/`.

**Fallback if `qmd` is unavailable** (`command -v qmd` is empty): use ripgrep over your home --
`rg -i "<term>" "$AGENT_HOME"` (keyword-only, no semantic match, but always works).

## Planning

Keep plans in timestamped files in `plans/` at the project root (outside personal memory so other agents can access them). Use `qmd` to search plans. Plans go stale -- if a newer plan exists, do not confuse yourself with an older version. If you notice staleness, update the file to note what it is supersededBy.
