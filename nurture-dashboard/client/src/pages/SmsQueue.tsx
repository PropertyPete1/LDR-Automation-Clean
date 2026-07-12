import React, { useState, useEffect, useMemo, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Check, Send, Phone, User, MapPin, Clock,
  Search, Filter, CheckCircle2, Flame, Loader2, ChevronRight,
  SkipForward, Sparkles, RefreshCw, MessageSquare, Unlock, ArrowLeft,
  Target, Share, X, Lock, UserX, AlertTriangle, Mail
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface PendingLead {
  id: number;
  name: string;
  phone: string;
  stage: string;
  city: string;
  days_stale: number;
  sms_body: string;
  sms_link: string;
  assigned_agent: string;
  assigned_agent_id: number;
  notes?: string;
  last_inbound_text?: string;
  last_contacted?: string;
  last_contacted_days?: number;
  is_priority?: boolean; // true when days_stale >= 14
}

const ROSTER_AGENT_NAMES = ["Peter", "Steven", "Tiffany", "Stefanie", "Abby", "Irma", "Laila"];
const EXCLUDED_AGENT_NAMES = new Set(["luke", "bebe"]);
// Peter is the pond owner — stale leads get reassigned to him, so his leads = pond leads
const POND_OWNER = "peter";
const DAILY_SMS_GOAL = 15;

function getAgentFromUrl(): string {
  if (typeof window === "undefined") return "all";
  const params = new URLSearchParams(window.location.search);
  const agent = params.get("agent");
  return agent ? agent.toLowerCase() : "all";
}

function getAgentDisplayName(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  const agent = params.get("agent") || "";
  return agent ? agent.trim().charAt(0).toUpperCase() + agent.trim().slice(1).toLowerCase() : "";
}

// ─── Inline Copilot Draft ──────────────────────────────────────────────────
function InlineCopilotDraft({
  lead,
  value,
  onChange,
  onGenerate,
  isGenerating,
}: {
  lead: PendingLead;
  value: string;
  onChange: (v: string) => void;
  onGenerate: () => void;
  isGenerating: boolean;
}) {
  const charCount = value.length;
  const isOverLimit = charCount > 160;
  const hasNotes = lead.notes && lead.notes.trim().length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-amber-500" />
          <span className="text-[11px] font-semibold text-amber-600 uppercase tracking-wider">
            AI Copilot Message
          </span>
          {hasNotes && (
            <Badge className="bg-amber-100 text-amber-600 border-none text-[9px] px-1.5 py-0 font-semibold">
              From Notes
            </Badge>
          )}
        </div>
        <button
          onClick={onGenerate}
          disabled={isGenerating}
          className="flex items-center gap-1 text-[11px] text-amber-500 hover:text-amber-700 font-medium transition-colors disabled:opacity-50"
        >
          {isGenerating ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          {isGenerating ? "Drafting…" : "Regenerate"}
        </button>
      </div>

      {isGenerating && !value ? (
        <div className="flex items-center gap-2.5 py-4 px-3 bg-amber-50 border border-amber-500/15 rounded-lg">
          <div className="flex gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce [animation-delay:300ms]" />
          </div>
          <span className="text-xs text-amber-600">
            {hasNotes ? "Personalizing from FUB notes…" : "Crafting message…"}
          </span>
        </div>
      ) : (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`text-sm resize-none min-h-[80px] bg-white border-amber-300 focus-visible:ring-amber-400 text-gray-900 placeholder:text-gray-400 ${
            isOverLimit ? "border-red-400 focus-visible:ring-red-400" : ""
          }`}
          placeholder="AI draft will appear here — edit before sending…"
          rows={3}
        />
      )}

      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-mono ${isOverLimit ? "text-red-400 font-semibold" : "text-white/30"}`}>
          {charCount}/160 chars{isOverLimit ? " — over limit" : ""}
        </span>
        {!hasNotes && (
          <span className="text-[10px] text-white/30 italic">
            No FUB notes — add notes for a more personalized draft
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────
export default function SmsQueue() {
  // lockedAgent: set when ?agent= is in the URL — this agent cannot be changed
  // It is derived once from the URL and never changes during the session.
  const lockedAgent = useMemo(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("agent");
    return raw ? raw.trim() : null;
  }, []);

  const [selectedAgent, setSelectedAgent] = useState<string>(() => getAgentFromUrl());
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [freePick, setFreePick] = useState<boolean>(false);
  // Remember the original agent filter so we can restore it when leaving Free Pick
  const originalAgentRef = useRef<string>(getAgentFromUrl());
  // iOS install banner — shown once per session in iOS Safari (not standalone)
  const [showInstallBanner, setShowInstallBanner] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const dismissed = sessionStorage.getItem("pwa_banner_dismissed");
    if (dismissed) return false;
    const isIos = /iPhone|iPad/i.test(navigator.userAgent);
    const isStandalone = (window.navigator as any).standalone === true;
    return isIos && !isStandalone;
  });
  const [textedLeads, setTextedLeads] = useState<Record<number, boolean>>(() => {
    try {
      const saved = localStorage.getItem("fub_power_queue_texted");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  // Track when the queue was last fetched for the "Updated X ago" label
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [lastRefreshedLabel, setLastRefreshedLabel] = useState<string>("");
  const [draftMessages, setDraftMessages] = useState<Record<number, string>>({});
  const [generatingFor, setGeneratingFor] = useState<number | null>(null);
  // Snooze: leads hidden for today only — stored in sessionStorage so they reappear tomorrow
  const [snoozedLeads, setSnoozedLeads] = useState<Set<number>>(() => {
    try {
      const saved = sessionStorage.getItem("fub_snoozed_leads");
      return saved ? new Set<number>(JSON.parse(saved)) : new Set<number>();
    } catch {
      return new Set<number>();
    }
  });

  const { data: queueData, isLoading: queueLoading, error: queueError, refetch, dataUpdatedAt } =
    trpc.fub.getPendingQueue.useQuery(
      // Pass lockedAgent as agentFilter so the SERVER only returns that agent's leads.
      // When lockedAgent is null (Peter/admin), pass empty object — full queue returned.
      lockedAgent ? { agentFilter: lockedAgent } : {},
      {
        staleTime: 3 * 60 * 1000,
        refetchOnWindowFocus: false,
      }
    );

  // Seed textedLeads from DB on first load so refresh never resets progress
  // Use getAgentDisplayName() directly since agentDisplayName is declared later
  const _agentNameForSeed = getAgentDisplayName();
  const { data: dbTextedData } = trpc.leads.getTodayTextedLeadIds.useQuery(
    { agentName: _agentNameForSeed || "all" },
    { enabled: !!_agentNameForSeed, staleTime: 60 * 1000 }
  );

  const leads: PendingLead[] = queueData || [];

  const logSentNote = trpc.leads.logSentNote.useMutation({
    onError: (err) => console.error("FUB note log failed:", err.message),
  });

  const markUnsubscribe = trpc.compliance.markUnsubscribe.useMutation({
    onSuccess: (result) => {
      if (result.alreadySuppressed) {
        toast.info(`${result.leadName ?? "Lead"} was already suppressed`);
      } else {
        toast.success(`${result.leadName ?? "Lead"} moved to Trash — opt-out tag added, removed from all automation`);
      }
      // Advance to next lead
      handleSkip();
    },
    onError: (err) => {
      toast.error(`Unsubscribe failed: ${err.message}`);
    },
  });

  const handleMarkUnsubscribe = (lead: PendingLead) => {
    if (!window.confirm(`Mark ${lead.name} as unsubscribed? This will move them to Trash in FUB and remove them from all automation. This cannot be undone.`)) return;
    const agentName = getAgentDisplayName() ?? undefined;
    markUnsubscribe.mutate({
      personId: lead.id,
      leadName: lead.name,
      agentName,
      reason: "agent_marked",
    });
  };

  // Daily SMS goal tracker — fetch today's count for the current agent
  const agentDisplayName = getAgentDisplayName();
  const { data: dailyGoalData } = trpc.leads.getDailySmsGoal.useQuery(
    { agentName: agentDisplayName || "all" },
    {
      enabled: !!agentDisplayName,
      staleTime: 60 * 1000, // refresh every 60s
      refetchInterval: 60 * 1000,
    }
  );

  const draftSmsMutation = trpc.ai.draftSms.useMutation();

  useEffect(() => {
    localStorage.setItem("fub_power_queue_texted", JSON.stringify(textedLeads));
  }, [textedLeads]);

  // Merge DB-sourced texted IDs into local state (DB is source of truth on load)
  useEffect(() => {
    if (!dbTextedData?.ids?.length) return;
    setTextedLeads(prev => {
      const merged = { ...prev };
      let changed = false;
      for (const id of dbTextedData.ids) {
        if (!merged[id]) { merged[id] = true; changed = true; }
      }
      return changed ? merged : prev;
    });
  }, [dbTextedData]);

  // Update the "Updated X ago" label every 30 seconds
  useEffect(() => {
    if (dataUpdatedAt) setLastRefreshedAt(new Date(dataUpdatedAt));
  }, [dataUpdatedAt]);

  useEffect(() => {
    const update = () => {
      if (!lastRefreshedAt) return;
      const diffMs = Date.now() - lastRefreshedAt.getTime();
      const diffMin = Math.floor(diffMs / 60000);
      const diffSec = Math.floor(diffMs / 1000);
      if (diffSec < 60) setLastRefreshedLabel("just now");
      else if (diffMin === 1) setLastRefreshedLabel("1 min ago");
      else setLastRefreshedLabel(`${diffMin} min ago`);
    };
    update();
    const interval = setInterval(update, 30000);
    return () => clearInterval(interval);
  }, [lastRefreshedAt]);

  useEffect(() => {
    setCurrentIndex(0);
  }, [selectedAgent, searchQuery]);

  const uniqueAgents = useMemo(() => {
    const liveAgents = leads
      .map(l => l.assigned_agent)
      .filter(a => a && !EXCLUDED_AGENT_NAMES.has(a.toLowerCase()));
    const merged = Array.from(new Set([...ROSTER_AGENT_NAMES, ...liveAgents]));
    return merged.filter(Boolean);
  }, [leads]);

  const filteredLeads = useMemo(() => leads.filter(lead => {
    // Never show snoozed leads (hidden for today via sessionStorage)
    if (snoozedLeads.has(lead.id)) return false;
    const agentLower = lead.assigned_agent.toLowerCase();
    let matchesAgent: boolean;
    if (lockedAgent) {
      // Agent is locked via ?agent= URL param — ALWAYS filter to only that agent's leads.
      // This applies in both normal mode AND Free Pick mode.
      // Free Pick only unlocks the 1-13 day tier within the agent's OWN leads.
      matchesAgent = agentLower === lockedAgent.toLowerCase();
    } else if (freePick) {
      // Free Pick (admin/no lock): show all agents' leads including 1-13 day tier.
      matchesAgent = true;
    } else {
      matchesAgent =
        selectedAgent === "all" ||
        agentLower === selectedAgent.toLowerCase();
    }
    const matchesSearch =
      lead.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.phone.includes(searchQuery) ||
      lead.city.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesAgent && matchesSearch;
  }), [leads, selectedAgent, searchQuery, freePick, snoozedLeads, lockedAgent]);

  const agentStats = useMemo(() => {
    const stats: Record<string, { total: number; texted: number }> = {};
    ROSTER_AGENT_NAMES.forEach(name => { stats[name] = { total: 0, texted: 0 }; });
    leads.forEach(lead => {
      const agent = lead.assigned_agent || "Unknown";
      if (EXCLUDED_AGENT_NAMES.has(agent.toLowerCase())) return;
      if (!stats[agent]) stats[agent] = { total: 0, texted: 0 };
      stats[agent].total++;
      if (textedLeads[lead.id]) stats[agent].texted++;
    });
    return Object.entries(stats)
      .map(([agent, s]) => ({
        agent,
        total: s.total,
        texted: s.texted,
        rate: s.total > 0 ? Math.round((s.texted / s.total) * 100) : 0,
      }))
      .sort((a, b) => b.rate - a.rate || a.agent.localeCompare(b.agent));
  }, [leads, textedLeads]);

  const totalTexted = Object.keys(textedLeads).filter(id =>
    leads.some(l => l.id === Number(id))
  ).length;
  const completionRate = leads.length > 0 ? Math.round((totalTexted / leads.length) * 100) : 0;

  const heatColor = (rate: number) => {
    if (rate === 0) return "bg-white/8 text-white/40";
    if (rate < 25) return "bg-amber-50 text-amber-600 border-amber-200";
    if (rate < 50) return "bg-amber-100 text-amber-700 border-amber-300";
    if (rate < 75) return "bg-orange-100 text-orange-700 border-orange-300";
    return "bg-emerald-100 text-emerald-700 border-emerald-300";
  };

  const generateDraft = async (lead: PendingLead) => {
    if (draftMessages[lead.id]) return;
    setGeneratingFor(lead.id);
    try {
      const result = await draftSmsMutation.mutateAsync({
        leadName: lead.name.split(" ")[0],
        leadCity: lead.city,
        daysStale: lead.days_stale,
        assignedAgent: lead.assigned_agent,
        notes: lead.notes,
      });
      setDraftMessages(prev => ({ ...prev, [lead.id]: result.draft }));
    } catch {
      setDraftMessages(prev => ({ ...prev, [lead.id]: lead.sms_body }));
    } finally {
      setGeneratingFor(null);
    }
  };

  const activeLead = filteredLeads[currentIndex] ?? null;
  const prevActiveIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (activeLead && activeLead.id !== prevActiveIdRef.current) {
      prevActiveIdRef.current = activeLead.id;
      generateDraft(activeLead);
    }
  }, [activeLead?.id]);

  const handleSend = (lead: PendingLead) => {
    const messageBody = draftMessages[lead.id] || lead.sms_body;
    logSentNote.mutate({
      personId: lead.id,
      agentName: lead.assigned_agent,
      messageBody,
    });
    setTextedLeads(prev => ({ ...prev, [lead.id]: true }));
    const phone = lead.phone.replace(/\D/g, "");
    const isApple = /iPhone|iPad|iPod|Macintosh/i.test(navigator.userAgent);
    const cleanPhone = phone.startsWith("+") || phone.length > 10 ? phone : (phone.length === 10 ? "+1" + phone : phone);
    const smsLink = isApple
      ? `sms:${cleanPhone}&body=${encodeURIComponent(messageBody)}`
      : `sms:${cleanPhone}?body=${encodeURIComponent(messageBody)}`;
    window.location.href = smsLink;
    setTimeout(() => {
      // Use a functional update to get the latest textedLeads state (avoids stale closure)
      setCurrentIndex(prev => {
        const justTextedId = lead.id;
        // Find next untexted lead after current position
        const nextIdx = filteredLeads.findIndex((l, i) => i > prev && l.id !== justTextedId && !textedLeads[l.id]);
        if (nextIdx !== -1) return nextIdx;
        // Wrap around from start
        const fromStart = filteredLeads.findIndex((l, i) => i !== prev && l.id !== justTextedId && !textedLeads[l.id]);
        return fromStart !== -1 ? fromStart : filteredLeads.length;
      });
    }, 600);
  };

  const handleSkip = () => {
    const next = currentIndex + 1;
    setCurrentIndex(next < filteredLeads.length ? next : filteredLeads.length);
  };

  const handleSnooze = (lead: PendingLead) => {
    setSnoozedLeads(prev => {
      const next = new Set(prev);
      next.add(lead.id);
      try { sessionStorage.setItem("fub_snoozed_leads", JSON.stringify(Array.from(next))); } catch { /* ignore */ }
      return next;
    });
    // Advance to next untexted, unsnoozed lead
    setCurrentIndex(prev => {
      const nextIdx = filteredLeads.findIndex((l, i) => i > prev && l.id !== lead.id && !textedLeads[l.id]);
      if (nextIdx !== -1) return nextIdx;
      const fromStart = filteredLeads.findIndex((l, i) => i !== prev && l.id !== lead.id && !textedLeads[l.id]);
      return fromStart !== -1 ? fromStart : filteredLeads.length;
    });
    toast.info(`${lead.name.split(" ")[0]} snoozed — back tomorrow.`, { duration: 2500 });
  };

  const handleCall = (lead: PendingLead) => {
    // Log a "Call attempted" note to FUB before opening the dialer
    logSentNote.mutate({
      personId: lead.id,
      agentName: lead.assigned_agent,
      channel: "call" as const,
    });
    const phone = lead.phone.replace(/\D/g, "");
    const cleanPhone = phone.startsWith("+") || phone.length > 10 ? phone : (phone.length === 10 ? "+1" + phone : phone);
    window.location.href = `tel:${cleanPhone}`;
    toast.success(`Calling ${lead.name.split(" ")[0]}\u2026 FUB note logged.`, { duration: 2500 });
  };

  const handleUnsnoozeAll = () => {
    setSnoozedLeads(new Set<number>());
    try { sessionStorage.removeItem("fub_snoozed_leads"); } catch { /* ignore */ }
    toast.success("All snoozed leads restored.", { duration: 2000 });
  };

  const handleJumpToPriority = () => {
    const firstPriorityIdx = filteredLeads.findIndex(l => l.is_priority && !textedLeads[l.id]);
    if (firstPriorityIdx === -1) {
      toast.info("No untexted priority leads left.", { duration: 2000 });
      return;
    }
    setCurrentIndex(firstPriorityIdx);
    toast.success("🔥 Jumped to priority lead!", { duration: 2000 });
  };

  const handleResetQueue = () => {
    setTextedLeads({});
    setCurrentIndex(0);
    localStorage.removeItem("fub_power_queue_texted");
    toast.info("Queue progress reset.");
  };

  if (queueLoading) {
    return (
      <div className="min-h-screen bg-background font-sans antialiased">
        {/* Skeleton header */}
        <header className="sticky top-0 z-40 bg-card border-b border-white/10">
          <div className="container max-w-2xl px-4 h-14 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-xl bg-amber-500 animate-pulse" />
              <div className="space-y-1.5">
                <div className="h-3.5 w-28 bg-card/8 rounded animate-pulse" />
                <div className="h-2.5 w-40 bg-card/8 rounded animate-pulse" />
              </div>
            </div>
            <div className="h-8 w-8 rounded-full bg-white/8 animate-pulse" />
          </div>
        </header>
        <main className="container max-w-2xl px-4 py-6 space-y-5">
          {/* Progress bar skeleton */}
          <div className="space-y-1.5">
            <div className="flex justify-between">
              <div className="h-3 w-24 bg-card/8 rounded animate-pulse" />
              <div className="h-3 w-20 bg-card/8 rounded animate-pulse" />
            </div>
            <div className="h-2 bg-card/8 rounded-full animate-pulse" />
          </div>
          {/* Stat cards skeleton */}
          <div className="grid grid-cols-3 gap-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-card/5 border border-white/8 rounded-xl p-3 space-y-1.5">
                <div className="h-6 w-10 bg-card/8 rounded animate-pulse" />
                <div className="h-2.5 w-14 bg-card/8 rounded animate-pulse" />
              </div>
            ))}
          </div>
          {/* Lead card skeleton */}
          <div className="bg-card border border-white/8 rounded-2xl p-5 space-y-4">
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <div className="h-6 w-32 bg-card/8 rounded animate-pulse" />
                <div className="flex gap-2">
                  <div className="h-5 w-20 bg-card/8 rounded-full animate-pulse" />
                  <div className="h-5 w-16 bg-card/8 rounded-full animate-pulse" />
                </div>
              </div>
              <div className="h-10 w-10 rounded-full bg-white/8 animate-pulse" />
            </div>
            <div className="flex gap-4">
              <div className="h-3 w-28 bg-card/8 rounded animate-pulse" />
              <div className="h-3 w-20 bg-card/8 rounded animate-pulse" />
              <div className="h-3 w-24 bg-card/8 rounded animate-pulse" />
            </div>
            {/* FUB notes skeleton */}
            <div className="bg-card/4 rounded-xl p-3 space-y-2">
              <div className="h-2.5 w-20 bg-card/8 rounded animate-pulse" />
              <div className="h-3 w-full bg-card/8 rounded animate-pulse" />
              <div className="h-3 w-4/5 bg-card/8 rounded animate-pulse" />
            </div>
            {/* AI message skeleton */}
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 space-y-2">
              <div className="h-3 w-32 bg-amber-100 rounded animate-pulse" />
              <div className="h-3 w-full bg-amber-100 rounded animate-pulse" />
              <div className="h-3 w-3/4 bg-amber-100 rounded animate-pulse" />
              <div className="h-3 w-5/6 bg-amber-100 rounded animate-pulse" />
            </div>
            {/* Action buttons skeleton */}
            <div className="space-y-2">
              <div className="h-12 w-full bg-amber-100 rounded-xl animate-pulse" />
              <div className="grid grid-cols-3 gap-2">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="h-10 bg-white/8 rounded-xl animate-pulse" />
                ))}
              </div>
            </div>
          </div>
          {/* Up next skeleton */}
          <div className="space-y-2">
            <div className="h-3 w-16 bg-card/8 rounded animate-pulse" />
            {[...Array(2)].map((_, i) => (
              <div key={i} className="bg-card/5 border border-white/8 rounded-xl p-3 flex items-center gap-3">
                <div className="h-8 w-8 rounded-full bg-white/8 animate-pulse" />
                <div className="space-y-1.5">
                  <div className="h-3 w-28 bg-card/8 rounded animate-pulse" />
                  <div className="h-2.5 w-20 bg-card/8 rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>
    );
  }

  if (queueError) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="bg-card border border-white/8 p-8 max-w-sm text-center space-y-3">
          <p className="text-sm font-semibold text-red-400">Failed to load queue</p>
          <p className="text-xs text-slate-400">{queueError.message}</p>
          <Button onClick={() => refetch()} size="sm" variant="outline" className="border-white/15 text-white/60">Retry</Button>
        </Card>
      </div>
    );
  }

  const untextedCount = filteredLeads.filter(l => !textedLeads[l.id]).length;
  // isDone only triggers when NOT in Free Pick mode (Free Pick has no "done" state)
  const isDone = !freePick && filteredLeads.length > 0 && (currentIndex >= filteredLeads.length || untextedCount === 0);
  // Priority leads (14–20 days) are sorted first by the server
  const priorityCount = filteredLeads.filter(l => l.is_priority && !textedLeads[l.id]).length;
  const availableCount = filteredLeads.filter(l => !l.is_priority && !textedLeads[l.id]).length;
  // Whether the current lead is NOT priority (so Jump to Priority makes sense)
  const currentLeadIsPriority = filteredLeads[currentIndex]?.is_priority ?? false;

  const handleEnterFreePick = () => {
    setFreePick(true);
    setCurrentIndex(0);
    // Jump to the first non-priority (1-13 day) lead
    const firstAvailableIdx = filteredLeads.findIndex(l => !l.is_priority && !textedLeads[l.id]);
    if (firstAvailableIdx !== -1) setCurrentIndex(firstAvailableIdx);
    toast.success(`Keep going — texting your day 1–13 leads now!`, { duration: 3000 });
  };

  const handleExitFreePick = () => {
    setFreePick(false);
    setSelectedAgent(originalAgentRef.current);
    setCurrentIndex(0);
    toast.info("Back to your assigned queue.", { duration: 2000 });
  };

  const dismissInstallBanner = () => {
    sessionStorage.setItem("pwa_banner_dismissed", "1");
    setShowInstallBanner(false);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* ── iOS Install Banner ── */}
      {showInstallBanner && (
        <div className="bg-card border-b border-amber-500/15 px-4 py-2.5">
          <div className="container max-w-2xl flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Share className="h-4 w-4 text-amber-600 shrink-0" />
              <p className="text-xs text-slate-600">
                <span className="font-semibold text-amber-700">Add to Home Screen</span>
                {" — tap "}
                <span className="font-mono bg-card/8 px-1 py-0.5 rounded text-[10px]">Share</span>
                {" then "}
                <span className="font-mono bg-card/8 px-1 py-0.5 rounded text-[10px]">Add to Home Screen</span>
                {" for the best experience."}
              </p>
            </div>
            <button
              onClick={dismissInstallBanner}
              className="text-slate-400 hover:text-slate-600 transition-colors shrink-0"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <header className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b border-white/10 px-4 py-3">
        <div className="container max-w-2xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-500 to-yellow-600 flex items-center justify-center shadow-sm">
              <MessageSquare className="h-4 w-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-foreground tracking-tight">Power Queue</h1>
              <p className="text-[10px] text-slate-400 tracking-wide">Tap-to-Text Outbox</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Back to Bot Dashboard */}
            <a
              href="https://lifestyledash-wpnl8v84.manus.space"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium text-amber-500 bg-amber-50 hover:bg-amber-500/10 border border-amber-200 hover:border-amber-300 transition-all duration-150"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Bot Dashboard
            </a>
            <div className="hidden sm:flex flex-col items-end gap-0.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                className="h-8 gap-1.5 text-xs text-white/50 border-white/10 bg-white/4 hover:bg-white/8 hover:text-slate-700"
              >
                <Loader2 className="h-3.5 w-3.5" />
                Refresh
              </Button>
              {lastRefreshedLabel && (
                <span className="text-[9px] text-slate-300 font-mono">Updated {lastRefreshedLabel}</span>
              )}
            </div>
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-amber-500 to-yellow-600 text-white flex items-center justify-center text-xs font-bold font-mono shadow-sm">
              {completionRate}%
            </div>
          </div>
        </div>
      </header>

        {/* ── Free Pick Banner ── */}
        {freePick && (
          <div className="relative overflow-hidden bg-gradient-to-r from-slate-50 via-white to-slate-50 border-b border-emerald-200">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(16,185,129,0.06)_0%,transparent_70%)] pointer-events-none" />
            <div className="container max-w-2xl px-4 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-full bg-emerald-100 flex items-center justify-center">
                  <Unlock className="h-4 w-4 text-emerald-600" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-emerald-700">Day 1–13 Leads</span>
                    <Badge className="bg-emerald-100 text-emerald-600 border-none text-[9px] px-1.5 py-0 font-semibold">YOUR LEADS</Badge>
                  </div>
                  <p className="text-[10px] text-slate-400">Priority done — now texting your day 1–13 leads</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExitFreePick}
                className="h-7 gap-1.5 text-xs text-white/50 border-white/10 bg-white/4 hover:bg-white/8 hover:text-slate-700"
              >
                <ArrowLeft className="h-3 w-3" />
                My Queue
              </Button>
            </div>
            <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-emerald-500/20 to-transparent" />
          </div>
        )}

        {/* ── Agent Hero Banner ── */}
        {!freePick && getAgentDisplayName() && (
        <div className="relative overflow-hidden bg-gradient-to-r from-slate-50 via-white to-slate-50 border-b border-amber-100">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(245,158,11,0.06)_0%,transparent_70%)] pointer-events-none" />
          <div className="container max-w-2xl px-4 py-5 flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-[10px] font-light tracking-[0.3em] text-amber-500 uppercase">Your leads for today</p>
              <h2 className="text-xl font-light text-white tracking-wide">
                Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"},{" "}
                <span className="font-semibold text-amber-700">{getAgentDisplayName()}</span>
              </h2>
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                <span className="text-[10px] text-amber-500 font-mono tracking-wider uppercase">Live Queue</span>
              </div>
            </div>
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-amber-500/20 to-transparent" />
          </div>
        )}

      <main className="container max-w-2xl px-4 py-6 space-y-5">
        {/* ── Progress Bar ── */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">{totalTexted} of {filteredLeads.length} texted</span>
            <span className="text-slate-500">{untextedCount} remaining</span>
          </div>
          <div className="h-2 bg-white/8 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-amber-500 to-emerald-500 rounded-full transition-all duration-500"
              style={{ width: `${completionRate}%` }}
            />
          </div>
        </div>

        {/* ── Quick Stats ── */}
        <div className={`grid gap-3 ${agentDisplayName && dailyGoalData ? 'grid-cols-4' : 'grid-cols-3'}`}>
          <div className="bg-white/4 border border-white/10 rounded-xl p-3 text-center">
            {priorityCount > 0 ? (
              <>
                <div className="text-lg font-bold text-red-400 leading-tight">{priorityCount}</div>
                <div className="text-[9px] text-red-500 font-semibold uppercase tracking-wider">🔥 Priority</div>
                {availableCount > 0 && (
                  <div className="text-[9px] text-slate-300 mt-0.5">+{availableCount} avail</div>
                )}
              </>
            ) : (
              <>
                <div className="text-2xl font-bold text-foreground">{filteredLeads.length}</div>
                <div className="text-[10px] text-slate-400 uppercase tracking-wider mt-0.5">Total</div>
              </>
            )}
          </div>
          <div className="bg-white/4 border border-white/10 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-emerald-600">{totalTexted}</div>
            <div className="text-[10px] text-slate-400 uppercase tracking-wider mt-0.5">Texted</div>
          </div>
          <div className="bg-white/4 border border-white/10 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-amber-600">{untextedCount}</div>
            <div className="text-[10px] text-slate-400 uppercase tracking-wider mt-0.5">Remaining</div>
          </div>
          {agentDisplayName && dailyGoalData && (
            <div className="bg-white/4 border border-white/10 rounded-xl p-3 text-center relative overflow-hidden">
              {/* SVG progress ring */}
              <div className="relative flex items-center justify-center mx-auto" style={{ width: 44, height: 44 }}>
                <svg width="44" height="44" className="-rotate-90" viewBox="0 0 44 44">
                  <circle cx="22" cy="22" r="18" fill="none" stroke="#E4E7EF" strokeWidth="4" />
                  <circle
                    cx="22" cy="22" r="18" fill="none"
                    stroke={dailyGoalData.pct >= 100 ? "#34d399" : "#f59e0b"}
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeDasharray={`${2 * Math.PI * 18}`}
                    strokeDashoffset={`${2 * Math.PI * 18 * (1 - dailyGoalData.pct / 100)}`}
                    style={{ transition: 'stroke-dashoffset 0.5s cubic-bezier(0.23,1,0.32,1)' }}
                  />
                </svg>
                <span className="absolute text-[11px] font-bold" style={{ color: dailyGoalData.pct >= 100 ? '#34d399' : '#f59e0b' }}>
                  {dailyGoalData.todayCount}
                </span>
              </div>
              <div className="text-[10px] text-slate-400 uppercase tracking-wider mt-0.5">
                Goal {dailyGoalData.goal}
              </div>
              {dailyGoalData.pct >= 100 && (
                <div className="absolute top-1 right-1 text-[9px] text-emerald-600">✓</div>
              )}
            </div>
          )}
        </div>

        {/* ── Agent Heat Chart / Personal Progress Bar ── */}
        {lockedAgent ? (
          // — CHANGE 3: Personal progress bar for locked agents —
          (() => {
            const myStats = agentStats.find(s => s.agent.toLowerCase() === lockedAgent.toLowerCase());
            const myTotal = myStats?.total ?? filteredLeads.length;
            const myTexted = myStats?.texted ?? Object.keys(textedLeads).filter(id => filteredLeads.some(l => l.id === Number(id))).length;
            const myRate = myTotal > 0 ? Math.round((myTexted / myTotal) * 100) : 0;
            const displayName = lockedAgent.charAt(0).toUpperCase() + lockedAgent.slice(1).toLowerCase();
            return (
              <Card className="bg-white/4 border-white/10">
                <CardContent className="px-5 py-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Target className="h-4 w-4 text-amber-600" />
                      <span className="text-sm font-semibold text-slate-700">{displayName}</span>
                      <span className="text-xs text-slate-400">— Today's Progress</span>
                    </div>
                    <span className="text-lg font-black text-amber-600">{myRate}%</span>
                  </div>
                  <div className="h-2 w-full bg-white/8 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${myRate}%`,
                        background: myRate >= 100 ? '#34d399' : myRate >= 50 ? '#f59e0b' : '#fb923c',
                      }}
                    />
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1.5">
                    {myTexted} of {myTotal} texted today
                    {myTotal === 0 ? " — queue loading…" : myRate >= 100 ? " — Daily goal complete! 🎉" : ` — ${myTotal - myTexted} remaining`}
                  </p>
                </CardContent>
              </Card>
            );
          })()
        ) : agentStats.length > 0 && (
          <Card className="bg-white/4 border-white/10">
            <CardHeader className="pb-3 pt-4 px-5">
              <CardTitle className="text-sm font-semibold text-slate-600 flex items-center gap-2">
                <Flame className="h-4 w-4 text-orange-400" />
                Agent Outreach Heat Chart
                <span className="text-[10px] font-normal text-slate-400 ml-1">— updates as texts are sent</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {agentStats.map(({ agent, total, texted, rate }) => (
                  <div key={agent} className={`rounded-lg border px-3 py-2.5 flex flex-col gap-1 ${heatColor(rate)}`}>
                    <span className="text-[11px] font-bold truncate">{agent}</span>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] opacity-70">{texted}/{total}</span>
                      <span className="text-sm font-black">{rate}%</span>
                    </div>
                    <div className="h-1 w-full bg-black/10 rounded-full overflow-hidden">
                      <div className="h-full bg-current rounded-full transition-all duration-500" style={{ width: `${rate}%`, opacity: 0.6 }} />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Filter Controls ── */}
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              placeholder="Search by name, city…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-10 border-white/10 bg-white/4 text-white/80 placeholder:text-white/30 focus-visible:ring-amber-500/40"
            />
          </div>
          {/* — CHANGE 1: Lock dropdown when ?agent= is in URL — */}
          {lockedAgent ? (
            <div className="w-full sm:w-44 h-10 flex items-center gap-2 px-3 rounded-lg border border-amber-500/30 bg-amber-50 cursor-not-allowed select-none">
              <Lock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
              <span className="text-sm font-semibold text-amber-700 truncate">
                {lockedAgent.charAt(0).toUpperCase() + lockedAgent.slice(1).toLowerCase()}'s Leads Only
              </span>
            </div>
          ) : (
            <div className="w-full sm:w-44">
              <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                <SelectTrigger className="h-10 border-white/10 bg-white/4 text-white/70 focus:ring-amber-500/40">
                  <Filter className="h-3.5 w-3.5 mr-2 text-slate-400" />
                  <SelectValue placeholder="Filter by Agent" />
                </SelectTrigger>
                <SelectContent className="bg-card border-white/10 text-slate-700">
                  <SelectItem value="all">All Agents</SelectItem>
                  {uniqueAgents.map((agent, idx) => (
                    <SelectItem key={idx} value={agent.toLowerCase()}>{agent}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {/* Reset button removed — agents must never accidentally re-text leads they already texted today */}
          {snoozedLeads.size > 0 && (
            <button
              onClick={handleUnsnoozeAll}
              title="Click to restore all snoozed leads"
              className="flex items-center gap-1.5 text-xs text-amber-500 hover:text-amber-700 bg-amber-500/10 hover:bg-amber-100 border border-amber-200 rounded-md px-2.5 py-1.5 transition-colors"
            >
              <Clock className="h-3 w-3" />
              {snoozedLeads.size} snoozed
            </button>
          )}
        </div>

        {/* ── Conveyor Belt ── */}
        {filteredLeads.length === 0 ? (
          <Card className="bg-gradient-to-b from-emerald-50 to-[#F8F9FC] border-emerald-200 py-14 text-center">
            <div className="max-w-sm mx-auto space-y-4">
              {/* Animated checkmark circle */}
              <div className="relative h-16 w-16 mx-auto">
                <div className="absolute inset-0 rounded-full bg-emerald-100 animate-ping opacity-30" />
                <div className="relative h-16 w-16 rounded-full bg-emerald-100 flex items-center justify-center ring-2 ring-emerald-400/30">
                  <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                </div>
              </div>
              <div className="space-y-1.5">
                <h3 className="text-lg font-bold text-foreground">
                  {lockedAgent
                    ? `You're all caught up, ${lockedAgent.charAt(0).toUpperCase() + lockedAgent.slice(1)}! 🎉`
                    : searchQuery
                    ? "No leads match your search"
                    : "You're all caught up! 🎉"}
                </h3>
                <p className="text-sm text-slate-500">
                  {searchQuery
                    ? "Try a different name or city."
                    : "No stale leads in the 1–20 day window right now. Check back tomorrow or hit Refresh to pull the latest from FUB."}
                </p>
              </div>
              {!searchQuery && (
                <Button
                  onClick={() => refetch()}
                  variant="outline"
                  size="sm"
                  className="border-emerald-300 text-emerald-700 hover:bg-emerald-50 gap-2"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh Queue
                </Button>
              )}
            </div>
          </Card>
        ) : isDone ? (
          <Card className="bg-gradient-to-b from-emerald-950/40 to-[#F8F9FC] border-emerald-200 py-12 text-center">
            <div className="max-w-sm mx-auto space-y-5">
              <div className="h-16 w-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto ring-2 ring-emerald-500/30">
                <CheckCircle2 className="h-8 w-8 text-emerald-600" />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-xl font-bold text-foreground">Your Queue is Done! 🎉</h3>
                <p className="text-sm text-slate-500">
                  You texted {totalTexted} lead{totalTexted !== 1 ? "s" : ""} today. Great work!
                </p>
              </div>
              <div className="flex flex-col gap-2.5 pt-1">
                {availableCount > 0 && (
                  <>
                    <Button
                      onClick={handleEnterFreePick}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold gap-2"
                    >
                      <Unlock className="h-4 w-4" />
                      Keep Going — Text Day 1–13 Leads
                    </Button>
                    <p className="text-[10px] text-slate-400">{availableCount} of your leads from the last 1–13 days are ready</p>
                  </>
                )}
                {/* Reset & Start Over removed — texted leads persist in DB and must not be wiped */}
              </div>
            </div>
          </Card>
        ) : (
          (() => {
            const lead = filteredLeads[currentIndex];
            if (!lead) return null;
            const isTexted = textedLeads[lead.id];
            const draft = draftMessages[lead.id] ?? "";
            const isGenerating = generatingFor === lead.id;

            return (
              <div className="space-y-3">
                {/* Priority section label */}
                {freePick && (
                  <div className="flex items-center gap-2 text-[11px]">
                    {lead.is_priority ? (
                      <span className="flex items-center gap-1.5 text-red-400 font-semibold">
                        <span className="h-1.5 w-1.5 rounded-full bg-red-400 animate-pulse" />
                        🔥 Priority Lead — {lead.days_stale} days untouched
                      </span>
                    ) : (
                      <span className="text-slate-400">Day {lead.days_stale} — Available Lead</span>
                    )}
                  </div>
                )}
                {/* Jump to Priority button — shown in Free Pick when current lead is NOT priority and priority leads exist */}
                {freePick && !currentLeadIsPriority && priorityCount > 0 && (
                  <button
                    onClick={handleJumpToPriority}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-red-50 border border-red-200 text-red-600 text-xs font-semibold hover:bg-red-100 transition-colors active:scale-[0.98]"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-red-400 animate-pulse" />
                    🔥 Jump to Priority ({priorityCount} lead{priorityCount !== 1 ? "s" : ""} waiting)
                  </button>
                )}
                {/* Position dots */}
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>Lead {currentIndex + 1} of {filteredLeads.length}</span>
                  <div className="flex items-center gap-1">
                    {filteredLeads.map((l, i) => (
                      <button
                        key={l.id}
                        onClick={() => setCurrentIndex(i)}
                        title={l.is_priority ? `🔥 ${l.name} — ${l.days_stale}d priority` : l.name}
                        className={`h-1.5 rounded-full transition-all duration-200 ${
                          i === currentIndex
                            ? "w-4 bg-amber-400"
                            : textedLeads[l.id]
                            ? "w-1.5 bg-emerald-500/60"
                            : l.is_priority
                            ? "w-1.5 bg-red-500/70 hover:bg-red-400"
                            : "w-1.5 bg-slate-200 hover:bg-slate-300"
                        }`}
                      />
                    ))}
                  </div>
                </div>

                {/* ── Active Lead Card ── */}
                <Card className={`bg-[#141210] border transition-all duration-300 ${
                  isTexted ? "border-emerald-500/30" : "border-amber-200 shadow-[0_0_30px_rgba(212,175,55,0.08)]"
                }`}>
                  <div className="p-5 space-y-5">
                    {/* Lead header */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
                            {lead.name}
                            {isTexted && (
                              <Badge className="bg-emerald-100 text-emerald-600 border-none text-[10px] flex items-center gap-1">
                                <CheckCircle2 className="h-3 w-3" /> Texted
                              </Badge>
                            )}
                          </h2>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="outline" className="bg-white/4 text-white/50 border-white/10 text-[10px]">
                            {lead.stage}
                          </Badge>
                          <Badge className="bg-white/8 text-white/60 hover:bg-white/12 text-[10px]">
                            {lead.assigned_agent}
                          </Badge>
                          {lead.is_priority ? (
                            <Badge className="bg-red-50 text-red-600 border border-red-200 text-[10px] flex items-center gap-1">
                              🔥 Day {lead.days_stale} — Priority
                            </Badge>
                          ) : (
                            <Badge className="bg-white/8 text-white/50 border border-white/10 text-[10px]">
                              Day {lead.days_stale} — Available
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex-shrink-0 h-12 w-12 rounded-full bg-gradient-to-br from-amber-500/20 to-amber-600/10 border border-amber-200 flex items-center justify-center">
                        <User className="h-5 w-5 text-amber-600/70" />
                      </div>
                    </div>

                    {/* Lead details */}
                    <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-slate-400">
                      <div className="flex items-center gap-1.5">
                        <Phone className="h-3.5 w-3.5 text-slate-300" />
                        <span className="text-slate-500">{lead.phone}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <MapPin className="h-3.5 w-3.5 text-slate-300" />
                        <span>{lead.city}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 text-slate-300" />
                        <span>Untouched {lead.days_stale}d</span>
                      </div>
                      {lead.last_contacted_days !== undefined && (
                        <div className={`flex items-center gap-1.5 font-medium ${
                          lead.last_contacted_days === 0 ? "text-emerald-500" :
                          lead.last_contacted_days <= 3 ? "text-emerald-500" :
                          lead.last_contacted_days <= 7 ? "text-amber-600" :
                          "text-red-400"
                        }`}>
                          <Clock className="h-3.5 w-3.5" />
                          <span>
                            {lead.last_contacted_days < 0
                              ? "Never contacted"
                              : lead.last_contacted_days === 0
                              ? "Touched today"
                              : `Last touched ${lead.last_contacted_days}d ago`}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Notes preview */}
                    {lead.notes && (
                      <div className="bg-white/4 border border-white/10 rounded-lg p-3 text-xs text-white/50 space-y-1">
                        <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-300 block">FUB Notes</span>
                        <p className="line-clamp-3 leading-relaxed">{lead.notes}</p>
                      </div>
                    )}

                    {/* ── Inline Copilot Draft ── */}
                    <div className="bg-amber-50 border border-amber-500/15 rounded-xl p-4">
                      <InlineCopilotDraft
                        lead={lead}
                        value={draft}
                        onChange={(v) => setDraftMessages(prev => ({ ...prev, [lead.id]: v }))}
                        onGenerate={() => {
                          setDraftMessages(prev => {
                            const next = { ...prev };
                            delete next[lead.id];
                            return next;
                          });
                          generateDraft({ ...lead });
                        }}
                        isGenerating={isGenerating}
                      />
                    </div>

                    {/* ── Action Buttons ── */}
                    <div className="flex flex-col gap-2 pt-1">
                      {/* Row 1: Send Text — full width */}
                      <Button
                        onClick={() => handleSend(lead)}
                        disabled={isGenerating || !draft}
                        className={`w-full h-12 rounded-xl font-bold text-sm flex items-center justify-center gap-2 shadow-lg transition-all duration-200 active:scale-[0.97] ${
                          isTexted
                            ? "bg-emerald-600/80 hover:bg-emerald-600 text-white"
                            : "bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-400 text-white shadow-[0_0_20px_rgba(212,175,55,0.3)]"
                        }`}
                      >
                        <Send className="h-4 w-4" />
                        {isTexted ? "Send Again" : "Send Text Now"}
                      </Button>
                      {/* Row 2: Skip / Snooze / Call / Unsubscribe */}
                      <div className="flex gap-2">
                        <Button
                          onClick={handleSkip}
                          variant="outline"
                          className="flex-1 h-10 rounded-xl border-white/12 text-muted-foreground hover:bg-card/8 hover:text-foreground flex items-center justify-center gap-1.5"
                        >
                          <SkipForward className="h-4 w-4" />
                          <span className="text-xs">Skip</span>
                        </Button>
                        <Button
                          onClick={() => handleSnooze(lead)}
                          variant="outline"
                          title="Hide this lead for today — reappears tomorrow"
                          className="flex-1 h-10 rounded-xl border-white/12 text-muted-foreground hover:bg-[oklch(0.76_0.14_78/10%)] hover:text-[oklch(0.76_0.14_78)] hover:border-[oklch(0.76_0.14_78/30%)] flex items-center justify-center gap-1.5 transition-colors"
                        >
                          <Clock className="h-4 w-4" />
                          <span className="text-xs">Snooze</span>
                        </Button>
                        <Button
                          onClick={() => handleCall(lead)}
                          variant="outline"
                          title="Call this lead instead — logs a note to FUB"
                          className="flex-1 h-10 rounded-xl border-white/12 text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-400 hover:border-emerald-500/30 flex items-center justify-center gap-1.5 transition-colors"
                        >
                          <Phone className="h-4 w-4" />
                          <span className="text-xs">Call</span>
                        </Button>
                        <Button
                          onClick={() => handleMarkUnsubscribe(lead)}
                          variant="outline"
                          title="Mark as unsubscribed — moves to Trash in FUB, removes from all automation"
                          disabled={markUnsubscribe.isPending}
                          className="flex-1 h-10 rounded-xl border-red-500/25 text-red-400 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/40 flex items-center justify-center gap-1.5 transition-colors"
                        >
                          {markUnsubscribe.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserX className="h-4 w-4" />}
                          <span className="text-xs">Unsub</span>
                        </Button>
                      </div>
                    </div>

                    <p className="text-[10px] text-slate-300 text-center">
                      Tap Send → iMessage opens pre-filled → auto-advances to next lead
                    </p>
                  </div>
                </Card>

                {/* ── Up Next preview ── */}
                {filteredLeads.length > 1 && (
                  <div className="space-y-2">
                    <p className="text-[10px] text-slate-300 uppercase tracking-wider font-semibold px-1">Up Next</p>
                    {filteredLeads.slice(currentIndex + 1, currentIndex + 4).map((nextLead, i) => (
                      <button
                        key={nextLead.id}
                        onClick={() => setCurrentIndex(currentIndex + 1 + i)}
                        className="w-full text-left bg-card/[0.03] hover:bg-card/[0.06] border border-white/10 rounded-lg px-4 py-3 flex items-center justify-between transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <div className="h-7 w-7 rounded-full bg-white/8 flex items-center justify-center text-[10px] font-bold text-white/50">
                            {currentIndex + 2 + i}
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-slate-600 flex items-center gap-2">
                              {nextLead.name}
                              {textedLeads[nextLead.id] && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
                            </div>
                            <div className="text-[10px] text-slate-300">{nextLead.city} · {nextLead.days_stale}d stale</div>
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 text-slate-300" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })()
        )}
      </main>

      {/* ── Pond Leads — SMS Only (Peter only) ── */}
      {!lockedAgent && <PondSmsSection />}
    </div>
  );
}

// ─── Pond Leads — SMS Only Section ─────────────────────────────────────────────
// Separate section for pond leads whose email bounced but have a phone.
// Only visible to Peter (admin view, no ?agent= lock).
function PondSmsSection() {
  const { data: pondLeads, isLoading } = trpc.fub.getPondSmsLeads.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const [expandedLead, setExpandedLead] = useState<number | null>(null);
  const [sentPondLeads, setSentPondLeads] = useState<Record<number, boolean>>({});

  if (isLoading) return null; // Don't show skeleton — section is supplementary
  if (!pondLeads || pondLeads.length === 0) return null; // Nothing to show

  const unsent = pondLeads.filter(l => !sentPondLeads[l.id]);
  if (unsent.length === 0) return null;

  const handleSendPondSms = (lead: typeof pondLeads[0]) => {
    setSentPondLeads(prev => ({ ...prev, [lead.id]: true }));
    const phone = lead.phone.replace(/\D/g, "");
    const isApple = /iPhone|iPad|iPod|Macintosh/i.test(navigator.userAgent);
    const cleanPhone = phone.startsWith("+") || phone.length > 10 ? phone : (phone.length === 10 ? "+1" + phone : phone);
    const smsLink = isApple
      ? `sms:${cleanPhone}&body=${encodeURIComponent(lead.sms_body)}`
      : `sms:${cleanPhone}?body=${encodeURIComponent(lead.sms_body)}`;
    window.location.href = smsLink;
    toast.success(`SMS opened for ${lead.name.split(" ")[0]}`, { duration: 2000 });
  };

  return (
    <div className="container max-w-2xl px-4 pb-8 pt-2">
      <Card className="bg-card border border-amber-500/20 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center shadow-sm">
              <AlertTriangle className="h-4 w-4 text-white" />
            </div>
            <div>
              <CardTitle className="text-sm font-bold text-foreground">Pond Leads — SMS Only</CardTitle>
              <p className="text-[10px] text-slate-400">Email bounced · Phone still valid · {unsent.length} need texting</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {unsent.slice(0, 10).map(lead => (
            <div
              key={lead.id}
              className="bg-card/[0.03] border border-white/10 rounded-lg overflow-hidden transition-all duration-200"
            >
              <button
                onClick={() => setExpandedLead(expandedLead === lead.id ? null : lead.id)}
                className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-white/[0.03] transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="h-7 w-7 rounded-full bg-orange-500/15 flex items-center justify-center">
                    <Mail className="h-3.5 w-3.5 text-orange-500" />
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-foreground">{lead.name}</div>
                    <div className="text-[10px] text-slate-400">{lead.days_in_pond}d in pond · {lead.stage}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[9px] border-orange-300 text-orange-600 bg-orange-50">
                    Bad Email
                  </Badge>
                  <ChevronRight className={`h-4 w-4 text-slate-400 transition-transform duration-200 ${expandedLead === lead.id ? "rotate-90" : ""}`} />
                </div>
              </button>

              {expandedLead === lead.id && (
                <div className="px-4 pb-3 space-y-2 border-t border-white/8 pt-2">
                  {lead.notes && (
                    <p className="text-[10px] text-slate-400 line-clamp-2">
                      <span className="font-semibold text-slate-500">Notes:</span> {lead.notes}
                    </p>
                  )}
                  <div className="bg-card/[0.05] border border-white/8 rounded-md p-2">
                    <p className="text-[10px] text-slate-500 mb-1 font-semibold">Suggested text:</p>
                    <p className="text-xs text-foreground">{lead.sms_body}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => handleSendPondSms(lead)}
                      className="h-8 gap-1.5 text-xs bg-gradient-to-r from-amber-500 to-yellow-600 hover:from-amber-600 hover:to-yellow-700 text-white border-0"
                    >
                      <Send className="h-3 w-3" />
                      Text {lead.name.split(" ")[0]}
                    </Button>
                    <a
                      href={`tel:${lead.phone.replace(/\D/g, "")}`}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border border-white/15 text-slate-400 hover:bg-white/[0.05] transition-colors"
                    >
                      <Phone className="h-3 w-3" />
                      Call
                    </a>
                  </div>
                </div>
              )}
            </div>
          ))}
          {unsent.length > 10 && (
            <p className="text-[10px] text-center text-slate-400 pt-1">
              +{unsent.length - 10} more pond leads need texting
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
