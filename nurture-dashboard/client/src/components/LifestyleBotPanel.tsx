import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Bot, Zap, RefreshCw, TrendingUp, MessageSquare, Users, Clock, ChevronDown, ChevronUp, CheckCircle, AlertCircle, Mail, Activity, Search, ShieldCheck, TriangleAlert, Wrench, Eye, Radio } from "lucide-react";

// ── Colour map per agent ────────────────────────────────────────────────────
const AGENT_COLORS: Record<string, { bar: string; text: string; bg: string }> = {
  "Peter":         { bar: "bg-amber-500",   text: "text-amber-400",   bg: "bg-amber-500/8 border-amber-500/20" },
  "Steven":        { bar: "bg-blue-500",    text: "text-blue-400",    bg: "bg-blue-500/8 border-blue-500/20" },
  "Tiffany":       { bar: "bg-violet-500",  text: "text-violet-400",  bg: "bg-violet-500/8 border-violet-500/20" },
  "Stefanie":      { bar: "bg-rose-500",    text: "text-rose-400",    bg: "bg-rose-500/8 border-rose-500/20" },
  "Abby":          { bar: "bg-emerald-500", text: "text-emerald-400", bg: "bg-emerald-500/8 border-emerald-500/20" },
  "Irma":          { bar: "bg-orange-500",  text: "text-orange-400",  bg: "bg-orange-500/8 border-orange-500/20" },
  "Laila":         { bar: "bg-cyan-500",    text: "text-cyan-400",    bg: "bg-cyan-500/8 border-cyan-500/20" },
  "Lifestyle Bot": { bar: "bg-purple-500",  text: "text-purple-400",  bg: "bg-purple-500/8 border-purple-500/20" },
};

// ── Types ───────────────────────────────────────────────────────────────────
interface RunRecord {
  id: number;
  runAt: Date;
  leadsTexted: number;
  leadsFailed: number;
  leadsEvaluated: number;
  emailSent: string;
  summary: string;
  triggeredBy: string;
  createdAt: Date;
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

// ── Last run result modal ───────────────────────────────────────────────────
interface BotResult {
  ranAt: string;
  leadsProcessed: number;
  leadsSkipped: number;
  leadsErrored: number;
  durationMs: number;
  summaryEmailSent: boolean;
  results: Array<{
    personId: number;
    name: string;
    phone: string;
    daysStale: number;
    draftMessage: string;
    notePosted: boolean;
    recorded: boolean;
    error?: string;
  }>;
}

function BotResultModal({ result, onClose }: { result: BotResult; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="bg-card border border-white/10 rounded-2xl shadow-2xl max-w-lg w-full max-h-[80vh] overflow-y-auto p-6 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-purple-500/15 rounded-lg">
              <Bot className="h-5 w-5 text-purple-400" />
            </div>
            <div>
              <h3 className="font-bold text-foreground">Lifestyle Bot Run Complete</h3>
              <p className="text-xs text-muted-foreground">{new Date(result.ranAt).toLocaleString()}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl font-bold leading-none">×</button>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="bg-emerald-950/20 border border-emerald-500/20 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-emerald-400">{result.leadsProcessed}</div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400/70 mt-0.5">Processed</div>
          </div>
          <div className="bg-card/4 border border-white/8 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-muted-foreground">{result.leadsSkipped}</div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mt-0.5">Skipped</div>
          </div>
          <div className={`rounded-xl p-3 text-center border ${result.leadsErrored > 0 ? "bg-red-950/20 border-red-500/20" : "bg-card/4 border-white/8"}`}>
            <div className={`text-2xl font-bold ${result.leadsErrored > 0 ? "text-red-400" : "text-muted-foreground"}`}>{result.leadsErrored}</div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mt-0.5">Errors</div>
          </div>
        </div>

        <div className="text-xs text-muted-foreground flex items-center justify-between border-t border-white/8 pt-3">
          <span>Duration: {(result.durationMs / 1000).toFixed(1)}s</span>
          <span className={result.summaryEmailSent ? "text-emerald-400 font-medium" : "text-muted-foreground"}>
            {result.summaryEmailSent ? "✓ Summary email sent" : "Email not sent"}
          </span>
        </div>

        {result.results.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Leads Processed</h4>
            {result.results.map((r, i) => (
              <div key={i} className={`rounded-lg border p-3 text-xs space-y-1 ${r.error ? "bg-red-950/15 border-red-500/20" : "bg-card/4 border-white/8"}`}>
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground">{r.name}</span>
                  <span className="text-muted-foreground">{r.daysStale}d stale</span>
                </div>
                {r.error ? (
                  <p className="text-red-400">{r.error}</p>
                ) : (
                  <p className="text-foreground/60 italic">"{r.draftMessage}"</p>
                )}
                <div className="flex gap-2 text-[10px] text-muted-foreground">
                  {r.notePosted && <span className="text-emerald-400">✓ FUB note posted</span>}
                  {r.recorded && <span className="text-emerald-400">✓ Recorded in DB</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        <Button onClick={onClose} variant="outline" className="w-full">Close</Button>
      </div>
    </div>
  );
}

// ── Main panel ──────────────────────────────────────────────────────────────
export default function LifestyleBotPanel() {
  const [botResult, setBotResult] = useState<BotResult | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showMonitor, setShowMonitor] = useState(false);
  const [showObsFeed, setShowObsFeed] = useState(false);
  const [monitorResult, setMonitorResult] = useState<null | {
    ranAt: string;
    durationMs: number;
    checksRun: number;
    issuesFound: number;
    issuesFixed: number;
    findings: Array<{ check: string; status: string; detail: string }>;
    summary: string;
    triggeredBy: string;
  }>(null);

  const { data: dashStats } = trpc.fub.getDashboardStats.useQuery(undefined, {
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });

  const { data, isLoading, refetch, isRefetching } = trpc.bot.getStatus.useQuery(undefined, {
    staleTime: 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
  });

  const { data: runHistory, refetch: refetchHistory } = trpc.bot.getRunHistory.useQuery(undefined, {
    staleTime: 60 * 1000,
  });

  const { data: monitorHistory, refetch: refetchMonitor } = trpc.bot.getMonitorStatus.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  const runMonitorMutation = trpc.bot.runMonitorNow.useMutation({
    onSuccess: (result) => {
      setMonitorResult(result);
      void refetchMonitor();
      const icon = result.issuesFound === 0 ? "✅" : result.findings.some(f => f.status === "error") ? "🔴" : "⚠️";
      toast.success(`${icon} Monitor complete — ${result.checksRun} checks`, {
        description: result.summary,
      });
    },
    onError: (err) => {
      toast.error("Monitor run failed", { description: err.message });
    },
  });

  const lastMonitorRun = monitorHistory && monitorHistory.length > 0 ? monitorHistory[0] : null;

  const { data: observations, refetch: refetchObs } = trpc.bot.getObservations.useQuery(
    { limit: 60, hoursBack: 25 },
    { staleTime: 5 * 60 * 1000, refetchInterval: 5 * 60 * 1000 }
  );

  const markObsFixedMutation = trpc.bot.markObsFixed.useMutation({
    onSuccess: () => { void refetchObs(); toast.success("Observation marked as fixed"); },
    onError: (err) => toast.error("Could not mark fixed", { description: err.message }),
  });

  // Auto-Pond Promotion
  const [showPondHistory, setShowPondHistory] = useState(false);
  const [pondResult, setPondResult] = useState<null | { promoted: number; skipped: number; errors: number; durationMs: number; summary: string }>(null);

  const { data: pondHistory, refetch: refetchPondHistory } = trpc.bot.getPondPromotionHistory.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });

  const runAutoPondMutation = trpc.bot.runAutoPondNow.useMutation({
    onSuccess: (result) => {
      setPondResult(result);
      void refetchPondHistory();
      toast.success(`✅ Pond promotion complete — ${result.promoted} leads moved`, {
        description: result.summary,
      });
    },
    onError: (err) => {
      toast.error("Auto-pond promotion failed", { description: err.message });
    },
  });

  const lastPondRun = pondHistory && pondHistory.length > 0 ? pondHistory[0] : null;

  const obsErrors   = (observations ?? []).filter(o => o.severity === "error");
  const obsWarnings = (observations ?? []).filter(o => o.severity === "warning");
  const obsFixed    = (observations ?? []).filter(o => o.severity === "fixed");
  const obsInfo     = (observations ?? []).filter(o => o.severity === "info");
  const obsTotal    = (observations ?? []).length;

  const runBotMutation = trpc.bot.runNow.useMutation({
    onSuccess: (result) => {
      setBotResult(result as BotResult);
      void refetch();
      void refetchHistory();
      toast.success(`Lifestyle Bot complete — ${result.leadsProcessed} leads processed`, {
        description: result.summaryEmailSent ? "Summary email sent to Peter." : undefined,
      });
    },
    onError: (err) => {
      toast.error("Lifestyle Bot failed", { description: err.message });
    },
  });

  // No hardcoded cap — Pond Nurture uses dynamic scaling (eligible ÷ 14).
  const lastRun = runHistory && runHistory.length > 0 ? runHistory[0] : null;

  const botTextToday = data?.agents.find(a => a.isBot)?.todayCount ?? 0;
  const botTextWeek = data?.agents.find(a => a.isBot)?.weekCount ?? 0;
  const allTimeTexted = (runHistory as RunRecord[] | undefined)?.reduce((s, r) => s + r.leadsTexted, 0) ?? 0;

  const pondEmailToday = dashStats?.live_stats?.pond_nurture_today ?? null;
  const pondEmailAllTime = dashStats?.live_stats?.pond_nurture_sent ?? null;

  return (
    <>
      {botResult && <BotResultModal result={botResult} onClose={() => setBotResult(null)} />}

      <Card className="bg-card border border-white/8 shadow-sm overflow-hidden">
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-gradient-to-br from-purple-600 to-purple-800 rounded-xl shadow-sm">
                <Bot className="h-5 w-5 text-white" />
              </div>
              <div>
                <CardTitle className="text-base font-semibold text-foreground">
                  Lifestyle Bot Command Center
                </CardTitle>
                <CardDescription className="text-xs">
                  Daily activity across all agents + Pond Nurture bot · Dynamic scaling
                </CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void refetch(); void refetchHistory(); }}
                disabled={isRefetching}
                className="text-xs h-8"
              >
                <RefreshCw className={`h-3 w-3 mr-1.5 ${isRefetching ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button
                size="sm"
                onClick={() => runBotMutation.mutate()}
                disabled={runBotMutation.isPending}
                className="bg-purple-600 hover:bg-purple-700 text-white text-xs h-8 gap-1.5"
              >
                {runBotMutation.isPending ? (
                  <><RefreshCw className="h-3 w-3 animate-spin" /> Running…</>
                ) : (
                  <><Zap className="h-3 w-3" /> Run Bot Now</>
                )}
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-0 space-y-4">

          {/* ── Last Run Banner ─────────────────────────────────────────── */}
          {lastRun ? (
            <div
              className={`flex items-center justify-between rounded-xl border px-4 py-3 cursor-pointer transition-colors ${
                lastRun.leadsFailed > 0
                  ? "bg-red-950/20 border-red-500/25 hover:bg-red-950/30"
                  : "bg-emerald-950/20 border-emerald-500/25 hover:bg-emerald-950/30"
              }`}
              onClick={() => setShowHistory(v => !v)}
            >
              <div className="flex items-center gap-3">
                {lastRun.leadsFailed > 0 ? (
                  <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
                ) : (
                  <CheckCircle className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                )}
                <div>
                  <p className="text-xs font-semibold text-foreground">
                    Last run: {formatRelativeTime(lastRun.runAt)} —{" "}
                    <span className="text-emerald-400">{lastRun.leadsTexted} leads processed</span>
                    {lastRun.leadsFailed > 0 && (
                      <span className="text-red-400 ml-1">· {lastRun.leadsFailed} failed</span>
                    )}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {new Date(lastRun.runAt).toLocaleString()} · {lastRun.triggeredBy === "manual" ? "Manual" : "Scheduled"}
                    {lastRun.emailSent === "yes" && " · Email ✓"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                <span className="text-[10px] font-medium">History</span>
                {showHistory ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-card/4 px-4 py-3">
              <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <p className="text-xs text-muted-foreground">
                No runs recorded yet. Click <strong>Run Bot Now</strong> or wait for the scheduled 10am CT run.
              </p>
            </div>
          )}

          {/* ── Run History Drawer ──────────────────────────────────────── */}
          {showHistory && runHistory && runHistory.length > 0 && (
            <div className="rounded-xl border border-white/8 overflow-hidden">
              <div className="bg-card/4 px-4 py-2 border-b border-white/8">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recent Bot Runs</p>
              </div>
              <div className="divide-y divide-white/6">
                {(runHistory as RunRecord[]).map((run) => (
                  <div key={run.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-card/4 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${run.leadsFailed > 0 ? "bg-red-400" : "bg-emerald-400"}`} />
                      <div>
                        <p className="text-xs font-medium text-foreground">
                          {run.leadsTexted} processed
                          {run.leadsFailed > 0 && <span className="text-red-400 ml-1">· {run.leadsFailed} failed</span>}
                        </p>
                        <p className="text-[10px] text-muted-foreground">{new Date(run.runAt).toLocaleString()}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {run.emailSent === "yes" && (
                        <Badge className="bg-emerald-950/20 text-emerald-400 border-emerald-500/20 text-[9px] py-0 px-1.5">Email ✓</Badge>
                      )}
                      <Badge className={`text-[9px] py-0 px-1.5 ${run.triggeredBy === "manual" ? "bg-blue-950/20 text-blue-400 border-blue-500/20" : "bg-card/6 text-muted-foreground border-white/8"}`}>
                        {run.triggeredBy === "manual" ? "Manual" : "Scheduled"}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Summary Stats Row ──────────────────────────────────────── */}
          {data && (
            <div className="grid grid-cols-4 gap-3 p-4 bg-card/4 rounded-xl border border-white/8">
              <div className="text-center">
                <div className="text-2xl font-bold text-foreground">{data.totalToday}</div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mt-0.5">Today</div>
              </div>
              <div className="text-center border-x border-white/8">
                <div className="text-2xl font-bold text-foreground">{data.totalWeek}</div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mt-0.5">This Week</div>
              </div>
              <div className="text-center border-r border-white/8">
                <div className="text-2xl font-bold text-purple-400">{botTextToday}</div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mt-0.5">Bot Today</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-primary">
                  {pondEmailToday !== null ? pondEmailToday : "—"}
                </div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mt-0.5">Pond Emails</div>
              </div>
            </div>
          )}

          {/* ── Agent Progress Rows ────────────────────────────────────── */}
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-14 bg-card/6 rounded-xl animate-pulse" />
              ))}
            </div>
          ) : data ? (
            <div className="space-y-2">
              {[...data.agents]
                .sort((a, b) => {
                  if (a.isBot && !b.isBot) return -1;
                  if (!a.isBot && b.isBot) return 1;
                  return b.todayCount - a.todayCount;
                })
                .map((agent) => {
                  const colors = AGENT_COLORS[agent.name] ?? { bar: "bg-stone-400", text: "text-muted-foreground", bg: "bg-card/4 border-white/8" };
                   const agentGoal = agent.goal || 10;
                  const pct = Math.min(100, Math.round((agent.todayCount / agentGoal) * 100));
                  const hitGoal = agent.todayCount >= agentGoal;
                  const initials = agent.isBot ? "🤖" : agent.name.slice(0, 2).toUpperCase();

                  return (
                    <div
                      key={agent.name}
                      className={`rounded-xl border p-3 transition-all duration-200 ${
                        agent.isBot ? "bg-purple-500/8 border-purple-500/20" : colors.bg
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${
                          agent.isBot
                            ? "bg-gradient-to-br from-purple-600 to-purple-800 text-white"
                            : `bg-gradient-to-br ${
                                agent.name === "Peter" ? "from-yellow-500 to-amber-700" :
                                agent.name === "Steven" ? "from-blue-600 to-blue-800" :
                                agent.name === "Tiffany" ? "from-violet-600 to-violet-800" :
                                agent.name === "Stefanie" ? "from-rose-600 to-rose-800" :
                                agent.name === "Abby" ? "from-emerald-600 to-emerald-800" :
                                agent.name === "Irma" ? "from-amber-600 to-amber-800" :
                                "from-cyan-600 to-cyan-800"
                              } text-white`
                        }`}>
                          {initials}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-semibold text-foreground">{agent.name}</span>
                              {agent.isBot && (
                                <Badge className="bg-purple-500/15 text-purple-400 border-purple-500/20 text-[9px] py-0 px-1.5">AUTO</Badge>
                              )}
                              {hitGoal && (
                                <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/20 text-[9px] py-0 px-1.5">✓ Goal</Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-3 text-xs">
                              <span className="text-muted-foreground">
                                <MessageSquare className="h-3 w-3 inline mr-0.5" />
                                <span className="font-semibold text-foreground">{agent.todayCount}</span>
                                <span className="text-muted-foreground"> today</span>
                              </span>
                              <span className="text-muted-foreground hidden sm:inline">
                                <TrendingUp className="h-3 w-3 inline mr-0.5" />
                                <span className="font-semibold text-foreground">{agent.weekCount}</span>
                                <span className="text-muted-foreground"> wk</span>
                              </span>
                            </div>
                          </div>
                          <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-700 ${
                                hitGoal ? "bg-emerald-500" : agent.isBot ? "bg-purple-500" : colors.bar
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground text-sm">
              <Users className="h-8 w-8 mx-auto mb-2 stroke-1" />
              <p>Could not load bot status. Check server connection.</p>
            </div>
          )}

          {/* ── System Monitor (collapsible) ─────────────────────────────── */}
          <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <button
                onClick={() => setShowMonitor(v => !v)}
                className="flex items-center gap-2 text-left group"
              >
                <Search className="h-3.5 w-3.5 text-indigo-400" />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-indigo-400">
                  System Monitor
                </span>
                {lastMonitorRun && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                    lastMonitorRun.issuesFound === 0
                      ? "bg-emerald-500/15 text-emerald-400"
                      : lastMonitorRun.findings.some((f: any) => f.status === "error")
                      ? "bg-red-500/15 text-red-400"
                      : "bg-amber-500/15 text-amber-400"
                  }`}>
                    {lastMonitorRun.issuesFound === 0 ? "✓ All clear" : `${lastMonitorRun.issuesFound} issue${lastMonitorRun.issuesFound > 1 ? "s" : ""}`}
                  </span>
                )}
                {showMonitor
                  ? <ChevronUp className="h-3 w-3 text-indigo-400" />
                  : <ChevronDown className="h-3 w-3 text-indigo-400" />}
              </button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10px] px-2 border-indigo-500/25 text-indigo-400 hover:bg-indigo-500/10 bg-card"
                onClick={() => runMonitorMutation.mutate()}
                disabled={runMonitorMutation.isPending}
              >
                {runMonitorMutation.isPending
                  ? <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                  : <Search className="h-3 w-3 mr-1" />}
                {runMonitorMutation.isPending ? "Scanning..." : "Run Now"}
              </Button>
            </div>

            {lastMonitorRun && (
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatRelativeTime(lastMonitorRun.runAt)}</span>
                <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3 text-indigo-400" /> {lastMonitorRun.checksRun} checks</span>
                {lastMonitorRun.issuesFixed > 0 && <span className="flex items-center gap-1 text-blue-400"><Wrench className="h-3 w-3" /> {lastMonitorRun.issuesFixed} auto-fixed</span>}
              </div>
            )}

            {showMonitor && (
              <div className="space-y-1.5">
                {(monitorResult?.findings ?? lastMonitorRun?.findings ?? []).map((f: { check: string; status: string; detail: string }, i: number) => (
                  <div
                    key={i}
                    className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[10px] ${
                      f.status === "ok" ? "bg-emerald-500/8 border border-emerald-500/20"
                      : f.status === "fixed" ? "bg-blue-500/8 border border-blue-500/20"
                      : f.status === "warning" ? "bg-amber-500/8 border border-amber-500/20"
                      : "bg-red-500/8 border border-red-500/20"
                    }`}
                  >
                    <span className="mt-0.5 flex-shrink-0">
                      {f.status === "ok" && <CheckCircle className="h-3 w-3 text-emerald-500" />}
                      {f.status === "fixed" && <Wrench className="h-3 w-3 text-blue-500" />}
                      {f.status === "warning" && <TriangleAlert className="h-3 w-3 text-amber-500" />}
                      {f.status === "error" && <AlertCircle className="h-3 w-3 text-red-500" />}
                    </span>
                    <div className="min-w-0">
                      <span className={`font-semibold ${
                        f.status === "ok" ? "text-emerald-400"
                        : f.status === "fixed" ? "text-blue-400"
                        : f.status === "warning" ? "text-amber-400"
                        : "text-red-400"
                      }`}>{f.check}</span>
                      <span className="text-muted-foreground ml-1">— {f.detail}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Bot Observer Network (collapsible) ───────────────────────── */}
          <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <button
                className="group flex items-center gap-2 text-[11px] font-semibold text-violet-400 hover:text-violet-300 transition-colors"
                onClick={() => setShowObsFeed(v => !v)}
              >
                <Radio className="h-3.5 w-3.5 text-violet-400" />
                Observer Network
                {obsErrors.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-red-500/15 text-red-400">
                    {obsErrors.length} error{obsErrors.length > 1 ? "s" : ""}
                  </span>
                )}
                {obsErrors.length === 0 && obsWarnings.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/15 text-amber-400">
                    {obsWarnings.length} warning{obsWarnings.length > 1 ? "s" : ""}
                  </span>
                )}
                {obsErrors.length === 0 && obsWarnings.length === 0 && obsTotal > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/15 text-emerald-400">
                    ✓ All clear
                  </span>
                )}
                {showObsFeed ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10px] px-2 border-violet-500/25 text-violet-400 hover:bg-violet-500/10 bg-card"
                onClick={() => void refetchObs()}
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Refresh
              </Button>
            </div>

            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1"><Eye className="h-3 w-3" /> {obsTotal} observations (last 25h)</span>
              {obsErrors.length > 0 && <span className="text-red-400 font-semibold">{obsErrors.length} error{obsErrors.length > 1 ? "s" : ""}</span>}
              {obsWarnings.length > 0 && <span className="text-amber-400">{obsWarnings.length} warning{obsWarnings.length > 1 ? "s" : ""}</span>}
              {obsFixed.length > 0 && <span className="text-blue-400">{obsFixed.length} fixed</span>}
            </div>

            {showObsFeed && (
              <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
                {(observations ?? []).length === 0 && (
                  <p className="text-[10px] text-muted-foreground italic text-center py-2">No observations yet — bots are running silently</p>
                )}
                {(observations ?? []).map((obs) => (
                  <div
                    key={obs.id}
                    className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[10px] ${
                      obs.severity === "error"   ? "bg-red-500/8 border border-red-500/20"
                      : obs.severity === "warning" ? "bg-amber-500/8 border border-amber-500/20"
                      : obs.severity === "fixed"   ? "bg-blue-500/8 border border-blue-500/20"
                      : "bg-white/4 border border-white/10"
                    }`}
                  >
                    <span className="mt-0.5 flex-shrink-0">
                      {obs.severity === "error"   && <AlertCircle className="h-3 w-3 text-red-500" />}
                      {obs.severity === "warning"  && <TriangleAlert className="h-3 w-3 text-amber-500" />}
                      {obs.severity === "fixed"    && <Wrench className="h-3 w-3 text-blue-500" />}
                      {obs.severity === "info"     && <CheckCircle className="h-3 w-3 text-slate-500" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold text-muted-foreground uppercase tracking-wider text-[9px]">{obs.source}</span>
                        <span className={`font-medium ${
                          obs.severity === "error" ? "text-red-400"
                          : obs.severity === "warning" ? "text-amber-400"
                          : obs.severity === "fixed" ? "text-blue-400"
                          : "text-muted-foreground"
                        }`}>{obs.message}</span>
                      </div>
                      {obs.detail && (
                        <p className="text-muted-foreground mt-0.5 leading-relaxed">{obs.detail}</p>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-muted-foreground">{formatRelativeTime(obs.createdAt)}</span>
                        {(obs.severity === "error" || obs.severity === "warning") && (
                          <button
                            className="text-[9px] text-blue-400 hover:text-blue-300 underline"
                            onClick={() => markObsFixedMutation.mutate({ id: obs.id })}
                            disabled={markObsFixedMutation.isPending}
                          >
                            Mark fixed
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Auto-Pond Promotion (collapsible) ────────────────────────── */}
          <div className="rounded-xl border border-teal-500/20 bg-teal-500/5 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <button
                onClick={() => setShowPondHistory(v => !v)}
                className="flex items-center gap-2 text-left group"
              >
                <Users className="h-3.5 w-3.5 text-teal-400" />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-teal-400">
                  Auto-Pond Promotion
                </span>
                {lastPondRun && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                    lastPondRun.errors > 0 ? "bg-amber-500/15 text-amber-400" : "bg-teal-500/15 text-teal-400"
                  }`}>
                    {lastPondRun.promoted} moved
                  </span>
                )}
                {showPondHistory ? <ChevronUp className="h-3 w-3 text-teal-400" /> : <ChevronDown className="h-3 w-3 text-teal-400" />}
              </button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10px] px-2 border-teal-500/25 text-teal-400 hover:bg-teal-500/10 bg-card"
                onClick={() => runAutoPondMutation.mutate()}
                disabled={runAutoPondMutation.isPending}
              >
                {runAutoPondMutation.isPending
                  ? <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                  : <Zap className="h-3 w-3 mr-1" />}
                {runAutoPondMutation.isPending ? "Running..." : "Run Now"}
              </Button>
            </div>

            {lastPondRun && (
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatRelativeTime(lastPondRun.ranAt)}</span>
                <span className="flex items-center gap-1 text-teal-400"><Users className="h-3 w-3" /> {lastPondRun.promoted} promoted</span>
                {lastPondRun.skipped > 0 && <span>{lastPondRun.skipped} skipped</span>}
                {lastPondRun.errors > 0 && <span className="text-amber-400">{lastPondRun.errors} errors</span>}
              </div>
            )}

            {pondResult && !runAutoPondMutation.isPending && (
              <div className="rounded-lg bg-teal-500/10 border border-teal-500/25 px-3 py-2 text-[10px] text-teal-300">
                <span className="font-semibold">Result: </span>{pondResult.summary}
              </div>
            )}

            {showPondHistory && pondHistory && pondHistory.length > 0 && (
              <div className="space-y-1.5">
                {pondHistory.map((run) => (
                  <div key={run.id} className="flex items-center gap-2 text-[10px] text-muted-foreground bg-card rounded-lg px-2.5 py-1.5 border border-teal-500/15">
                    <span>{formatRelativeTime(run.ranAt)}</span>
                    <span className="text-teal-400 font-semibold">{run.promoted} promoted</span>
                    <span>{run.skipped} skipped</span>
                    {run.errors > 0 && <span className="text-amber-400">{run.errors} errors</span>}
                    <span className="ml-auto">{run.triggeredBy}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

        </CardContent>
      </Card>
    </>
  );
}
