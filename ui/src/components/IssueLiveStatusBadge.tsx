import { useQuery } from "@tanstack/react-query";
import { Clock, Loader2, PauseCircle } from "lucide-react";

import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { activityApi, type RunForIssue } from "../api/activity";
import { issuesApi } from "../api/issues";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime, cn } from "../lib/utils";
import {
  deriveIssueLiveStatus,
  type IssueLiveStatus,
} from "../lib/issueLiveStatus";

// Newest-first ordering key for a run: prefer finish time, fall back to start,
// then creation — mirrors how the run ledger surfaces "the last thing that ran".
function runRecency(run: RunForIssue): number {
  const t = run.finishedAt ?? run.startedAt ?? run.createdAt;
  const ms = t ? new Date(t).getTime() : 0;
  return Number.isNaN(ms) ? 0 : ms;
}

// Human-friendly rendering of a raw park reason code. Falls back to the code
// with underscores spaced out; the raw code is always kept in the title attr.
const PARK_REASON_LABELS: Record<string, string> = {
  issue_continuation_waiting_on_review: "continuation waiting on review",
};
function humanizeParkReason(code: string): string {
  return PARK_REASON_LABELS[code] ?? code.replace(/_/g, " ");
}

/**
 * One-line, always-truthful answer to "why isn't this ticket moving right now?"
 * shown at the top of the ticket detail page (COM-356, fast-follow of COM-355).
 *
 *   🟢 Running now                        — a run is executing; opens run details.
 *   🟠 Waiting for your review since {t}  — legitimately parked on a board action;
 *                                            jumps to the confirmation/review.
 *   ⚪️ Parked — nothing queued            — nothing running or awaiting; offers a
 *                                            "continue" nudge for the abnormal case.
 *
 * Purely derived from data the page already loads (live runs, issue status,
 * pending interactions) — no new stored state.
 */
export interface IssueLiveStatusBadgeProps {
  issueId: string;
  issueStatus: string;
  issueUpdatedAt?: string | Date | null;
  blockerCount?: number;
  onOpenRunDetails?: (runId: string) => void;
  onOpenWaiting?: (interactionId: string | null) => void;
  onResume?: () => void;
  className?: string;
}

interface StatePresentation {
  dotClass: string;
  Icon: typeof Loader2;
  iconClass: string;
  label: string;
  actionLabel: string | null;
}

function absoluteTitle(since: string | null): string | undefined {
  if (!since) return undefined;
  const parsed = new Date(since);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toLocaleString();
}

function present(status: IssueLiveStatus): StatePresentation {
  if (status.kind === "running") {
    return {
      dotClass: "bg-emerald-500",
      Icon: Loader2,
      iconClass: "text-emerald-500 animate-spin",
      label: "Running now",
      actionLabel: "View run details",
    };
  }
  if (status.kind === "waiting") {
    const since = status.since ? ` since ${relativeTime(status.since)}` : "";
    if (status.waitingReason === "blocked") {
      return {
        dotClass: "bg-amber-500",
        Icon: Clock,
        iconClass: "text-amber-500",
        label: `Waiting on a blocker${since}`,
        actionLabel: null,
      };
    }
    return {
      dotClass: "bg-amber-500",
      Icon: Clock,
      iconClass: "text-amber-500",
      label: `Waiting for your review${since}`,
      actionLabel:
        status.waitingReason === "pending_interaction" ? "Review now" : "Open review",
    };
  }
  // Parked: attribute why it stopped when the last run tells us, and link to
  // that run so the "做着做着 cancel 然后没下文" case is traceable.
  const reason = status.parkedReason
    ? ` · ${humanizeParkReason(status.parkedReason)}`
    : " — nothing queued";
  return {
    dotClass: "bg-muted-foreground/50",
    Icon: PauseCircle,
    iconClass: "text-muted-foreground",
    label: `Parked${reason}`,
    actionLabel: status.runId ? "View run details" : "Continue",
  };
}

export function IssueLiveStatusBadge({
  issueId,
  issueStatus,
  issueUpdatedAt,
  blockerCount = 0,
  onOpenRunDetails,
  onOpenWaiting,
  onResume,
  className,
}: IssueLiveStatusBadgeProps) {
  const { data: liveRuns = [] } = useQuery<LiveRunForIssue[]>({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const { data: interactions = [] } = useQuery<IssueThreadInteraction[]>({
    queryKey: queryKeys.issues.interactions(issueId),
    queryFn: () => issuesApi.listInteractions(issueId),
    enabled: !!issueId,
  });

  const { data: runs = [] } = useQuery<RunForIssue[]>({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    enabled: !!issueId,
  });

  const latestRun = runs.reduce<RunForIssue | null>((newest, run) => {
    if (!newest) return run;
    return runRecency(run) >= runRecency(newest) ? run : newest;
  }, null);

  const status = deriveIssueLiveStatus({
    issueStatus,
    issueUpdatedAt,
    hasBlocker: blockerCount > 0,
    liveRuns,
    interactions,
    latestRun: latestRun
      ? {
          id: latestRun.runId,
          errorCode: latestRun.errorCode,
          retryExhaustedReason: latestRun.retryExhaustedReason,
          livenessReason: latestRun.livenessReason,
          nextAction: latestRun.nextAction,
          finishedAt: latestRun.finishedAt,
          createdAt: latestRun.createdAt,
        }
      : null,
  });

  if (!status) return null;

  const view = present(status);
  const { Icon } = view;

  const handleAction = () => {
    if (status.kind === "running" && status.runId) {
      onOpenRunDetails?.(status.runId);
    } else if (status.kind === "waiting") {
      onOpenWaiting?.(status.interactionId);
    } else if (status.kind === "parked") {
      // Prefer linking to the run that stopped without follow-up; fall back to
      // a "continue" nudge when there is no run to point at.
      if (status.runId) onOpenRunDetails?.(status.runId);
      else onResume?.();
    }
  };

  const actionable =
    (status.kind === "running" && !!onOpenRunDetails && !!status.runId) ||
    (status.kind === "waiting" &&
      !!onOpenWaiting &&
      view.actionLabel !== null) ||
    (status.kind === "parked" &&
      ((!!status.runId && !!onOpenRunDetails) || !!onResume));

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm",
        className,
      )}
      data-testid="issue-live-status-badge"
      data-status-kind={status.kind}
    >
      <span
        className={cn("h-2 w-2 shrink-0 rounded-full", view.dotClass)}
        aria-hidden
      />
      <Icon className={cn("h-3.5 w-3.5 shrink-0", view.iconClass)} aria-hidden />
      <span
        className="font-medium text-foreground"
        title={absoluteTitle(status.since)}
      >
        {view.label}
      </span>
      {actionable ? (
        <button
          type="button"
          onClick={handleAction}
          className="ml-auto text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          {view.actionLabel}
        </button>
      ) : null}
    </div>
  );
}
