/**
 * VoiceoverBudget — monthly character usage meter.
 * Shows current usage vs limit with a progress bar.
 */
import { Progress } from "@/components/ui/progress";
import { trpc } from "@/lib/trpc";
import { Mic } from "lucide-react";

export function VoiceoverBudget() {
  const { data } = trpc.voiceover.budget.useQuery();

  if (!data) return null;

  const pct = Math.min(100, Math.round((data.charactersUsed / data.budgetLimit) * 100));
  const isWarning = pct >= 80;
  const isOver = pct >= 100;

  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Mic className="h-4 w-4 text-primary" />
          <span className="text-xs uppercase tracking-luxe text-muted-foreground">
            Voiceover Budget
          </span>
        </div>
        <span className={`text-xs font-medium ${isOver ? "text-red-400" : isWarning ? "text-amber-400" : "text-muted-foreground"}`}>
          {data.charactersUsed.toLocaleString()} / {data.budgetLimit.toLocaleString()} chars
        </span>
      </div>
      <Progress value={pct} className="h-1.5" />
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {new Date().toLocaleString("en-US", { month: "long", year: "numeric" })} · {pct}% used
        {isOver && " — budget exceeded, new voiceovers paused"}
        {isWarning && !isOver && " — approaching limit"}
      </p>
    </div>
  );
}
