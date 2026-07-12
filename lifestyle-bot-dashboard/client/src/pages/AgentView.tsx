import { trpc } from "@/lib/trpc";
import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  Clock,
  Mail,
  XCircle,
  Activity,
  Calendar,
  MessageSquare,
  User,
  RefreshCw,
  TrendingUp,
  ExternalLink,
  MessageCircle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type BotStatus = "ok" | "warning" | "error" | "not_run";

// ─── Constants ────────────────────────────────────────────────────────────────

// Per-agent accent colors — light-tech palette (light bg + dark text)
const BOT_COLORS: Record<string, { bg: string; text: string; accent: string; border: string }> = {
  sp500:        { bg: "bg-blue-50",   text: "text-blue-700",   accent: "bg-blue-600",   border: "border-blue-200" },
  sp500_peter:  { bg: "bg-orange-50", text: "text-orange-700", accent: "bg-orange-600", border: "border-orange-200" },
  sp500_steven: { bg: "bg-blue-50",   text: "text-blue-700",   accent: "bg-blue-600",   border: "border-blue-200" },
  tiffany:      { bg: "bg-teal-50",   text: "text-teal-700",   accent: "bg-teal-600",   border: "border-teal-200" },
  stefanie:     { bg: "bg-pink-50",   text: "text-pink-700",   accent: "bg-pink-600",   border: "border-pink-200" },
  abby:         { bg: "bg-purple-50", text: "text-purple-700", accent: "bg-purple-600", border: "border-purple-200" },
  irma:         { bg: "bg-amber-50",  text: "text-amber-700",  accent: "bg-amber-600",  border: "border-amber-200" },
  laila:        { bg: "bg-green-50",  text: "text-green-700",  accent: "bg-green-600",  border: "border-green-200" },
};

const BOT_AVATARS: Record<string, string> = {
  sp500: "S&P", sp500_peter: "PET", sp500_steven: "STV",
  tiffany: "TIF", stefanie: "RUE", abby: "ABB", irma: "IRM", laila: "LAI",
};

const AGENT_NAMES: Record<string, string> = {
  sp500: "Steven & Peter", sp500_peter: "Peter", sp500_steven: "Steven",
  tiffany: "Tiffany", stefanie: "Rue (Stefanie)", abby: "Abby", irma: "Irma", laila: "Laila",
};

// Power Queue agent filter names (maps slug → FUB display name for ?agent= param)
const POWER_QUEUE_NAMES: Record<string, string | null> = {
  sp500: null,          // legacy combined — no single agent filter
  sp500_peter: "Peter",
  sp500_steven: "Steven",
  tiffany: "Tiffany",
  stefanie: "Stefanie",
  abby: "Abby",
  irma: "Irma",
  laila: "Laila",
};

const POWER_QUEUE_BASE = "https://lifestyledash-wpnl8v84.manus.space/sms-queue";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(d: Date | string | null): string {
  if (!d) return "Never";
  return new Date(d).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }) + " CT";
}

function formatDate(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: BotStatus }) {
  if (status === "ok") return (
    <Badge className="bg-green-50 text-green-700 border-green-200 gap-1">
      <CheckCircle2 className="h-3 w-3" /> Ran Today
    </Badge>
  );
  if (status === "warning") return (
    <Badge className="bg-yellow-50 text-yellow-700 border-yellow-200 gap-1">
      <AlertTriangle className="h-3 w-3" /> Warning
    </Badge>
  );
  if (status === "error") return (
    <Badge className="bg-red-50 text-red-700 border-red-200 gap-1">
      <XCircle className="h-3 w-3" /> Error
    </Badge>
  );
  return (
    <Badge className="bg-slate-50 text-slate-600 border-slate-200 gap-1">
      <Clock className="h-3 w-3" /> Not Yet Today
    </Badge>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface AgentViewProps {
  slug: string;
}

export default function AgentView({ slug }: AgentViewProps) {
  const colors = BOT_COLORS[slug] ?? BOT_COLORS["sp500"];
  const avatarLabel = BOT_AVATARS[slug] ?? slug.slice(0, 3).toUpperCase();
  const agentName = AGENT_NAMES[slug] ?? slug;

  const { data, isLoading, refetch, isFetching } = trpc.bots.agentView.useQuery(
    { slug },
    { refetchInterval: 2 * 60 * 1000 }
  );

  const pqAgentName = POWER_QUEUE_NAMES[slug] ?? "";
  const pqInput = useMemo(() => ({ agentName: pqAgentName }), [pqAgentName]);
  const { data: pqData, isLoading: pqLoading } = trpc.powerQueue.getLiveCount.useQuery(
    pqInput,
    { refetchInterval: 5 * 60 * 1000, enabled: !!pqAgentName }
  );

  const bot = data?.bot ?? null;
  const weeklyRuns = data?.weeklyRuns ?? [];
  const recentLeads = data?.recentLeads ?? [];

  return (
    <div className="min-h-screen bg-[#F8F9FC]">
      {/* Header Banner */}
      <header className="sticky top-0 z-40 w-full bg-white border-b border-[#E4E7EF]">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
          {/* Left: back link + agent identity */}
          <div className="flex items-center gap-3">
            <a
              href="https://lifestyledash-wpnl8v84.manus.space"
              className="hidden sm:flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium text-slate-600 bg-slate-50 hover:bg-slate-100 border border-[#E4E7EF] transition-all duration-150"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Bot Dashboard
            </a>
            <div className={`h-7 w-7 rounded-lg flex items-center justify-center text-[10px] font-bold ${colors.bg} ${colors.text} border ${colors.border} shrink-0`}>
              {avatarLabel}
            </div>
            <div className="leading-tight">
              <span className="font-semibold text-sm text-[#0F1117] tracking-tight">
                {bot?.name ?? `${agentName}'s Lifestyle Bot`}
              </span>
              <span className="hidden sm:inline text-xs text-slate-400 ml-1.5">
                / Lifestyle Design Realty
              </span>
            </div>
          </div>

          {/* Right: refresh */}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium text-slate-600 bg-slate-50 hover:bg-slate-100 border border-[#E4E7EF] transition-all duration-150"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </header>

      {/* Power Queue CTA Banner — amber accent on light background */}
      <div className="bg-amber-50 border-b border-amber-200">
        <div className="max-w-3xl mx-auto px-4 py-3">
          {POWER_QUEUE_NAMES[slug] !== undefined && (
            <a
              href={
                POWER_QUEUE_NAMES[slug]
                  ? `${POWER_QUEUE_BASE}?agent=${encodeURIComponent(POWER_QUEUE_NAMES[slug]!)}`
                  : POWER_QUEUE_BASE
              }
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between w-full bg-white hover:bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 transition-all duration-150 active:scale-[0.98]"
            >
              <div className="flex items-center gap-3">
                <div className="bg-amber-100 rounded-lg p-2">
                  <MessageCircle className="h-5 w-5 text-amber-600" />
                </div>
                <div>
                  <p className="text-[#0F1117] font-bold text-sm">Open Your Power Queue</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-slate-500 text-xs">
                      {POWER_QUEUE_NAMES[slug]
                        ? `Pre-filtered to ${POWER_QUEUE_NAMES[slug]}'s leads — tap to send texts`
                        : "Open shared Power Queue for all agents"}
                    </p>
                    {/* Live count badge */}
                    {pqAgentName && (
                      pqLoading ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 border border-amber-200 animate-pulse">...</span>
                      ) : (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                          (pqData?.count ?? 0) > 0
                            ? "bg-amber-500 text-white border-amber-600"
                            : "bg-green-50 text-green-700 border-green-200"
                        }`}>
                          {(pqData?.count ?? 0) > 0 ? `${pqData!.count} waiting` : "Queue clear ✓"}
                        </span>
                      )
                    )}
                  </div>
                </div>
              </div>
              <ExternalLink className="h-4 w-4 text-slate-400 flex-shrink-0" />
            </a>
          )}
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">

        {/* Today's KPI Cards */}
        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)}
          </div>
        ) : !bot ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <Bot className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">No bot data yet</p>
              <p className="text-xs mt-1 text-muted-foreground">
                Your bot will appear here after its first run at 10:05 AM CT.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Status + Last Run */}
            <Card>
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`p-2.5 rounded-lg ${colors.bg}`}>
                      <Bot className={`h-5 w-5 ${colors.text}`} />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Bot Status</p>
                      <div className="mt-0.5">
                        <StatusBadge status={bot.status as BotStatus} />
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Last Run</p>
                    <p className="text-sm font-semibold text-[#0F1117] mt-0.5">
                      {formatTime(bot.lastRanAt)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Today's Stats Grid */}
            <div className="grid grid-cols-3 gap-3">
              <Card>
                <CardContent className="pt-5 pb-4 text-center">
                  <div className="p-2 rounded-lg bg-green-50 w-fit mx-auto mb-2">
                    <Mail className="h-5 w-5 text-green-600" />
                  </div>
                  <p className="text-2xl font-bold text-green-700">{bot.sent}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Sent Today</p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-5 pb-4 text-center">
                  <div className="p-2 rounded-lg bg-slate-50 w-fit mx-auto mb-2">
                    <Activity className="h-5 w-5 text-slate-500" />
                  </div>
                  <p className="text-2xl font-bold text-slate-600">{bot.skipped}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Skipped</p>
                </CardContent>
              </Card>

              <Card className={bot.errored > 0 ? "border-red-200" : ""}>
                <CardContent className="pt-5 pb-4 text-center">
                  <div className={`p-2 rounded-lg w-fit mx-auto mb-2 ${bot.errored > 0 ? "bg-red-50" : "bg-slate-50"}`}>
                    <AlertTriangle className={`h-5 w-5 ${bot.errored > 0 ? "text-red-500" : "text-slate-400"}`} />
                  </div>
                  <p className={`text-2xl font-bold ${bot.errored > 0 ? "text-red-600" : "text-slate-400"}`}>
                    {bot.errored}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">Errors</p>
                </CardContent>
              </Card>
            </div>

            {/* Two-System Comparison Card — Bot vs Power Queue */}
            {pqAgentName && (
              <Card className="border-[#E4E7EF]">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-semibold text-[#0F1117] flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-slate-500" />
                    Lead Pipeline — Two Systems
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className="grid grid-cols-2 gap-3">
                    {/* Bot's side: 20+ day stale */}
                    <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="p-1.5 bg-green-100 rounded-lg">
                          <Bot className="h-4 w-4 text-green-700" />
                        </div>
                        <span className="text-[10px] font-bold text-green-800 uppercase tracking-wider">Bot’s Job</span>
                      </div>
                      <p className="text-3xl font-black text-green-700">{bot.sent}</p>
                      <p className="text-xs text-green-600 mt-1 font-medium">Emails sent today</p>
                      <p className="text-[10px] text-green-500 mt-0.5">20+ day stale leads</p>
                    </div>

                    {/* Agent's side: 1-20 day Power Queue */}
                    <div className={`border rounded-xl p-4 ${
                      pqLoading
                        ? "bg-slate-50 border-slate-200"
                        : (pqData?.count ?? 0) > 0
                          ? "bg-amber-50 border-amber-300"
                          : "bg-slate-50 border-slate-200"
                    }`}>
                      <div className="flex items-center gap-2 mb-2">
                        <div className={`p-1.5 rounded-lg ${
                          pqLoading ? "bg-slate-100" : (pqData?.count ?? 0) > 0 ? "bg-amber-100" : "bg-slate-100"
                        }`}>
                          <MessageCircle className={`h-4 w-4 ${
                            pqLoading ? "text-slate-400" : (pqData?.count ?? 0) > 0 ? "text-amber-700" : "text-slate-400"
                          }`} />
                        </div>
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${
                          pqLoading ? "text-slate-500" : (pqData?.count ?? 0) > 0 ? "text-amber-800" : "text-slate-500"
                        }`}>Your Job</span>
                      </div>
                      {pqLoading ? (
                        <div className="h-9 w-12 bg-slate-200 rounded animate-pulse mb-1" />
                      ) : (
                        <p className={`text-3xl font-black ${
                          (pqData?.count ?? 0) > 0 ? "text-amber-700" : "text-slate-400"
                        }`}>{pqData?.count ?? 0}</p>
                      )}
                      <p className={`text-xs mt-1 font-medium ${
                        pqLoading ? "text-slate-400" : (pqData?.count ?? 0) > 0 ? "text-amber-600" : "text-slate-400"
                      }`}>
                        {pqLoading ? "Loading..." : (pqData?.count ?? 0) > 0 ? "Need your personal text" : "Queue clear — great work!"}
                      </p>
                      <p className={`text-[10px] mt-0.5 ${
                        pqLoading ? "text-slate-300" : (pqData?.count ?? 0) > 0 ? "text-amber-500" : "text-slate-300"
                      }`}>1–20 day stale leads</p>
                    </div>
                  </div>
                  {/* Explanatory footer */}
                  <p className="text-[10px] text-slate-400 mt-3 leading-relaxed">
                    The bot handles 20+ day leads automatically. Your Power Queue shows 1–20 day leads that need a personal text from you — these are two completely separate groups.
                  </p>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Leads Contacted Today */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              Leads Contacted Today
              {recentLeads.length > 0 && (
                <Badge variant="outline" className="ml-1 text-xs">
                  {recentLeads.length}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {isLoading ? (
              <div className="space-y-2">
                {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            ) : recentLeads.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <User className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No leads contacted in the last 24 hours</p>
                <p className="text-xs mt-1">Your bot will contact stale leads at 10:05 AM CT.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {recentLeads.map((lead: any) => (
                  <div key={lead.id} className="flex items-start gap-3 p-3 rounded-lg bg-slate-50 border border-[#E4E7EF]">
                    <div className={`h-8 w-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0 ${colors.bg} ${colors.text}`}>
                      {(lead.leadFirstName?.[0] ?? "?").toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-[#0F1117]">
                          {[lead.leadFirstName, lead.leadLastName].filter(Boolean).join(" ") || "Unknown"}
                        </span>
                        {lead.stage && (
                          <Badge variant="outline" className="text-xs px-1.5 py-0">{lead.stage}</Badge>
                        )}
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {lead.daysStale}d stale
                        </span>
                      </div>
                      {lead.messageBody && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2 flex items-start gap-1">
                          <MessageSquare className="h-3 w-3 mt-0.5 flex-shrink-0" />
                          {lead.messageBody}
                        </p>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0">
                      {formatTime(lead.sentAt)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 7-Day Run History */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              7-Day Run History
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : weeklyRuns.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No run history in the past 7 days.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Sent</TableHead>
                    <TableHead className="text-right">Skipped</TableHead>
                    <TableHead className="text-right">Errors</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {weeklyRuns.map((row: any) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDate(row.ranAt)}
                      </TableCell>
                      <TableCell className="text-right text-green-700 font-semibold">{row.sent}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{row.skipped}</TableCell>
                      <TableCell className={`text-right font-semibold ${row.errored > 0 ? "text-red-600" : "text-muted-foreground"}`}>
                        {row.errored}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={row.status as BotStatus} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Daily Schedule Reference */}
        <Card className="border-dashed">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Your Bot's Daily Schedule (CT)
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="text-center p-3 rounded-lg bg-blue-50 border border-blue-100">
                <p className="font-bold text-blue-700">10:00 AM</p>
                <p className="text-xs text-blue-600 mt-1">Clock-in email sent to you</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-green-50 border border-green-100">
                <p className="font-bold text-green-700">10:05 AM</p>
                <p className="text-xs text-green-600 mt-1">Bot runs & contacts stale leads</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-amber-50 border border-amber-100">
                <p className="font-bold text-amber-700">6:00 PM</p>
                <p className="text-xs text-amber-600 mt-1">Clock-off summary emailed</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Footer */}
        <div className="text-center pb-6">
          <p className="text-xs text-muted-foreground">
            Powered by <strong>Lifestyle Technologies</strong> &nbsp;·&nbsp; Lifestyle Design Realty &nbsp;·&nbsp; Auto-refreshes every 2 minutes
          </p>
        </div>

      </div>
    </div>
  );
}
