import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../lib/query-placeholder-data";
import { relativeTime } from "../lib/utils";

interface SubtreeDigestPanelProps {
  /** The top-level (parentless) issue whose descendant fan-out is summarized. */
  issueId: string;
}

/**
 * Compact, read-only roll-up of a top-level intent's internal fan-out: one line
 * with subtask totals, in-progress / blocked / done counts, pending board
 * decisions, and last activity. Renders nothing until the intent has fanned out.
 */
export function SubtreeDigestPanel({ issueId }: SubtreeDigestPanelProps) {
  const { data, isError } = useQuery({
    queryKey: queryKeys.issues.digest(issueId),
    queryFn: () => issuesApi.getSubtreeDigest(issueId),
    placeholderData: keepPreviousDataForSameQueryTail<
      Awaited<ReturnType<typeof issuesApi.getSubtreeDigest>>
    >(issueId),
  });

  // Fail quiet: this is an additive summary; never block the detail view on it.
  if (isError) return null;
  if (!data) return null;

  // Render nothing for a top-level intent with no fan-out yet.
  if (data.descendantCount === 0) return null;

  const parts: string[] = [
    `${data.descendantCount} ${data.descendantCount === 1 ? "subtask" : "subtasks"}`,
    `${data.countsByStatus.in_progress} in progress`,
    `${data.blockedCount} blocked`,
    `${data.countsByStatus.done} done`,
  ];
  if (data.pendingDecisionCount > 0) {
    parts.push(`${data.pendingDecisionCount} decisions pending`);
  }

  return (
    <section
      className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"
      aria-label="Subtask digest"
    >
      <span>{parts.join(" · ")}</span>
      {data.lastActivityAt ? (
        <span> · updated {relativeTime(data.lastActivityAt)}</span>
      ) : null}
    </section>
  );
}
