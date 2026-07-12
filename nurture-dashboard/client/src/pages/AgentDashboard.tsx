import React, { useState, useMemo } from "react";
import { Badge as BadgeUI } from "@/components/ui/badge";
import { useParams, Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { CopilotSmsDraft } from "@/components/CopilotSmsDraft";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Send, Phone, Clock, RefreshCw, Loader2,
  Flame, Star, Users, ChevronDown, ChevronUp, CheckCircle2,
  AlertTriangle, TrendingUp, Home, Share2, UserX, ShieldCheck, Brain,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentCopilot } from "@/components/AgentCopilot";
import { toast } from "sonner";

// ── Types ─────────────────────────────────────────────────────────────────────
type LeadTier = "do_now" | "hot_prospect" | "your_leads";

interface AgentLead {
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
  tier: LeadTier;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toTitleCase(s: string): string {
  return s.trim().charAt(0).toUpperCase() + s.trim().slice(1).toLowerCase();
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function heatColor(rate: number): string {
  if (rate === 0) return "bg-white/8 text-white/40";
  if (rate < 25) return "bg-amber-50 text-amber-600 border-amber-200";
  if (rate < 50) return "bg-amber-100 text-amber-700 border-amber-300";
  if (rate < 75) return "bg-orange-100 text-orange-700 border-orange-300";
  return "bg-emerald-100 text-emerald-700 border-emerald-300";
}

// ── Tier config ───────────────────────────────────────────────────────────────
const TIER_CONFIG: Record<
  LeadTier,
  { label: string; emoji: string; description: string; color: string; badgeClass: string; icon: React.ReactNode }
> = {
  do_now: {
    label: "Do Now",
    emoji: "🔴",
    description: "14+ days untouched — at risk of pond reassignment. Reach out today.",
    color: "border-red-500/20 bg-red-950/15",
    badgeClass: "bg-red-500/15 text-red-400 border-red-500/25",
    icon: <AlertTriangle className="h-4 w-4 text-red-400" />,
  },
  hot_prospect: {
    label: "Hot Prospects",
    emoji: "🟡",
    description: "Stage: Hot Prospect — high intent, prioritize these leads.",
    color: "border-amber-200 bg-amber-50/30",
    badgeClass: "bg-[oklch(0.76_0.14_78/15%)] text-[oklch(0.76_0.14_78)] border-[oklch(0.76_0.14_78/25%)]",
    icon: <Star className="h-4 w-4 text-[oklch(0.76_0.14_78)]" />,
  },
  your_leads: {
    label: "Your Leads",
    emoji: "🟢",
    description: "All other leads assigned to you.",
    color: "border-white/8 bg-card",
    badgeClass: "bg-card/8 text-foreground/70 border-white/12",
    icon: <Users className="h-4 w-4 text-muted-foreground" />,
  },
};

// ── Lead Card ─────────────────────────────────────────────────────────────────
interface LeadCardProps {
  lead: AgentLead;
  isTexted: boolean;
  onText: (lead: AgentLead, customBody?: string) => void;
}

function LeadCard({ lead, isTexted, onText }: LeadCardProps) {
  const tier = TIER_CONFIG[lead.tier];
  return (
    <Card
      className={`border shadow-sm transition-all duration-300 hover:shadow-md overflow-hidden ${
        isTexted ? "border-emerald-500/15 bg-emerald-950/10 opacity-75" : tier.color
      }`}
    >
      <div className="p-5 flex flex-col md:flex-row md:items-start justify-between gap-5">
        {/* Lead info */}
        <div className="space-y-3 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h3 className="text-base font-bold text-foreground flex items-center gap-2">
              {lead.name}
              {isTexted && (
                <Badge className="bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15 border-none font-semibold text-[10px] flex items-center gap-1 py-0.5">
                  <CheckCircle2 className="h-3 w-3" /> Texted
                </Badge>
              )}
            </h3>
            <Badge variant="outline" className={`text-[10px] ${tier.badgeClass}`}>
              {tier.emoji} {tier.label}
            </Badge>
              <Badge variant="outline" className="bg-card/4 text-muted-foreground border-white/10 text-[10px]">
              {lead.stage}
            </Badge>
          </div>

            <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-muted-foreground/60" />
              <span>Untouched {lead.days_stale} days</span>
            </div>
              <div className="flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5 text-muted-foreground/60" />
              <span>{lead.phone}</span>
            </div>
            {lead.last_contacted !== undefined ? (
              lead.last_contacted === "" ? (
                <div className="flex items-center gap-1.5 text-red-500 font-semibold">
                  <Send className="h-3 w-3" />
                  <span>Never contacted</span>
                </div>
              ) : (
                <div className={`flex items-center gap-1.5 font-medium ${
                  (lead.last_contacted_days ?? 0) === 0 ? "text-emerald-400" :
                  (lead.last_contacted_days ?? 0) <= 3 ? "text-emerald-400" :
                  (lead.last_contacted_days ?? 0) <= 7 ? "text-[oklch(0.76_0.14_78)]" : "text-red-400"
                }`}>
                  <Send className="h-3 w-3" />
                  <span>Last touched {(lead.last_contacted_days ?? 0) === 0 ? "today" : `${lead.last_contacted_days}d ago`}</span>
                </div>
              )
            ) : null}
          </div>

          {/* Pre-filled message */}
          <div className="bg-card/4 border border-white/8 rounded-lg p-3 text-xs text-foreground/80 font-serif italic relative">
            <span className="absolute -top-2 left-3 px-1.5 bg-card border border-white/10 rounded text-[9px] font-sans font-semibold uppercase tracking-wider text-muted-foreground">
              Pre-Filled Text
            </span>
            "{lead.sms_body}"
          </div>

          {/* Copilot SMS Draft */}
          <CopilotSmsDraft
            leadId={lead.id}
            leadName={lead.name}
            leadCity={lead.city}
            daysStale={lead.days_stale}
            assignedAgent={lead.assigned_agent}
            notes={lead.notes}
            lastInboundText={lead.last_inbound_text}
            prefillMessage={lead.sms_body}
            phone={lead.phone}
            onSendWithDraft={(draft) => onText(lead, draft)}
          />
        </div>

        {/* Send button */}
        <div className="self-end md:self-start md:pt-1 flex flex-col gap-2 w-full md:w-auto">
          <Button
            onClick={() => onText(lead)}
            className={`w-full md:w-auto h-11 px-6 rounded-lg font-semibold text-xs flex items-center justify-center gap-2 shadow-sm transition-all duration-200 active:scale-[0.97] ${
              isTexted
                ? "bg-card/8 hover:bg-card/12 text-foreground/70 border border-white/12 shadow-none"
                : "bg-emerald-600 hover:bg-emerald-500 text-white"
            }`}
          >
            <Send className="h-3.5 w-3.5" />
            {isTexted ? "Send Again" : "Send Text Now"}
          </Button>
          {!isTexted && (
            <p className="text-[9px] text-muted-foreground text-center md:text-right">
              Auto-logs note in FUB
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── Tier Section ──────────────────────────────────────────────────────────────
interface TierSectionProps {
  tier: LeadTier;
  leads: AgentLead[];
  textedLeads: Record<number, boolean>;
  onText: (lead: AgentLead, customBody?: string) => void;
  defaultOpen?: boolean;
}

function TierSection({ tier, leads, textedLeads, onText, defaultOpen = true }: TierSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const cfg = TIER_CONFIG[tier];
  if (leads.length === 0) return null;

  return (
    <div className="space-y-3">
      {/* Section header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between group"
      >
        <div className="flex items-center gap-3">
          {cfg.icon}
          <div className="text-left">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-foreground tracking-tight">
                {cfg.emoji} {cfg.label}
              </h2>
              <Badge className={`text-[10px] px-2 py-0.5 ${cfg.badgeClass}`}>
                {leads.length}
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground">{cfg.description}</p>
          </div>
        </div>
        <div className="text-muted-foreground group-hover:text-foreground/60 transition-colors">
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </div>
      </button>

      {/* Lead cards */}
      {open && (
        <div className="space-y-3 pl-0">
          {leads.map(lead => (
            <LeadCard
              key={lead.id}
              lead={lead}
              isTexted={!!textedLeads[lead.id]}
              onText={onText}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AgentDashboard() {
  const params = useParams<{ agentName: string }>();
  const agentName = params.agentName || "";
  const displayName = toTitleCase(agentName);

  const [textedLeads, setTextedLeads] = useState<Record<number, boolean>>(() => {
    try {
      const saved = localStorage.getItem(`fub_agent_texted_${agentName.toLowerCase()}`);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const utils = trpc.useUtils();

  const { data, isLoading, error, refetch, isFetching } = trpc.agent.getLeads.useQuery(
    { agentName },
    {
      enabled: !!agentName,
      staleTime: 3 * 60 * 1000,
      refetchOnWindowFocus: false,
    }
  );

  const leads: AgentLead[] = (data?.leads ?? []) as AgentLead[];

  const logSentNote = trpc.leads.logSentNote.useMutation({
    onError: (err) => console.error("FUB note log failed:", err.message),
  });

  const handleText = (lead: AgentLead, customBody?: string) => {
    logSentNote.mutate({
      personId: lead.id,
      agentName: lead.assigned_agent,
      messageBody: customBody || lead.sms_body,
    });
    setTextedLeads(prev => {
      const next = { ...prev, [lead.id]: true };
      localStorage.setItem(`fub_agent_texted_${agentName.toLowerCase()}`, JSON.stringify(next));
      return next;
    });
    toast.success(`Opening SMS for ${lead.name}!`);
    let smsLink = lead.sms_link;
    if (customBody && lead.phone) {
      const phone = lead.phone.replace(/\D/g, "");
      smsLink = `sms:${phone}&body=${encodeURIComponent(customBody)}`;
    }
    window.location.href = smsLink;
  };

  const handleRefresh = () => {
    utils.agent.getLeads.invalidate({ agentName });
    toast.info("Refreshing leads…");
  };

  // Group by tier
  const byTier = useMemo(() => {
    const groups: Record<LeadTier, AgentLead[]> = {
      do_now: [],
      hot_prospect: [],
      your_leads: [],
    };
    for (const lead of leads) {
      groups[lead.tier].push(lead);
    }
    return groups;
  }, [leads]);

  // Heat chart: texted vs total
  const totalTexted = Object.keys(textedLeads).filter(id =>
    leads.some(l => l.id === Number(id))
  ).length;
  const completionRate = leads.length > 0 ? Math.round((totalTexted / leads.length) * 100) : 0;

  const tierStats = useMemo(() => {
    return (["do_now", "hot_prospect", "your_leads"] as LeadTier[]).map(tier => {
      const t = byTier[tier];
      const texted = t.filter(l => textedLeads[l.id]).length;
      return { tier, total: t.length, texted, rate: t.length > 0 ? Math.round((texted / t.length) * 100) : 0 };
    }).filter(s => s.total > 0);
  }, [byTier, textedLeads]);

  // Compliance stats
  const { data: suppressionList } = trpc.compliance.getSuppressionList.useQuery({ limit: 5 });

  // ── Loading ──
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background gold-glow-bg pb-16">
        {/* Skeleton Header */}
        <header className="sticky top-0 z-50 w-full border-b border-white/8 bg-background/95 backdrop-blur-md">
          <div className="container flex h-16 items-center justify-between px-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-28 rounded-lg hidden sm:block" />
              <Skeleton className="h-8 w-20 rounded-lg" />
              <Skeleton className="h-8 w-8 rounded-full" />
            </div>
          </div>
        </header>
        {/* Skeleton Hero Banner */}
        <div className="border-b border-white/8 bg-card">
          <div className="container max-w-5xl px-4 py-5 flex items-center justify-between">
            <div className="space-y-2">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="h-10 w-24 rounded-xl" />
          </div>
        </div>
        {/* Skeleton Tier Sections */}
        <div className="container max-w-5xl px-4 py-6 space-y-6">
          {/* Urgent tier skeleton */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            {[1, 2].map(i => (
              <div key={i} className="bg-card border border-white/8 rounded-xl p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="space-y-1.5">
                    <Skeleton className="h-5 w-36" />
                    <div className="flex gap-2">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-4 w-20" />
                    </div>
                  </div>
                  <Skeleton className="h-6 w-16 rounded-full" />
                </div>
                <Skeleton className="h-10 w-full rounded-lg" />
                <div className="flex gap-2">
                  <Skeleton className="h-9 flex-1 rounded-lg" />
                  <Skeleton className="h-9 w-20 rounded-lg" />
                  <Skeleton className="h-9 w-20 rounded-lg" />
                </div>
              </div>
            ))}
          </div>
          {/* Your Leads tier skeleton */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-card border border-white/8 rounded-xl p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="space-y-1.5">
                    <Skeleton className="h-5 w-40" />
                    <div className="flex gap-2">
                      <Skeleton className="h-4 w-28" />
                      <Skeleton className="h-4 w-16" />
                    </div>
                  </div>
                  <Skeleton className="h-6 w-14 rounded-full" />
                </div>
                <div className="flex gap-2">
                  <Skeleton className="h-9 flex-1 rounded-lg" />
                  <Skeleton className="h-9 w-20 rounded-lg" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Error ──
  if (error) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <p className="text-sm font-semibold text-red-400">Failed to load leads</p>
        <p className="text-xs text-muted-foreground">{error.message}</p>
        <Button size="sm" onClick={() => refetch()} className="bg-amber-500 hover:bg-amber-400 text-white">
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background gold-glow-bg pb-16">
      {/* ── Sticky Header ── */}
      <header className="sticky top-0 z-50 w-full border-b border-white/8 bg-background/95 backdrop-blur-md">
        <div className="container flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <Link href="/agents">
              <Button variant="ghost" size="icon" className="h-9 w-9 rounded-lg text-muted-foreground hover:bg-card/8 hover:text-foreground">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <div className="flex items-center gap-2.5">
                <span className="text-[10px] font-light tracking-[0.25em] text-[oklch(0.76_0.14_78/70%)] uppercase">Welcome back</span>
                <span className="text-muted-foreground text-[10px]">·</span>
                <h1 className="text-base font-semibold text-foreground tracking-tight">{displayName}</h1>
                <Badge className="bg-emerald-950/60 text-emerald-600 border border-emerald-500/20 hover:bg-emerald-950/60 text-[10px] px-2 py-0.5 font-mono">
                  ⚡ Personal Dashboard
                </Badge>
              </div>
                <p className="text-[11px] text-muted-foreground tracking-wide">
                Lifestyle Design Realty <span className="text-[oklch(0.76_0.14_78/40%)]">·</span>{" "}
                {displayName.toLowerCase() === "peter" ? (
                  <span className="text-[oklch(0.76_0.14_78/80%)]">Broker / Owner View</span>
                ) : (
                  "Your Leads Only"
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Back to Bot Dashboard */}
            <a
              href="https://lifestyledash-wpnl8v84.manus.space"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium text-[oklch(0.76_0.14_78)] bg-[oklch(0.76_0.14_78/10%)] hover:bg-[oklch(0.76_0.14_78/18%)] border border-[oklch(0.76_0.14_78/25%)] hover:border-[oklch(0.76_0.14_78/40%)] transition-all duration-150"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Bot Dashboard
            </a>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const url = `https://lifestyledash-wpnl8v84.manus.space/agent/${agentName.toLowerCase()}`;
                navigator.clipboard.writeText(url).then(() => {
                  toast.success("Dashboard link copied! Add to your phone home screen.");
                }).catch(() => {
                  toast.info(`Your link: ${url}`);
                });
              }}
              className="h-8 gap-1.5 text-xs text-[oklch(0.76_0.14_78)] border-[oklch(0.76_0.14_78/25%)] bg-[oklch(0.76_0.14_78/8%)] hover:bg-[oklch(0.76_0.14_78/18%)] hover:text-[oklch(0.82_0.14_78)] flex"
            >
              <Share2 className="h-3.5 w-3.5" />
              Copy Link
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isFetching}
              className="h-8 gap-1.5 text-xs text-muted-foreground border-white/12 bg-card/4 hover:bg-card/8 hover:text-foreground hidden sm:flex"
            >
              {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-amber-500 to-yellow-600 text-white flex items-center justify-center text-xs font-bold font-mono shadow-sm">
              {completionRate}%
            </div>
          </div>
        </div>
      </header>

      {/* ── Hero Banner ── */}
      <div className="relative overflow-hidden bg-gradient-to-r from-[oklch(0.76_0.14_78/5%)] via-card to-[oklch(0.76_0.14_78/5%)] border-b border-[oklch(0.76_0.14_78/12%)]">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(212,175,55,0.06)_0%,transparent_70%)] pointer-events-none" />
        <div className="container max-w-5xl px-4 py-5 flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="text-[10px] font-light tracking-[0.3em] text-[oklch(0.76_0.14_78)] uppercase">Your leads for today</p>
            <h2 className="text-xl font-light text-foreground tracking-wide">
              {getGreeting()},{" "}
              <span className="font-semibold text-[oklch(0.76_0.14_78)]">{displayName}</span>
            </h2>
            <p className="text-[11px] text-muted-foreground">
              {byTier.do_now.length > 0 && (
                <span className="text-red-400 font-semibold">{byTier.do_now.length} urgent · </span>
              )}
              {byTier.hot_prospect.length > 0 && (
                <span className="text-[oklch(0.76_0.14_78)] font-semibold">{byTier.hot_prospect.length} hot · </span>
              )}
              {leads.length} total leads
            </p>
          </div>
          <div className="flex flex-col items-end gap-0.5">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-[10px] text-[oklch(0.76_0.14_78)] font-mono tracking-wider uppercase">Live Data</span>
            </div>
            <p className="text-[10px] text-muted-foreground tracking-[0.2em] uppercase">Powered by Lifestyle Technologies</p>
          </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-amber-500/20 to-transparent" />
      </div>

      <main className="container max-w-5xl px-4 py-8 space-y-8">
        {/* ── Quick Stats ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="bg-card border-white/8 shadow-sm p-4 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block">Total Leads</span>
              <span className="text-3xl font-bold text-[oklch(0.76_0.14_78)]">{leads.length}</span>
            </div>
            <div className="p-3 bg-card/6 text-foreground/70 rounded-xl border border-white/10">
              <Home className="h-5 w-5 stroke-[1.5]" />
            </div>
          </Card>

          <Card className="bg-red-950/20 border-red-500/20 shadow-sm p-4 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs font-semibold text-red-400 uppercase tracking-wider block">Do Now</span>
              <span className="text-3xl font-bold text-red-400">{byTier.do_now.length}</span>
            </div>
            <div className="p-3 bg-red-500/10 text-red-400 rounded-xl border border-red-500/20">
              <AlertTriangle className="h-5 w-5 stroke-[1.5]" />
            </div>
          </Card>

          <Card className="bg-[oklch(0.76_0.14_78/8%)] border-[oklch(0.76_0.14_78/20%)] shadow-sm p-4 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs font-semibold text-[oklch(0.76_0.14_78)] uppercase tracking-wider block">Hot Prospects</span>
              <span className="text-3xl font-bold text-[oklch(0.76_0.14_78)]">{byTier.hot_prospect.length}</span>
            </div>
            <div className="p-3 bg-[oklch(0.76_0.14_78/12%)] text-[oklch(0.76_0.14_78)] rounded-xl border border-[oklch(0.76_0.14_78/25%)]">
              <Star className="h-5 w-5 stroke-[1.5]" />
            </div>
          </Card>

          <Card className="bg-emerald-950/20 border-emerald-500/20 shadow-sm p-4 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider block">Texted Today</span>
              <span className="text-3xl font-bold text-emerald-400">{totalTexted}</span>
            </div>
            <div className="p-3 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20">
              <CheckCircle2 className="h-5 w-5 stroke-[1.5]" />
            </div>
          </Card>
        </div>

        {/* ── Outreach Heat Chart ── */}
        {tierStats.length > 0 && (
          <Card className="bg-card border-white/8 shadow-sm">
            <CardHeader className="pb-3 pt-4 px-5">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Flame className="h-4 w-4 text-orange-400" />
                Your Outreach Progress
                <span className="text-[10px] font-normal text-muted-foreground ml-1">— updates as texts are sent</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {tierStats.map(({ tier, total, texted, rate }) => {
                  const cfg = TIER_CONFIG[tier];
                  return (
                    <div key={tier} className={`rounded-lg border px-3 py-2.5 flex flex-col gap-1 ${heatColor(rate)}`}>
                      <span className="text-[11px] font-bold truncate">{cfg.emoji} {cfg.label}</span>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] opacity-70">{texted}/{total} sent</span>
                        <span className="text-sm font-black">{rate}%</span>
                      </div>
                      <div className="h-1 w-full bg-black/10 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-current rounded-full transition-all duration-500"
                          style={{ width: `${rate}%`, opacity: 0.6 }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── AI & Compliance Activity Panel ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* AI Copilot Status */}
          <Card className="bg-card border-white/8 shadow-sm">
            <CardHeader className="pb-2 pt-4 px-5">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Brain className="h-4 w-4 text-violet-400" />
                AI Copilot
              </CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-4">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-violet-500/8 border border-violet-500/20">
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                <span className="text-xs text-violet-300 font-medium">Active — note-driven drafts with per-lead memory</span>
              </div>
            </CardContent>
          </Card>

          {/* Compliance / Suppression */}
          <Card className="bg-card border-white/8 shadow-sm">
            <CardHeader className="pb-2 pt-4 px-5">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                Compliance
                {suppressionList && suppressionList.length > 0 && (
                  <Badge className="ml-auto bg-red-500/10 text-red-400 border border-red-500/20 text-[10px] px-2 py-0">
                    {suppressionList.length} suppressed
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-4">
              {!suppressionList || suppressionList.length === 0 ? (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-emerald-500/8 border border-emerald-500/20">
                  <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span className="text-xs text-emerald-300 font-medium">No suppressions recorded</span>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {suppressionList.slice(0, 4).map((s, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 rounded-lg bg-red-500/8 border border-red-500/15">
                      <UserX className="h-3.5 w-3.5 text-red-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-red-300 truncate block">{s.leadName || "Unknown Lead"}</span>
                        <span className="text-[10px] text-red-400/70 capitalize">{s.reason?.replace(/_/g, " ")}</span>
                      </div>
                    </div>
                  ))}
                  {suppressionList.length > 4 && (
                    <p className="text-[10px] text-muted-foreground text-center pt-1">+{suppressionList.length - 4} more suppressed leads</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Tier Sections ── */}
        {leads.length === 0 ? (
          <Card className="bg-card border-white/8 shadow-sm py-16 text-center">
            <div className="max-w-md mx-auto space-y-3">
              <div className="h-12 w-12 rounded-full bg-card/8 flex items-center justify-center mx-auto text-muted-foreground">
                <TrendingUp className="h-6 w-6 stroke-[1.5]" />
              </div>
              <h3 className="text-base font-semibold text-foreground">You're all caught up!</h3>
              <p className="text-xs text-muted-foreground">
                No leads are currently assigned to you, or all leads have been recently contacted.
              </p>
              <Button size="sm" onClick={handleRefresh} className="bg-emerald-600 hover:bg-emerald-500 text-white">
                Check Again
              </Button>
            </div>
          </Card>
        ) : (
          <div className="space-y-8">
            <TierSection
              tier="do_now"
              leads={byTier.do_now}
              textedLeads={textedLeads}
              onText={handleText}
              defaultOpen={true}
            />
            <TierSection
              tier="hot_prospect"
              leads={byTier.hot_prospect}
              textedLeads={textedLeads}
              onText={handleText}
              defaultOpen={true}
            />
            <TierSection
              tier="your_leads"
              leads={byTier.your_leads}
              textedLeads={textedLeads}
              onText={handleText}
              defaultOpen={byTier.do_now.length === 0 && byTier.hot_prospect.length === 0}
            />
          </div>
        )}

        {/* ── Footer ── */}
        <div className="text-center pt-4">
          <p className="text-[10px] text-slate-500 tracking-[0.2em] uppercase">
            Powered by Lifestyle Technologies · Lifestyle Design Realty
          </p>
        </div>
      </main>

      {/* Agent-specific Copilot — passes this agent's leads so the lead picker shows the right pool */}
      <AgentCopilot leads={leads} />
    </div>
  );
}
