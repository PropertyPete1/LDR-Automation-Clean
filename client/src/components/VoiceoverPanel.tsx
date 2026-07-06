/**
 * VoiceoverPanel — inline voiceover controls for each PickCard.
 * Shows: toggle → script editor → approval → render status → video preview → final approve.
 */
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mic,
  RefreshCw,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface VoiceoverPanelProps {
  pickId: number;
  pickStatus: "pending" | "confirmed" | "posted" | "failed";
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  detecting: { label: "Analyzing audio…", color: "text-blue-400" },
  scripting: { label: "Writing script…", color: "text-blue-400" },
  pending_approval: { label: "Script ready — review below", color: "text-amber-400" },
  generating_audio: { label: "Generating voiceover…", color: "text-blue-400" },
  duration_mismatch: { label: "Duration mismatch — edit script", color: "text-amber-400" },
  rendering: { label: "Rendering video…", color: "text-blue-400" },
  preview_ready: { label: "Preview ready — approve to post", color: "text-emerald-400" },
  approved: { label: "Approved ✓", color: "text-emerald-400" },
  failed: { label: "Failed", color: "text-red-400" },
};

export function VoiceoverPanel({ pickId, pickStatus }: VoiceoverPanelProps) {
  const utils = trpc.useUtils();
  const { data: job, isLoading } = trpc.voiceover.getJob.useQuery(
    { pickId },
    { refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Poll while processing
      if (status && ["detecting", "scripting", "generating_audio", "rendering"].includes(status)) {
        return 3000;
      }
      return false;
    }}
  );

  const [enabled, setEnabled] = useState(false);
  const [script, setScript] = useState("");
  const [scriptDirty, setScriptDirty] = useState(false);
  const [audioMode, setAudioMode] = useState<"duck" | "mute">("duck");

  useEffect(() => {
    if (job) {
      setEnabled(true);
      if (!scriptDirty) setScript(job.script ?? "");
    }
  }, [job, scriptDirty]);

  const startJob = trpc.voiceover.startJob.useMutation({
    onSuccess: () => {
      toast.success("Voiceover job started");
      utils.voiceover.getJob.invalidate({ pickId });
    },
    onError: (err) => toast.error(err.message),
  });

  const updateScript = trpc.voiceover.updateScript.useMutation({
    onSuccess: () => {
      setScriptDirty(false);
      toast.success("Script saved");
      utils.voiceover.getJob.invalidate({ pickId });
    },
    onError: (err) => toast.error(err.message),
  });

  const regenerateScript = trpc.voiceover.regenerateScript.useMutation({
    onSuccess: () => {
      setScriptDirty(false);
      toast.success("Regenerating script…");
      utils.voiceover.getJob.invalidate({ pickId });
    },
    onError: (err) => toast.error(err.message),
  });

  const approveScript = trpc.voiceover.approveScript.useMutation({
    onSuccess: () => {
      toast.success("Script approved — rendering voiceover…");
      utils.voiceover.getJob.invalidate({ pickId });
    },
    onError: (err) => toast.error(err.message),
  });

  const approveVideo = trpc.voiceover.approveVideo.useMutation({
    onSuccess: () => {
      toast.success("Voiceover approved for posting!");
      utils.voiceover.getJob.invalidate({ pickId });
    },
    onError: (err) => toast.error(err.message),
  });

  // Don't show for already-posted picks
  if (pickStatus === "posted") return null;

  if (isLoading) {
    return (
      <div className="mt-4 border-t border-border/50 pt-4">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  // Toggle to enable voiceover
  if (!job && !enabled) {
    return (
      <div className="mt-4 border-t border-border/50 pt-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mic className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">Add Peter Voiceover</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <button
                onClick={() => setAudioMode("duck")}
                className={cn(
                  "rounded-full px-2 py-0.5 transition-colors",
                  audioMode === "duck" ? "bg-primary/20 text-primary" : "hover:text-foreground"
                )}
              >
                <Volume2 className="inline h-3 w-3 mr-1" />Duck
              </button>
              <button
                onClick={() => setAudioMode("mute")}
                className={cn(
                  "rounded-full px-2 py-0.5 transition-colors",
                  audioMode === "mute" ? "bg-primary/20 text-primary" : "hover:text-foreground"
                )}
              >
                <VolumeX className="inline h-3 w-3 mr-1" />Mute
              </button>
            </div>
            <Switch
              checked={false}
              onCheckedChange={() => {
                setEnabled(true);
                startJob.mutate({ pickId, originalAudioMode: audioMode });
              }}
            />
          </div>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Generate an AI voiceover with captions using Peter&apos;s voice clone.
          {audioMode === "duck" ? " Original audio reduced to 15%." : " Original audio replaced entirely."}
        </p>
      </div>
    );
  }

  // Job exists — show status and controls
  const status = job?.status ?? "detecting";
  const statusInfo = STATUS_LABELS[status] ?? { label: status, color: "text-muted-foreground" };
  const isProcessing = ["detecting", "scripting", "generating_audio", "rendering"].includes(status);
  const canEditScript = status === "pending_approval" || status === "duration_mismatch";
  const canApproveScript = canEditScript && (job?.script?.length ?? 0) > 0;
  const canApproveVideo = status === "preview_ready";

  return (
    <div className="mt-4 border-t border-border/50 pt-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Mic className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">Peter Voiceover</span>
          <span className={cn("text-xs", statusInfo.color)}>
            {isProcessing && <Loader2 className="inline h-3 w-3 animate-spin mr-1" />}
            {statusInfo.label}
          </span>
        </div>
        {status === "approved" && (
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
        )}
      </div>

      {/* Processing indicator */}
      {isProcessing && (
        <div className="mb-3">
          <Progress
            value={
              status === "detecting" ? 15 :
              status === "scripting" ? 35 :
              status === "generating_audio" ? 60 :
              status === "rendering" ? 80 : 0
            }
            className="h-1.5"
          />
        </div>
      )}

      {/* Script editor */}
      {canEditScript && job?.script && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs uppercase tracking-luxe text-muted-foreground">
              Voiceover Script
            </label>
            <span className="text-[11px] text-muted-foreground">
              {script.length} chars · ~{Math.round(script.split(/\s+/).length / 2.45)}s
            </span>
          </div>
          <Textarea
            value={script}
            onChange={(e) => { setScript(e.target.value); setScriptDirty(true); }}
            className="min-h-[120px] resize-none bg-background/60 font-sans text-sm leading-relaxed"
          />
          {job.durationMismatchPct !== null && Math.abs(job.durationMismatchPct) > 5 && (
            <div className="flex items-center gap-2 text-xs text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              Duration mismatch: {job.durationMismatchPct > 0 ? "+" : ""}{job.durationMismatchPct}% — consider shortening the script
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => approveScript.mutate({ jobId: job.id })}
              disabled={approveScript.isPending || !canApproveScript}
              className="rounded-full px-5 transition-transform active:scale-[0.97]"
              style={{ transitionTimingFunction: "var(--ease-out)" }}
            >
              {approveScript.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Approve &amp; Render
            </Button>
            {scriptDirty && (
              <Button
                variant="outline"
                onClick={() => updateScript.mutate({ jobId: job.id, script })}
                disabled={updateScript.isPending}
                className="rounded-full bg-transparent"
              >
                {updateScript.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save edits
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => regenerateScript.mutate({ jobId: job.id })}
              disabled={regenerateScript.isPending}
              className="rounded-full text-muted-foreground"
            >
              <RefreshCw className={cn("h-4 w-4", regenerateScript.isPending && "animate-spin")} />
              Regenerate
            </Button>
          </div>
        </div>
      )}

      {/* Preview ready */}
      {canApproveVideo && job && (
        <div className="space-y-3">
          <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground mb-2">
              Voiceover rendered successfully ({job.audioDurationSec}s audio, {job.charactersUsed} chars used).
            </p>
            {job.renderedVideoStorageKey && (
              <video
                src={`/manus-storage/${job.renderedVideoStorageKey}`}
                controls
                className="w-full max-h-[300px] rounded-lg"
              />
            )}
          </div>
          <Button
            onClick={() => approveVideo.mutate({ jobId: job.id })}
            disabled={approveVideo.isPending}
            className="rounded-full px-6 transition-transform active:scale-[0.97]"
            style={{ transitionTimingFunction: "var(--ease-out)" }}
          >
            {approveVideo.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            Approve for Posting
          </Button>
        </div>
      )}

      {/* Approved state */}
      {status === "approved" && (
        <p className="text-sm text-emerald-400">
          Voiceover approved — this version will be posted to Instagram.
        </p>
      )}

      {/* Failed state */}
      {status === "failed" && job && (
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertTriangle className="h-4 w-4" />
          {job.errorMessage ?? "Voiceover generation failed"}
        </div>
      )}
    </div>
  );
}
