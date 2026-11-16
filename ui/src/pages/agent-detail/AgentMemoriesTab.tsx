import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BrainCircuit, FileText, FolderOpen, Pencil, Save, X } from "lucide-react";
import type {
  Agent,
  AgentMemoryFact,
  AgentMemoryFileSummary,
  AgentMemoryParaEntity,
} from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/api-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownBody } from "@/components/MarkdownBody";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

function MemoryFactCard({ fact }: { fact: AgentMemoryFact }) {
  const superseded = fact.status === "superseded";
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        superseded ? "border-border/60 bg-muted/20 opacity-70" : "border-border",
      )}
    >
      <p className={cn("text-foreground", superseded && "line-through")}>{fact.fact ?? "(no text)"}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
        {fact.category && (
          <span className="rounded bg-accent/40 px-1.5 py-0.5 text-accent-foreground">{fact.category}</span>
        )}
        {fact.status && (
          <span
            className={cn(
              "rounded px-1.5 py-0.5",
              superseded
                ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                : "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
            )}
          >
            {fact.status}
            {superseded && fact.supersededBy ? ` → ${fact.supersededBy}` : ""}
          </span>
        )}
        {fact.relatedEntities.map((entity) => (
          <span key={entity} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
            {entity}
          </span>
        ))}
        {(fact.lastAccessed || fact.accessCount != null) && (
          <span className="ml-auto text-muted-foreground">
            {fact.lastAccessed ? `seen ${fact.lastAccessed}` : ""}
            {fact.accessCount != null ? ` · ${fact.accessCount}×` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

function MemoryFileButton({
  file,
  label,
  selected,
  onSelect,
}: {
  file: AgentMemoryFileSummary;
  label?: string;
  selected: boolean;
  onSelect: (relativePath: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(file.relativePath)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
      )}
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label ?? file.title}</span>
    </button>
  );
}

export function AgentMemoriesTab({ agent, companyId }: { agent: Agent; companyId?: string }) {
  const queryClient = useQueryClient();
  // `projectId` is set when the selection is a (shared, read-only) project memory
  // file rather than this agent's own memory.
  const [selected, setSelected] = useState<{ path: string; projectId?: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const isProjectSelection = Boolean(selected?.projectId);
  const isSelected = (path: string, projectId?: string) =>
    selected?.path === path && (selected?.projectId ?? undefined) === (projectId ?? undefined);

  const { data: overview, isLoading } = useQuery({
    queryKey: queryKeys.agents.memories(agent.id),
    queryFn: () => agentsApi.memories(agent.id, companyId),
    enabled: Boolean(companyId),
  });

  const { data: fileContent, isLoading: fileLoading } = useQuery({
    queryKey: queryKeys.agents.memoryFile(agent.id, selected?.path ?? "", selected?.projectId),
    queryFn: () => agentsApi.memoryFile(agent.id, selected!.path, companyId, selected!.projectId),
    enabled: Boolean(companyId && selected),
  });

  const saveMutation = useMutation({
    mutationFn: (content: string) =>
      agentsApi.saveMemoryFile(agent.id, { path: selected!.path, content }, companyId),
    onSuccess: async (result) => {
      queryClient.setQueryData(
        queryKeys.agents.memoryFile(agent.id, selected!.path, selected!.projectId),
        result,
      );
      setEditing(false);
      setSaveError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.memories(agent.id) });
    },
    onError: (error) => {
      setSaveError(error instanceof ApiError ? error.message : "Failed to save memory file");
    },
  });

  // Reset selection when switching agents; reset edit state when switching files.
  useEffect(() => {
    setSelected(null);
  }, [agent.id]);
  useEffect(() => {
    setEditing(false);
    setSaveError(null);
  }, [selected]);

  const entitiesByGroup = useMemo(() => {
    const groups = new Map<string, AgentMemoryParaEntity[]>();
    for (const entity of overview?.paraEntities ?? []) {
      const key = entity.subcategory ? `${entity.category}/${entity.subcategory}` : entity.category;
      const existing = groups.get(key) ?? [];
      existing.push(entity);
      groups.set(key, existing);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [overview?.paraEntities]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[360px] w-full" />
      </div>
    );
  }

  if (!overview?.hasMemories && !overview?.projectMemories?.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-16 text-center">
        <BrainCircuit className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">No memories yet</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {overview?.memorySource === "harness"
            ? "This agent hasn't written any memory yet. Claude harness auto-memory (the MEMORY.md index and individual fact files) will appear here."
            : "This agent hasn't written any memory files. Files created by the para-memory-files skill (MEMORY.md, daily notes, and the PARA knowledge graph) will appear here."}
        </p>
      </div>
    );
  }

  function startEditing() {
    setDraft(fileContent?.content.data ?? "");
    setEditing(true);
    setSaveError(null);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="space-y-4">
        {overview.tacit && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {overview.memorySource === "harness" ? "Index" : "Tacit"}
            </h3>
            <MemoryFileButton
              file={overview.tacit}
              selected={isSelected(overview.tacit.relativePath)}
              onSelect={(p) => setSelected({ path: p })}
            />
          </div>
        )}

        {overview.harnessFacts.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Facts</h3>
            <div className="space-y-0.5">
              {overview.harnessFacts.map((fact) => (
                <MemoryFileButton
                  key={fact.relativePath}
                  file={fact}
                  selected={isSelected(fact.relativePath)}
                  onSelect={(p) => setSelected({ path: p })}
                />
              ))}
            </div>
          </div>
        )}

        {overview.projectMemories.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Project memory
            </h3>
            <p className="mb-1.5 px-2 text-[11px] text-muted-foreground">
              Shared across agents working in this project. Read-only here.
            </p>
            <div className="space-y-2">
              {overview.projectMemories.map((pm) => (
                <div key={pm.projectId}>
                  <div className="flex items-center gap-1 px-2 text-[11px] font-medium text-muted-foreground">
                    <FolderOpen className="h-3 w-3" />
                    {pm.projectName}
                  </div>
                  {pm.tacit && (
                    <MemoryFileButton
                      file={pm.tacit}
                      label="Index"
                      selected={isSelected(pm.tacit.relativePath, pm.projectId)}
                      onSelect={(p) => setSelected({ path: p, projectId: pm.projectId })}
                    />
                  )}
                  {pm.harnessFacts.map((fact) => (
                    <MemoryFileButton
                      key={fact.relativePath}
                      file={fact}
                      selected={isSelected(fact.relativePath, pm.projectId)}
                      onSelect={(p) => setSelected({ path: p, projectId: pm.projectId })}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {overview.dailyNotes.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Daily notes
            </h3>
            <div className="space-y-0.5">
              {overview.dailyNotes.map((note) => (
                <MemoryFileButton
                  key={note.relativePath}
                  file={note}
                  label={note.date}
                  selected={isSelected(note.relativePath)}
                  onSelect={(p) => setSelected({ path: p })}
                />
              ))}
            </div>
          </div>
        )}

        {(overview.index || entitiesByGroup.length > 0) && (
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Knowledge graph
            </h3>
            {overview.index && (
              <MemoryFileButton
                file={overview.index}
                label="index.md"
                selected={isSelected(overview.index.relativePath)}
                onSelect={(p) => setSelected({ path: p })}
              />
            )}
            {entitiesByGroup.map(([groupKey, entities]) => (
              <div key={groupKey} className="mt-1.5">
                <div className="flex items-center gap-1 px-2 text-[11px] font-medium text-muted-foreground">
                  <FolderOpen className="h-3 w-3" />
                  {groupKey}
                </div>
                {entities.map((entity) => (
                  <div key={entity.relativeDir} className="ml-3 mt-0.5">
                    <div className="px-2 text-xs font-medium">{entity.name}</div>
                    {entity.summary && (
                      <MemoryFileButton
                        file={entity.summary}
                        label="summary.md"
                        selected={isSelected(entity.summary.relativePath)}
                        onSelect={(p) => setSelected({ path: p })}
                      />
                    )}
                    {entity.items && (
                      <MemoryFileButton
                        file={entity.items}
                        label={`items.yaml${entity.items.factCount != null ? ` (${entity.items.factCount})` : ""}`}
                        selected={isSelected(entity.items.relativePath)}
                        onSelect={(p) => setSelected({ path: p })}
                      />
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-[360px] rounded-lg border border-border p-4">
        {!selected ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a memory file to view it.
          </div>
        ) : fileLoading ? (
          <Skeleton className="h-[320px] w-full" />
        ) : !fileContent ? (
          <p className="text-sm text-destructive">Failed to load this memory file.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-xs text-muted-foreground">
                {fileContent.resource.relativePath}
              </span>
              {isProjectSelection ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">Shared · read-only</span>
              ) : !editing ? (
                <Button variant="outline" size="sm" onClick={startEditing}>
                  <Pencil className="h-3.5 w-3.5 sm:mr-1" />
                  <span className="hidden sm:inline">Edit</span>
                </Button>
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(false)}
                    disabled={saveMutation.isPending}
                  >
                    <X className="h-3.5 w-3.5 sm:mr-1" />
                    <span className="hidden sm:inline">Cancel</span>
                  </Button>
                  <Button size="sm" onClick={() => saveMutation.mutate(draft)} disabled={saveMutation.isPending}>
                    <Save className="h-3.5 w-3.5 sm:mr-1" />
                    <span className="hidden sm:inline">{saveMutation.isPending ? "Saving…" : "Save"}</span>
                  </Button>
                </div>
              )}
            </div>

            {saveError && <p className="text-sm text-destructive">{saveError}</p>}

            {editing ? (
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-[320px] font-mono text-xs"
                spellCheck={false}
              />
            ) : fileContent.resource.kind === "yaml" && fileContent.facts ? (
              <div className="space-y-2">
                {fileContent.facts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No facts in this file.</p>
                ) : (
                  fileContent.facts.map((fact, index) => <MemoryFactCard key={fact.id ?? index} fact={fact} />)
                )}
              </div>
            ) : fileContent.resource.kind === "yaml" ? (
              <div className="space-y-2">
                {fileContent.parseError && (
                  <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Could not parse facts: {fileContent.parseError}
                  </p>
                )}
                <MarkdownBody>{`\`\`\`yaml\n${fileContent.content.data}\n\`\`\``}</MarkdownBody>
              </div>
            ) : (
              <MarkdownBody>{fileContent.content.data}</MarkdownBody>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
