import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Sparkles, Copy, Check, RefreshCw, Loader2, ChevronDown, MessageSquare, Send } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

interface CopilotSmsDraftProps {
  leadId: number;
  leadName: string;
  leadCity?: string;
  daysStale?: number;
  assignedAgent?: string;
  notes?: string;
  lastInboundText?: string;
  prefillMessage?: string;
  phone?: string;
  /** Called when agent wants to use this draft as the tap-to-text body */
  onSendWithDraft?: (draft: string) => void;
}

type CopilotMode = "outbound" | "reply";

export function CopilotSmsDraft({
  leadId,
  leadName,
  leadCity,
  daysStale,
  assignedAgent,
  notes,
  lastInboundText,
  prefillMessage,
  phone,
  onSendWithDraft,
}: CopilotSmsDraftProps) {
  const openGlobalCopilot = () => {
    window.dispatchEvent(
      new CustomEvent("copilot:open-with-lead", {
        detail: {
          id: leadId,
          name: leadName,
          phone: phone || "",
          stage: "",
          city: leadCity || "Texas",
          days_stale: daysStale || 0,
          sms_body: prefillMessage || "",
          sms_link: "",
          assigned_agent: assignedAgent || "",
          assigned_agent_id: 0,
          notes: notes || "",
          last_inbound_text: lastInboundText || "",
        },
      })
    );
  };
  const [isExpanded, setIsExpanded] = useState(false);
  const [mode, setMode] = useState<CopilotMode>("outbound");
  const [draft, setDraft] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [hasGeneratedReply, setHasGeneratedReply] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hasNotes = notes && notes.trim().length > 0;

  // Fetch last inbound text from FUB — auto-loads on expand (not just reply mode)
  // This powers Reply Mode auto-detection: if an inbound message exists, we auto-switch
  const lastInboundQuery = trpc.leads.getLastInbound.useQuery(
    { personId: leadId },
    {
      enabled: isExpanded, // fetch as soon as panel opens
      retry: false,
      staleTime: 60 * 1000, // 60s cache to protect FUB rate limits
    }
  );

  // Auto-switch to Reply Mode when an inbound message is detected on open
  useEffect(() => {
    if (
      isExpanded &&
      mode === "outbound" &&
      !hasGenerated && // only auto-switch before any draft is generated
      lastInboundQuery.data?.message &&
      !lastInboundQuery.isLoading
    ) {
      setMode("reply");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpanded, lastInboundQuery.data, lastInboundQuery.isLoading]);

  // Feedback learning system
  const logFeedbackMutation = trpc.copilot.logFeedback.useMutation();

  const logFeedback = (action: "sent" | "regenerated", draftText: string) => {
    if (!assignedAgent || !draftText) return;
    logFeedbackMutation.mutate({
      agentName: assignedAgent,
      draftText,
      leadCity: leadCity || undefined,
      draftType: mode === "reply" ? "reply" : "outbound",
      action,
    });
  };

  const draftMutation = trpc.ai.draftSms.useMutation({
    onSuccess: (data) => {
      setDraft(data.draft);
      setHasGenerated(true);
    },
    onError: (error) => {
      toast.error(`Copilot error: ${error.message}`);
    },
  });

  const replyMutation = trpc.ai.draftReply.useMutation({
    onSuccess: (data) => {
      setDraft(data.draft);
      setHasGeneratedReply(true);
    },
    onError: (error) => {
      toast.error(`Copilot error: ${error.message}`);
    },
  });

  // Auto-generate outbound draft when panel first opens in outbound mode
  useEffect(() => {
    if (isExpanded && mode === "outbound" && !hasGenerated && !draftMutation.isPending) {
      generateOutboundDraft();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpanded, mode]);

  // Auto-generate reply draft when inbound message is loaded
  useEffect(() => {
    const inboundMsg = lastInboundQuery.data?.message;
    if (
      isExpanded &&
      mode === "reply" &&
      inboundMsg &&
      !hasGeneratedReply &&
      !replyMutation.isPending
    ) {
      generateReplyDraft(inboundMsg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastInboundQuery.data, isExpanded, mode]);

  // Reset draft when mode changes
  useEffect(() => {
    setDraft("");
    setHasGenerated(false);
    setHasGeneratedReply(false);
  }, [mode]);

  const generateOutboundDraft = () => {
    draftMutation.mutate({
      leadName,
      leadCity,
      daysStale,
      assignedAgent,
      notes: notes || undefined,
      prefillMessage: prefillMessage || undefined,
      personId: leadId, // memory layer context
    });
  };

  const generateReplyDraft = (inboundMessage: string) => {
    replyMutation.mutate({
      leadName,
      leadCity,
      assignedAgent,
      inboundMessage,
      notes: notes || undefined,
      personId: leadId, // memory layer context + auto-extract memories from inbound
    });
  };

  const handleCopy = async () => {
    const textToCopy = draft || prefillMessage || "";
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
    } catch {
      const el = document.createElement("textarea");
      el.value = textToCopy;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    toast.success("Copied to clipboard!");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSendWithDraft = () => {
    if (draft && onSendWithDraft) {
      // Log positive feedback signal — agent chose to send this draft
      logFeedback("sent", draft);
      onSendWithDraft(draft);
    }
  };

  const charCount = (draft || "").length;
  const isOverLimit = charCount > 160;
  const inboundMessage = lastInboundQuery.data?.message;
  const isLoading = mode === "outbound" ? draftMutation.isPending : (lastInboundQuery.isLoading || replyMutation.isPending);

  return (
    <div className="mt-2">
      {/* Toggle button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200",
          isExpanded
            ? "bg-[oklch(0.76_0.14_78/12%)] border border-[oklch(0.76_0.14_78/30%)] text-[oklch(0.76_0.14_78)]"
            : "bg-card/4 border border-white/8 text-muted-foreground hover:border-[oklch(0.76_0.14_78/30%)] hover:bg-[oklch(0.76_0.14_78/8%)] hover:text-[oklch(0.76_0.14_78)]"
        )}
      >
        <div className="flex items-center gap-2">
          <Sparkles className={cn("h-3.5 w-3.5", isExpanded ? "text-[oklch(0.76_0.14_78)]" : "text-muted-foreground")} />
          <span>
            {isExpanded ? "Agent Copilot" : "✨ Agent Copilot — AI-Powered SMS"}
          </span>
          {hasNotes && (
            <span className="px-1.5 py-0.5 rounded-full bg-[oklch(0.76_0.14_78/15%)] text-[oklch(0.76_0.14_78)] text-[9px] font-semibold uppercase tracking-wide">
              Notes
            </span>
          )}
        </div>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 transition-transform duration-200",
            isExpanded ? "rotate-180 text-[oklch(0.76_0.14_78)]" : "text-muted-foreground"
          )}
        />
      </button>

      {/* Expanded panel */}
      {isExpanded && (
        <div className="mt-2 rounded-xl border border-[oklch(0.76_0.14_78/20%)] bg-gradient-to-br from-[oklch(0.76_0.14_78/6%)] to-[oklch(0.76_0.14_78/3%)] overflow-hidden shadow-sm">
          {/* Mode tabs */}
          <div className="flex border-b border-white/8">
            <button
              onClick={() => setMode("outbound")}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-semibold transition-colors",
                mode === "outbound"
                  ? "bg-[oklch(0.76_0.14_78/15%)] text-[oklch(0.76_0.14_78)] border-b-2 border-[oklch(0.76_0.14_78)]"
                  : "text-muted-foreground hover:text-[oklch(0.76_0.14_78)] hover:bg-[oklch(0.76_0.14_78/8%)]"
              )}
            >
              <Send className="h-3 w-3" />
              Draft Outbound Text
            </button>
            <button
              onClick={() => setMode("reply")}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-semibold transition-colors",
                mode === "reply"
                  ? "bg-[oklch(0.76_0.14_78/15%)] text-[oklch(0.76_0.14_78)] border-b-2 border-[oklch(0.76_0.14_78)]"
                  : "text-muted-foreground hover:text-[oklch(0.76_0.14_78)] hover:bg-[oklch(0.76_0.14_78/8%)]"
              )}
            >
              <MessageSquare className="h-3 w-3" />
              Reply to Lead
            </button>
          </div>

          {/* Header with source label + regenerate */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/8">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-full bg-[oklch(0.76_0.14_78/15%)] flex items-center justify-center">
                <Sparkles className="h-3 w-3 text-[oklch(0.76_0.14_78)]" />
              </div>
              <span className="text-[11px] font-semibold text-[oklch(0.76_0.14_78)]">
                {mode === "outbound"
                  ? hasNotes
                    ? "Personalized from lead notes"
                    : "Refined from pre-filled message"
                  : inboundMessage
                  ? `Replying to: "${inboundMessage.slice(0, 40)}${inboundMessage.length > 40 ? "…" : ""}"`
                  : "Checking for inbound messages..."}
              </span>
            </div>
            <button
              onClick={() => {
                // Log negative feedback signal — agent regenerated (didn't like this draft)
                if (draft) logFeedback("regenerated", draft);
                if (mode === "outbound") {
                  setHasGenerated(false);
                  generateOutboundDraft();
                } else if (inboundMessage) {
                  setHasGeneratedReply(false);
                  generateReplyDraft(inboundMessage);
                }
              }}
              disabled={isLoading || (mode === "reply" && !inboundMessage)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] text-[oklch(0.76_0.14_78)] hover:bg-[oklch(0.76_0.14_78/12%)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
            >
              {isLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Regenerate

            </button>
          </div>

          {/* Reply mode: show inbound message if available */}
          {mode === "reply" && (
            <div className="px-3 pt-3">
              {lastInboundQuery.isLoading ? (
                <div className="flex items-center gap-2 text-[11px] text-amber-700 py-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Checking Follow Up Boss for their last message...
                </div>
              ) : inboundMessage ? (
                <div className="bg-card/6 border border-white/10 rounded-lg px-3 py-2 mb-2">
                  <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">
                    Lead's Last Message
                  </span>
                  <p className="text-xs text-foreground/80 italic">"{inboundMessage}"</p>
                </div>
              ) : (
                <div className="bg-card/4 border border-white/8 rounded-lg px-3 py-2 mb-2 text-[11px] text-muted-foreground">
                  No inbound texts found in Follow Up Boss for this lead.
                  <br />
                  <span className="text-[10px] text-muted-foreground/70">Switch to "Draft Outbound Text" to send a proactive message.</span>
                </div>
              )}
            </div>
          )}

          {/* Draft content */}
          <div className="p-3 space-y-2">
            {isLoading && !draft ? (
              <div className="flex items-center gap-2.5 py-3 px-1">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce [animation-delay:300ms]" />
                </div>
                  <span className="text-xs text-[oklch(0.76_0.14_78)]">
                  {mode === "outbound"
                    ? hasNotes
                      ? "Personalizing from notes..."
                      : "Refining message..."
                    : "Drafting reply..."}
                </span>
              </div>
            ) : mode === "reply" && !inboundMessage && !lastInboundQuery.isLoading ? null : (
              <>
                <Textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className={cn(
                    "text-sm resize-none min-h-[72px] bg-[oklch(0.10_0.006_260)] border-white/15 focus-visible:ring-amber-500/40 text-white placeholder:text-white/40 [text-shadow:0_0_3px_#000,0_1px_2px_#000]",
                    isOverLimit && "border-red-400 focus-visible:ring-red-400/40"
                  )}
                  placeholder="AI draft will appear here..."
                  rows={3}
                />

                {/* Character count + actions */}
                <div className="flex items-center justify-between">
                  <span
                    className={cn(
                      "text-[10px] font-mono",
                      isOverLimit ? "text-red-400 font-semibold" : "text-muted-foreground"
                    )}
                  >
                    {charCount}/160 chars{isOverLimit && " — over limit"}
                  </span>

                  <div className="flex items-center gap-2">
                    {onSendWithDraft && draft && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleSendWithDraft}
                        className="h-7 px-2.5 text-[11px] border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 bg-card/4 font-semibold"
                      >
                        <Send className="h-3 w-3 mr-1" />
                        Send This
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={handleCopy}
                      disabled={!draft}
                      className={cn(
                        "h-7 px-3 text-[11px] font-semibold transition-all duration-200",
                        copied
                          ? "bg-emerald-500 hover:bg-emerald-500 text-white"
                          : "bg-amber-500 hover:bg-amber-400 text-white"
                      )}
                    >
                      {copied ? (
                        <>
                          <Check className="h-3 w-3 mr-1" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3 mr-1" />
                          Copy
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {mode === "outbound" && !hasNotes && (
                  <p className="text-[10px] text-muted-foreground italic">
                    No notes in Follow Up Boss — message refined from the pre-filled template. Add notes in FUB for a more personalized draft.
                  </p>
                )}
              </>
            )}
          </div>
          {/* Ask AI Broker footer */}
          <div className="px-3 py-2 border-t border-white/8 bg-[oklch(0.76_0.14_78/4%)] flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Need more help with this lead?</span>
            <button
              onClick={openGlobalCopilot}
              className="flex items-center gap-1.5 text-[11px] font-semibold text-[oklch(0.76_0.14_78)] hover:text-[oklch(0.82_0.14_78)] transition-colors"
            >
              <Sparkles className="h-3 w-3" />
              Ask AI Broker
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
