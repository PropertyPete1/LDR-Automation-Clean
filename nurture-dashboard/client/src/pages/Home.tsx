import { useState, useMemo, useCallback } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from "recharts";
import {
  Mail,
  UserMinus,
  AlertTriangle,
  CheckCircle,
  ShieldAlert,
  RefreshCw,
  Search,
  Check,
  AlertCircle,
  TrendingUp,
  Send,
  Loader2,
  Users,

  Activity,
  Zap,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import { Link } from "wouter";
import LifestyleBotPanel from "@/components/LifestyleBotPanel";

// Gold-forward chart palette
const COLORS = ["#C9A84C", "#10B981", "#818CF8", "#F87171", "#34D399", "#FBBF24", "#60A5FA"];

// Dynamic: gradients derived from shared/agentColors.ts (Golden Rule — no hardcoded names)
import { getAgentGradient } from "@shared/agentColors";

// Shared dark tooltip style for all Recharts
const CHART_TOOLTIP = {
  background: "#161820",
  border: "1px solid rgba(201,168,76,0.25)",
  borderRadius: 8,
  fontSize: 11,
  color: "#F0EDE8",
};

export default function Home() {
  const [activeTab, setActiveTab] = useState("overview");
  const [searchTerm, setSearchTerm] = useState("");
  const [filterAction, setFilterAction] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");

  // ── Live data ─────────────────────────────────────────────────────────────
  const { data, isLoading, error, refetch, isRefetching } = trpc.fub.getDashboardStats.useQuery(
    undefined,
    { staleTime: 25_000, refetchInterval: 30_000, refetchIntervalInBackground: false }
  );

  const { data: rosterData, isLoading: rosterLoading, refetch: refetchRoster } =
    trpc.agent.getRoster.useQuery(undefined, { staleTime: 10 * 60_000 });

  const { data: botStatus } = trpc.bot.getStatus.useQuery(
    undefined,
    { staleTime: 2 * 60_000, refetchInterval: 2 * 60_000 }
  );

  // AI daily briefing
  const { data: briefingData, isLoading: briefingLoading } = trpc.ai.dailyBriefing.useQuery(
    undefined,
    { staleTime: 10 * 60_000, retry: 1 }
  );

  const utils = trpc.useUtils();

  const refreshRosterMutation = trpc.agent.refreshRoster.useMutation({
    onSuccess: (d) => {
      utils.agent.getRoster.setData(undefined, d);
      toast.success("Roster refreshed", { description: "All agent counts updated live from FUB." });
    },
    onError: () => toast.error("Refresh failed", { description: "Could not reach FUB. Try again." }),
  });

  const { data: auditData, isLoading: auditLoading, refetch: refetchAudit } =
    trpc.audit.getStatus.useQuery(undefined, { staleTime: 60_000 });

  const runAuditMutation = trpc.audit.run.useMutation({
    onSuccess: () => { void utils.audit.getStatus.invalidate(); },
    onError: (err) => {
      const msg = err.message?.toLowerCase() ?? "";
      if (msg.includes("login") || msg.includes("unauth") || msg.includes("10001")) {
        alert("You need to be logged in to run the audit.");
      } else {
        alert(`Audit failed: ${err.message}`);
      }
    },
  });

  const auditRunning = runAuditMutation.isPending;
  const fetchAuditStatus = useCallback(() => { void refetchAudit(); }, [refetchAudit]);
  const handleRunAudit = useCallback(() => { runAuditMutation.mutate(); }, [runAuditMutation]);

  // ── Derived stats ─────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!data) return { sentEmails: 0, suppressedEmails: 0, completedReassignments: 0, capReachedCount: 0, keywordReassignments: 0, lastUpdated: null as string | null };
    if (data.live_stats) {
      return {
        sentEmails: data.live_stats.pond_nurture_sent,
        suppressedEmails: data.live_stats.total_suppressed,
        completedReassignments: data.live_stats.stale_reassignment_completed,
        capReachedCount: data.live_stats.launch_cap_reached,
        keywordReassignments: data.live_stats.keyword_reassignment_completed,
        lastUpdated: data.live_stats.last_updated,
      };
    }
    let sentEmails = 0, suppressedEmails = 0, completedReassignments = 0, capReachedCount = 0, keywordReassignments = 0;
    data.counts.forEach(item => {
      if (item.action === "pond_nurture") {
        if (item.status === "sent") sentEmails += item.cnt;
        if (item.status === "suppressed") suppressedEmails += item.cnt;
      } else if (item.action === "stale_agent_pond_reassignment") {
        if (item.status === "completed") completedReassignments += item.cnt;
        if (item.status === "suppressed") suppressedEmails += item.cnt;
        if (item.status === "launch_cap_reached") capReachedCount += item.cnt;
      } else if (item.action === "pond_keyword_reassignment") {
        if (item.status === "completed") keywordReassignments += item.cnt;
      }
    });
    return { sentEmails, suppressedEmails, completedReassignments, capReachedCount, keywordReassignments, lastUpdated: null as string | null };
  }, [data]);

  const timelineData = useMemo(() => {
    if (!data) return [];
    const map: Record<string, { date: string; sent: number; reassignments: number; suppressed: number }> = {};
    data.timeline.forEach(item => {
      if (!map[item.date]) map[item.date] = { date: item.date, sent: 0, reassignments: 0, suppressed: 0 };
      if (item.action === "pond_nurture" && item.status === "sent") map[item.date].sent += item.cnt;
      else if (item.action === "pond_nurture" && item.status === "suppressed") map[item.date].suppressed += item.cnt;
      else if (item.action === "stale_agent_pond_reassignment" && item.status === "completed") map[item.date].reassignments += item.cnt;
    });
    return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

  const suppressionData = useMemo(() => {
    if (!data) return [];
    return data.suppressions
      .map(item => {
        const parts = item.reason.split("::");
        return { name: parts.length > 1 ? parts[1] : parts[0], value: item.count };
      })
      .sort((a, b) => b.value - a.value);
  }, [data]);

  const filteredActivity = useMemo(() => {
    if (!data) return [];
    return data.recent_activity.filter(item => {
      const matchesSearch =
        item.person_id?.toString().includes(searchTerm) ||
        JSON.stringify(item.details).toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.status.toLowerCase().includes(searchTerm.toLowerCase());
      return matchesSearch &&
        (filterAction === "all" || item.action === filterAction) &&
        (filterStatus === "all" || item.status === filterStatus);
    });
  }, [data, searchTerm, filterAction, filterStatus]);

  // ── Loading skeleton ───────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background text-foreground font-sans antialiased gold-glow-bg">
        <header className="sticky top-0 z-40 w-full bg-card/80 backdrop-blur-md border-b border-border">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
                <Zap className="h-4 w-4 text-primary-foreground" />
              </div>
              <span className="font-semibold text-sm tracking-tight">FUB Nurture</span>
            </div>
            <div className="h-4 w-24 bg-muted rounded animate-pulse" />
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
          <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="luxury-card p-4 space-y-2">
                <div className="h-3 w-20 bg-muted rounded animate-pulse" />
                <div className="h-7 w-14 bg-muted rounded animate-pulse" />
                <div className="h-2.5 w-24 bg-muted rounded animate-pulse" />
              </div>
            ))}
          </section>
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-36 luxury-card animate-pulse" />
            ))}
          </section>
        </main>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground max-w-sm text-center">
          <AlertCircle className="h-7 w-7 text-destructive" />
          <p className="text-sm font-medium text-foreground">Failed to load dashboard</p>
          <p className="text-xs text-muted-foreground">{error?.message ?? "Unknown error"}</p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background text-foreground font-sans antialiased gold-glow-bg">

      {/* ── Top Navigation Bar ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 w-full bg-card/80 backdrop-blur-md border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shadow-[0_0_12px_rgba(201,168,76,0.4)]">
              <Zap className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-semibold text-sm tracking-tight text-foreground">FUB Nurture</span>
            <span className="hidden sm:block text-xs text-muted-foreground">/ Lifestyle Design Realty</span>
          </div>

          <div className="flex items-center gap-2">
            {stats.lastUpdated && (
              <div className="hidden lg:flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                </span>
                Live · {new Date(stats.lastUpdated).toLocaleTimeString()}
              </div>
            )}

            <Link href="/sms-queue">
              <Button size="sm" className="h-8 gap-1.5 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shadow-[0_0_12px_rgba(201,168,76,0.3)]">
                <Send className="h-3.5 w-3.5" />
                Power Queue
              </Button>
            </Link>

            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs text-muted-foreground border-border bg-transparent shadow-none hover:bg-secondary"
              onClick={() => refetch()}
              disabled={isRefetching}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefetching ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">{isRefetching ? "Refreshing…" : "Refresh"}</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">

        {/* ── AI Daily Briefing ─────────────────────────────────────────────── */}
        <section className="luxury-card p-5">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-primary/10 border border-primary/20 flex-shrink-0">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h2 className="text-sm font-semibold text-foreground">Daily Intelligence</h2>
                <Badge variant="outline" className="text-[10px] bg-primary/5 text-primary border-primary/20">AI</Badge>
              </div>
              {briefingLoading ? (
                <div className="space-y-2">
                  <div className="h-3 w-3/4 bg-muted rounded animate-pulse" />
                  <div className="h-3 w-1/2 bg-muted rounded animate-pulse" />
                </div>
              ) : briefingData?.briefing ? (
                <p className="text-sm text-muted-foreground leading-relaxed">{briefingData.briefing}</p>
              ) : (
                <p className="text-sm text-muted-foreground">System is running smoothly. All bots are operational and on schedule.</p>
              )}
            </div>
          </div>
        </section>

        {/* ── KPI Strip ──────────────────────────────────────────────────────── */}
        <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {[
            { label: "Emails Sent", value: stats.sentEmails.toLocaleString(), sub: "Pond nurture total", icon: <Mail className="h-4 w-4 text-primary" />, accent: "text-primary" },
            { label: "Reassignments", value: stats.completedReassignments.toLocaleString(), sub: "Stale leads → pond", icon: <UserMinus className="h-4 w-4 text-emerald-400" />, accent: "text-emerald-400" },
            { label: "Suppressed", value: stats.suppressedEmails.toLocaleString(), sub: "Safety filters applied", icon: <AlertTriangle className="h-4 w-4 text-primary" />, accent: "text-primary" },
            { label: "Cap Actions", value: stats.capReachedCount.toLocaleString(), sub: "Launch cap safeguards", icon: <ShieldAlert className="h-4 w-4 text-red-400" />, accent: "text-red-400" },
            { label: "Conversion", value: data?.conversions ? `${data.conversions.conversion_rate}%` : "0.0%", sub: data?.conversions ? `${data.conversions.conversions_count} leads converted` : "Nurtured → active", icon: <TrendingUp className="h-4 w-4 text-violet-400" />, accent: "text-violet-400" },
          ].map((kpi) => (
            <div key={kpi.label} className="luxury-card p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{kpi.label}</span>
                {kpi.icon}
              </div>
              <div className={`text-2xl font-bold ${kpi.accent}`}>{kpi.value}</div>
              <p className="text-xs text-muted-foreground mt-0.5">{kpi.sub}</p>
            </div>
          ))}
        </section>

        {/* ── System Health (compact) ────────────────────────────────────────── */}
        <section className="luxury-card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`p-1.5 rounded-lg border ${
                auditLoading ? "bg-secondary border-border text-muted-foreground"
                : auditData?.clean ? "bg-emerald-400/10 border-emerald-400/30 text-emerald-400"
                : auditData ? "bg-red-400/10 border-red-400/30 text-red-400"
                : "bg-secondary border-border text-muted-foreground"
              }`}>
                {auditLoading ? <Loader2 className="h-4 w-4 animate-spin" />
                  : auditData?.clean ? <CheckCircle className="h-4 w-4" />
                  : <AlertCircle className="h-4 w-4" />}
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {auditLoading && !auditData ? "Loading…"
                    : auditData?.never_run ? "No audit run yet"
                    : auditData?.clean ? `All ${auditData.total} checks passed`
                    : auditData ? `${auditData.failures?.length ?? 0} issue${(auditData.failures?.length ?? 0) !== 1 ? "s" : ""} — ${auditData.passed}/${auditData.total} passed`
                    : "Status unavailable"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {auditData?.run_at ? `Last audit: ${new Date(auditData.run_at).toLocaleString()}` : "System health monitor"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {auditData && (
                <Badge
                  variant="outline"
                  className={`text-xs font-bold ${
                    auditData.clean
                      ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30"
                      : "bg-red-400/10 text-red-400 border-red-400/30"
                  }`}
                >
                  {auditData.score_pct}%
                </Badge>
              )}
              <Button size="sm" variant="outline" className="h-7 text-xs border-border text-muted-foreground bg-transparent hover:bg-secondary" onClick={fetchAuditStatus} disabled={auditLoading || auditRunning}>
                <RefreshCw className={`h-3 w-3 mr-1 ${auditLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button size="sm" className="h-7 text-xs bg-primary hover:bg-primary/90 text-primary-foreground" onClick={handleRunAudit} disabled={auditRunning || auditLoading}>
                {auditRunning ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Running…</> : <><Activity className="h-3 w-3 mr-1" />Run Audit</>}
              </Button>
            </div>
          </div>
        </section>

        {/* ── Agent Command Center ───────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Agent Command Center</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Live pipeline status — click any card to open their dashboard</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground border-border bg-transparent hover:bg-secondary shadow-none"
                onClick={() => refreshRosterMutation.mutate()} disabled={refreshRosterMutation.isPending || rosterLoading}>
                <RefreshCw className={`h-3 w-3 ${refreshRosterMutation.isPending ? "animate-spin" : ""}`} />
                {refreshRosterMutation.isPending ? "Fetching…" : "Refresh"}
              </Button>
              <Link href="/agents">
                <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground border-border bg-transparent hover:bg-secondary shadow-none">
                  <Users className="h-3 w-3" />
                  Directory
                </Button>
              </Link>
            </div>
          </div>

          {rosterLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-36 luxury-card animate-pulse" />
              ))}
            </div>
          ) : rosterData?.roster && rosterData.roster.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {rosterData.roster.map((agent) => {
                const isOwner = agent.slug === "peter";
                const gradient = getAgentGradient(agent.slug);
                const urgencyBorder = agent.do_now > 5
                  ? "border-red-500/40 shadow-[0_0_16px_rgba(239,68,68,0.12)]"
                  : agent.do_now > 0
                  ? "border-primary/40 shadow-[0_0_16px_rgba(201,168,76,0.10)]"
                  : "";

                return (
                  <Link key={agent.slug} href={`/agent/${agent.slug}`}>
                    <div className={`luxury-card p-4 cursor-pointer transition-all duration-200 hover:-translate-y-0.5 group ${urgencyBorder}`}>
                      <div className="flex items-center gap-2.5 mb-3">
                        <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${gradient} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
                          {agent.name.slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1">
                            <span className="font-semibold text-sm text-foreground truncate">{agent.name}</span>
                            {isOwner && <span className="text-[8px] font-bold uppercase px-1 py-0.5 rounded bg-primary/20 text-primary flex-shrink-0">Owner</span>}
                          </div>
                          <div className="text-[10px] text-muted-foreground truncate">{agent.total} leads</div>
                        </div>
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 ml-auto flex-shrink-0 group-hover:text-primary transition-colors" />
                      </div>

                      <div className="grid grid-cols-3 gap-1.5">
                        <div className={`rounded-lg p-1.5 text-center ${agent.do_now > 0 ? "bg-red-500/10" : "bg-secondary"}`}>
                          <div className={`text-base font-bold leading-none ${agent.do_now > 0 ? "text-red-400" : "text-muted-foreground"}`}>{agent.do_now}</div>
                          <div className="text-[8px] font-semibold uppercase tracking-wider mt-0.5 text-muted-foreground">Now</div>
                        </div>
                        <div className={`rounded-lg p-1.5 text-center ${agent.hot_prospect > 0 ? "bg-primary/10" : "bg-secondary"}`}>
                          <div className={`text-base font-bold leading-none ${agent.hot_prospect > 0 ? "text-primary" : "text-muted-foreground"}`}>{agent.hot_prospect}</div>
                          <div className="text-[8px] font-semibold uppercase tracking-wider mt-0.5 text-muted-foreground">Hot</div>
                        </div>
                        <div className="rounded-lg p-1.5 text-center bg-secondary">
                          <div className="text-base font-bold leading-none text-foreground">{agent.your_leads}</div>
                          <div className="text-[8px] font-semibold uppercase tracking-wider mt-0.5 text-muted-foreground">Total</div>
                        </div>
                      </div>

                      {/* Smart insight line */}
                      <div className="mt-2.5 pt-2.5 border-t border-border">
                        <p className="text-[10px] text-muted-foreground leading-relaxed">
                          {agent.do_now > 5
                            ? <span className="text-red-400 font-medium">{agent.do_now} leads overdue — needs attention today</span>
                            : agent.never_contacted > 3
                            ? <span className="text-amber-400 font-medium">{agent.never_contacted} leads never contacted</span>
                            : agent.avg_days_stale > 10
                            ? <span className="text-amber-400">{agent.avg_days_stale}d avg stale — consider reassignment</span>
                            : agent.hot_prospect > 3
                            ? <span className="text-primary font-medium">{agent.hot_prospect} hot prospects showing intent</span>
                            : agent.do_now > 0
                            ? <span>{agent.do_now} leads in the 14-20 day window</span>
                            : <span className="text-emerald-400">All caught up — no urgent leads</span>
                          }
                        </p>
                      </div>
                    </div>
                  </Link>
                );
              })}

              {/* Lifestyle Bot card */}
              {(() => {
                const botAgent = botStatus?.agents?.find((a: { isBot: boolean }) => a.isBot);
                const todayCount = botAgent?.todayCount ?? 0;
                const weekCount = botAgent?.weekCount ?? 0;
                const goal = botAgent?.goal ?? 15;
                const pct = botAgent?.pct ?? 0;
                return (
                  <div className="luxury-card border-emerald-400/30 p-4">
                    <div className="flex items-center gap-2.5 mb-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0 select-none">🤖</div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="font-semibold text-sm text-foreground">Lifestyle Bot</span>
                          <span className="text-[8px] font-bold uppercase px-1 py-0.5 rounded bg-emerald-400/20 text-emerald-400 flex-shrink-0">AUTO</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground">{weekCount} this week</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5 mb-2.5">
                      <div className={`rounded-lg p-1.5 text-center ${todayCount > 0 ? "bg-emerald-400/10" : "bg-secondary"}`}>
                        <div className={`text-base font-bold leading-none ${todayCount > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>{todayCount}</div>
                        <div className="text-[8px] font-semibold uppercase tracking-wider mt-0.5 text-muted-foreground">Today</div>
                      </div>
                      <div className="rounded-lg p-1.5 text-center bg-secondary">
                        <div className="text-base font-bold leading-none text-foreground">{goal}</div>
                        <div className="text-[8px] font-semibold uppercase tracking-wider mt-0.5 text-muted-foreground">Goal</div>
                      </div>
                      <div className="rounded-lg p-1.5 text-center bg-secondary">
                        <div className="text-base font-bold leading-none text-foreground">{weekCount}</div>
                        <div className="text-[8px] font-semibold uppercase tracking-wider mt-0.5 text-muted-foreground">Week</div>
                      </div>
                    </div>
                    <div className="w-full bg-secondary rounded-full h-1">
                      <div className="h-1 rounded-full transition-all duration-500"
                        style={{ width: `${Math.min(pct, 100)}%`, background: pct >= 100 ? "#34d399" : pct >= 60 ? "#C9A84C" : "#475569" }} />
                    </div>
                    <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                      <span>Daily progress</span>
                      <span className={pct >= 100 ? "text-emerald-400 font-semibold" : ""}>{pct}%</span>
                    </div>
                  </div>
                );
              })()}
            </div>
          ) : (
            <div className="luxury-card p-8 text-center text-muted-foreground text-sm">
              <Users className="h-7 w-7 mx-auto mb-2 stroke-1" />
              <p>Agent roster loading — FUB API call in progress.</p>
            </div>
          )}
        </section>

        {/* ── Lifestyle Bot Panel ────────────────────────────────────────────── */}
        <LifestyleBotPanel />

        {/* ── Analytics Tabs (3 tabs: Performance / Suppressions / Audit Logs) ── */}
        <Tabs defaultValue="overview" className="space-y-4" onValueChange={setActiveTab}>
          <div className="border-b border-border">
            <TabsList className="flex gap-1 -mb-px bg-transparent p-0">
              {[
                { value: "overview", label: "Performance" },
                { value: "suppressions", label: "Suppressions" },
                { value: "logs", label: "Audit Logs" },
              ].map(tab => (
                <TabsTrigger
                  key={tab.value}
                  value={tab.value}
                  className={`pb-3 px-3 text-xs font-medium border-b-2 transition-all cursor-pointer rounded-none bg-transparent ${
                    activeTab === tab.value
                      ? "border-primary text-primary font-semibold"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                  }`}
                >
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* Performance Tab */}
          <TabsContent value="overview" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card className="lg:col-span-2 bg-card border-border shadow-none">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold text-foreground">Automation Timeline — Last 30 Days</CardTitle>
                  <CardDescription className="text-xs text-muted-foreground">Sends and reassignments trended over time</CardDescription>
                </CardHeader>
                <CardContent className="h-72">
                  {timelineData.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No timeline data in the last 30 days.</div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={timelineData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                        <XAxis dataKey="date" stroke="#6b7280" fontSize={10} />
                        <YAxis stroke="#6b7280" fontSize={10} />
                        <Tooltip contentStyle={CHART_TOOLTIP} />
                        <Legend wrapperStyle={{ fontSize: 11, color: "#9ca3af" }} />
                        <Line type="monotone" dataKey="sent" stroke="#C9A84C" name="Emails Sent" strokeWidth={2} activeDot={{ r: 5 }} />
                        <Line type="monotone" dataKey="reassignments" stroke="#34d399" name="Reassignments" strokeWidth={2} />
                        <Line type="monotone" dataKey="suppressed" stroke="#818CF8" name="Suppressed" strokeWidth={1.5} strokeDasharray="4 4" />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <Card className="bg-card border-border shadow-none">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold text-foreground">Action Mix</CardTitle>
                  <CardDescription className="text-xs text-muted-foreground">Sent vs suppressed vs capped</CardDescription>
                </CardHeader>
                <CardContent className="h-72 flex flex-col items-center justify-center">
                  {stats.sentEmails === 0 && stats.suppressedEmails === 0 ? (
                    <div className="text-muted-foreground text-sm">No email actions recorded.</div>
                  ) : (
                    <>
                      <div className="w-full h-44">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie data={[
                              { name: "Sent", value: stats.sentEmails },
                              { name: "Suppressed", value: stats.suppressedEmails },
                              { name: "Capped", value: stats.capReachedCount },
                            ]} cx="50%" cy="50%" innerRadius={55} outerRadius={75} paddingAngle={4} dataKey="value">
                              <Cell fill="#C9A84C" />
                              <Cell fill="#818CF8" />
                              <Cell fill="#F87171" />
                            </Pie>
                            <Tooltip contentStyle={CHART_TOOLTIP} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="grid grid-cols-3 gap-3 text-center text-xs mt-2 w-full">
                        <div><div className="font-bold text-primary">{stats.sentEmails}</div><div className="text-muted-foreground">Sent</div></div>
                        <div><div className="font-bold text-violet-400">{stats.suppressedEmails}</div><div className="text-muted-foreground">Suppressed</div></div>
                        <div><div className="font-bold text-red-400">{stats.capReachedCount}</div><div className="text-muted-foreground">Capped</div></div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Agent Click Leaderboard */}
            {data.agent_clicks && data.agent_clicks.by_agent.length > 0 && (
              <Card className="bg-card border-border shadow-none">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-sm font-semibold text-foreground">Tap-to-Text Leaderboard</CardTitle>
                      <CardDescription className="text-xs text-muted-foreground">Agent click-through engagement</CardDescription>
                    </div>
                    <Badge variant="outline" className="text-xs font-mono bg-secondary text-muted-foreground border-border">
                      {data.agent_clicks.total_clicks} total clicks
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {data.agent_clicks.by_agent.map((item, idx) => {
                      const maxClicks = Math.max(...data.agent_clicks!.by_agent.map(a => a.clicks), 1);
                      const pct = (item.clicks / maxClicks) * 100;
                      let relativeTime = "Never";
                      if (item.last_click) {
                        try {
                          const diffMs = Date.now() - new Date(item.last_click).getTime();
                          const diffMins = Math.floor(diffMs / 60000);
                          const diffHours = Math.floor(diffMins / 60);
                          const diffDays = Math.floor(diffHours / 24);
                          relativeTime = diffMins < 1 ? "Just now" : diffMins < 60 ? `${diffMins}m ago` : diffHours < 24 ? `${diffHours}h ago` : `${diffDays}d ago`;
                        } catch { relativeTime = "Unknown"; }
                      }
                      return (
                        <div key={idx} className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium text-foreground">
                              {idx === 0 ? "👑 " : idx === 1 ? "🥈 " : idx === 2 ? "🥉 " : ""}{item.agent}
                              <span className="text-muted-foreground font-normal ml-2">· {relativeTime}</span>
                            </span>
                            <span className="font-bold text-primary">{item.clicks}</span>
                          </div>
                          <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                            <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Conversion breakdown */}
            {data.conversions && data.conversions.stages_breakdown && data.conversions.stages_breakdown.length > 0 && (
              <Card className="bg-card border-border shadow-none">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold text-foreground">Nurture Conversion Stages</CardTitle>
                  <CardDescription className="text-xs text-muted-foreground">Current FUB stages of leads who received pond nurture emails</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {data.conversions.stages_breakdown.map((item, idx) => {
                      const isConverted = ["Showing", "Pending", "Closed", "Hot Prospect", "Active Client", "Past Client", "Sphere", "Contract"].includes(item.stage);
                      return (
                        <div key={idx} className={`p-3 rounded-xl border flex items-center justify-between ${
                          isConverted ? "bg-violet-400/10 border-violet-400/20" : "bg-secondary border-border"
                        }`}>
                          <div>
                            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block">{item.stage}</span>
                            <span className="text-xl font-bold mt-0.5 block text-foreground">{item.count}</span>
                          </div>
                          <Badge variant="outline" className={`text-[10px] ${isConverted ? "bg-violet-400/10 text-violet-400 border-violet-400/30" : "bg-secondary text-muted-foreground border-border"}`}>
                            {isConverted ? "Converted" : "Nurturing"}
                          </Badge>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Suppressions Tab */}
          <TabsContent value="suppressions" className="space-y-4">
            <Card className="bg-card border-border shadow-none">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-primary" />
                  Safety Suppression Reasons
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground">Why emails or reassignments were bypassed</CardDescription>
              </CardHeader>
              <CardContent>
                {suppressionData.length === 0 ? (
                  <div className="py-10 text-center text-muted-foreground text-sm">No safety suppressions logged yet.</div>
                ) : (
                  <div className="space-y-4">
                    <div className="h-56">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={suppressionData.slice(0, 5)}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis dataKey="name" stroke="#6b7280" fontSize={10} />
                          <YAxis stroke="#6b7280" fontSize={10} />
                          <Tooltip contentStyle={CHART_TOOLTIP} />
                          <Bar dataKey="value" fill="#C9A84C" radius={[4, 4, 0, 0]} barSize={36} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="border border-border rounded-xl overflow-hidden">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="bg-secondary border-b border-border text-muted-foreground font-medium">
                            <th className="p-3">Suppression Reason</th>
                            <th className="p-3 text-right">Leads Shielded</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {suppressionData.map((item, idx) => (
                            <tr key={idx} className="hover:bg-secondary/50 transition-colors">
                              <td className="p-3 font-medium text-foreground">{item.name}</td>
                              <td className="p-3 text-right font-bold text-primary">{item.value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Audit Logs Tab */}
          <TabsContent value="logs" className="space-y-4">
            <Card className="bg-card border-border shadow-none">
              <CardHeader className="pb-3">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-sm font-semibold text-foreground">Live Audit History</CardTitle>
                    <CardDescription className="text-xs text-muted-foreground">Recent actions executed by the background automation</CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                      <input
                        type="text"
                        placeholder="Search lead ID or details…"
                        className="pl-8 pr-3 py-1.5 h-8 w-52 border border-border rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary bg-secondary text-foreground placeholder:text-muted-foreground"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                      />
                    </div>
                    <select
                      className="h-8 px-2 border border-border rounded-lg text-xs bg-secondary text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      value={filterAction}
                      onChange={(e) => setFilterAction(e.target.value)}
                    >
                      <option value="all">All Actions</option>
                      <option value="pond_nurture">Pond Nurture</option>
                      <option value="stale_agent_pond_reassignment">Reassignment</option>
                      <option value="agent_followup_reminder">Agent Reminder</option>
                    </select>
                    <select
                      className="h-8 px-2 border border-border rounded-lg text-xs bg-secondary text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      value={filterStatus}
                      onChange={(e) => setFilterStatus(e.target.value)}
                    >
                      <option value="all">All Statuses</option>
                      <option value="sent">Sent</option>
                      <option value="suppressed">Suppressed</option>
                      <option value="skipped">Skipped</option>
                      <option value="launch_cap_reached">Capped</option>
                    </select>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="bg-secondary border-b border-border text-muted-foreground font-medium">
                        <th className="p-3 w-32">Timestamp</th>
                        <th className="p-3 w-40">Action</th>
                        <th className="p-3 w-24">Status</th>
                        <th className="p-3 w-20">Lead ID</th>
                        <th className="p-3">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {filteredActivity.length === 0 ? (
                        <tr><td colSpan={5} className="p-8 text-center text-muted-foreground">No matching audit logs found.</td></tr>
                      ) : (
                        filteredActivity.map((item) => (
                          <tr key={item.id} className="hover:bg-secondary/50 transition-colors">
                            <td className="p-3 text-muted-foreground font-mono whitespace-nowrap">{new Date(item.created_at).toLocaleString()}</td>
                            <td className="p-3 font-medium text-foreground">
                              {item.action === "pond_nurture" && "Pond Nurture Email"}
                              {item.action === "stale_agent_pond_reassignment" && "Stale Reassignment"}
                              {item.action === "agent_followup_reminder" && "Agent Reminder"}
                              {item.action === "phase2_daily_summary" && "Daily Summary"}
                            </td>
                            <td className="p-3">
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
                                item.status === "sent" || item.status === "completed" || item.status === "email_digest_sent"
                                  ? "bg-emerald-400/10 text-emerald-400 border border-emerald-400/20"
                                  : item.status === "suppressed"
                                  ? "bg-primary/10 text-primary border border-primary/20"
                                  : item.status === "launch_cap_reached"
                                  ? "bg-red-400/10 text-red-400 border border-red-400/20"
                                  : "bg-secondary text-muted-foreground border border-border"
                              }`}>
                                {(item.status === "sent" || item.status === "completed") && <Check className="h-2.5 w-2.5" />}
                                {item.status === "launch_cap_reached" && <AlertCircle className="h-2.5 w-2.5" />}
                                {item.status}
                              </span>
                            </td>
                            <td className="p-3 font-mono text-muted-foreground">
                              {item.person_id ? (
                                <a href={`https://lifestyledesignrealty.followupboss.com/2/people/view/${item.person_id}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-semibold">
                                  #{item.person_id}
                                </a>
                              ) : "—"}
                            </td>
                            <td className="p-3 text-muted-foreground max-w-xs truncate">
                              <span className="font-mono text-[10px]">{JSON.stringify(item.details)}</span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

      </main>
    </div>
  );
}
