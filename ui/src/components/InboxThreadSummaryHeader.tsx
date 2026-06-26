import { Sparkles } from "lucide-react";

import type { InboxThreadSummary } from "@/lib/inbox-thread-summary";

interface InboxThreadSummaryHeaderProps {
  summary: InboxThreadSummary | null;
}

/**
 * Compact, quiet orientation header rendered at the top of an inbox/issue
 * thread. Summarizes what changed since the user's last visit and the single
 * suggested next action. Renders nothing when there is nothing to say.
 */
export function InboxThreadSummaryHeader({ summary }: InboxThreadSummaryHeaderProps) {
  if (!summary) return null;

  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" aria-hidden />
      <p className="leading-snug">
        <span className="text-foreground">{summary.whatChanged}</span>
        {summary.nextAction ? (
          <>
            {" — "}
            <span className="font-medium text-foreground">{summary.nextAction}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}
