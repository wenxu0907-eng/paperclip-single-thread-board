import { useQuery } from "@tanstack/react-query";
import { issuesApi, type IssueDecisionQueueItem } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../lib/query-placeholder-data";
import { buildIssueThreadInteractionSummary } from "../lib/issue-thread-interactions";
import { IssueReferencePill } from "./IssueReferencePill";

interface DecisionQueuePanelProps {
  /** Company that owns the top-level issue. Kept for caller symmetry / future batch-resolve slice. */
  companyId: string;
  /** The top-level (parentless) issue whose descendant subtree is aggregated. */
  issueId: string;
}

/**
 * Read + navigate view of every pending board decision rolled up from a
 * top-level issue's entire child subtree. Resolving happens on the source
 * thread via the per-item link — this panel does not accept/reject inline.
 */
export function DecisionQueuePanel({ issueId }: DecisionQueuePanelProps) {
  const { data, isError } = useQuery({
    queryKey: queryKeys.issues.decisionQueue(issueId),
    queryFn: () => issuesApi.getDecisionQueue(issueId),
    placeholderData: keepPreviousDataForSameQueryTail<
      Awaited<ReturnType<typeof issuesApi.getDecisionQueue>>
    >(issueId),
  });

  // Fail quiet: this is an additive summary; never block the detail view on it.
  if (isError) return null;

  const items = data?.items ?? [];
  // Render nothing when there are no pending decisions to avoid clutter.
  if (items.length === 0) return null;

  return (
    <section className="space-y-3 rounded-lg border border-border p-3" aria-label="Decision queue">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">Decision Queue</h3>
        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-amber-500/10 px-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          {items.length}
        </span>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <DecisionQueueRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

function DecisionQueueRow({ item }: { item: IssueDecisionQueueItem }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 text-sm">
      <span className="text-foreground">{buildIssueThreadInteractionSummary(item)}</span>
      <span className="text-xs text-muted-foreground">from</span>
      <IssueReferencePill issue={item.sourceIssue} />
      {item.sourceIssue.title ? (
        <span className="truncate text-xs text-muted-foreground" title={item.sourceIssue.title}>
          {item.sourceIssue.title}
        </span>
      ) : null}
    </li>
  );
}
