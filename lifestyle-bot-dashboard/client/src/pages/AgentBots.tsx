import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Mail,
  RefreshCw,
  XCircle,
  Activity,
  TrendingUp,
  Users,
  ChevronRight,
  User,
  Calendar,
  MessageSquare,
} from "lucide-react";
import { useState, useMemo } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type BotStatus = "ok" | "warning" | "error" | "not_run";

interface BotHealth {
  slug: string;
  name: string;
  lastRanAt: Date | string | null;
  sent: number;
  errored: number;
  skipped: number;
  status: BotStatus;
  ranToday: boolean;
}

interface ContactedLead {
  id: number;
  botSlug: string;
  botName: string;
  personId: number;
  leadFirstName: string | null;
  leadLastName: string | null;
  leadEmail: string | null;
  stage: string | null;
  daysStale: number;
  messageBody: string | null;
  sentAt: Date | string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BOT_AVATARS: Record<string, string> = {
  sp500: "S&P",
  sp500_peter: "PET",
  sp500_steven: "STV",
  tiffany: "TIF",
  stefanie: "RUE",
  abby: "ABB",
  irma: "IRM",
  laila: "LAI",
};

const BOT_COLORS: Record<string, string> = {
  sp500: "bg-blue-100 text-blue-800",
  sp500_peter: "bg-orange-100 text-orange-800",
  sp500_steven: "bg-blue-100 text-blue-800",
  tiffany: "bg-purple-100 text-purple-800",
  stefanie: "bg-pink-100 text-pink-800",
  abby: "bg-amber-100 text-amber-800",
  irma: "bg-teal-100 text-teal-800",
  laila: "bg-rose-100 text-rose-800",
};

function StatusBadge({ status }: { status: BotStatus }) {
  if (status === "ok") {
    return (
      <Badge className="bg-green-50 text-green-700 border-green-200 gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Ran Today
      </Badge>
    );
  }
  if (status === "warning") {
    return (
      <Badge className="bg-yellow-50 text-yellow-700 border-yellow-200 gap-1">
        <AlertTriangle className="h-3 w-3" />
        Warning
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge className="bg-red-50 text-red-700 border-red-200 gap-1">
        <XCircle className="h-3 w-3" />
        Error
      </Badge>
    );
  }
  return (
    <Badge className="bg-slate-50 text-slate-600 border-slate-200 gap-1">
      <Clock className="h-3 w-3" />
      Not Yet
    </Badge>
  );
}

function formatLastRan(lastRanAt: Date | string | null): string {
  if (!lastRanAt) return "Never";
  const d = new Date(lastRanAt);
  return d.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }) + " CT";
}

// ─── Summary KPI bar ─────────────────────────────────────────────────────────

function SummaryKPIs({ bots, sentToday, errorsToday }: { bots: BotHealth[]; sentToday?: number; errorsToday?: number }) {
  const totalSent = sentToday ?? bots.reduce((s, b) => s + b.sent, 0);
  const totalErrors = errorsToday ?? bots.reduce((s, b) => s + b.errored, 0);
  const ranToday = bots.filter(b => b.ranToday).length;
  // Before 10:05 AM CT, bots haven't run yet — "not_run" is expected, not a warning
  const nowCT = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const beforeRunTime = nowCT.getHours() < 10 || (nowCT.getHours() === 10 && nowCT.getMinutes() < 5);
  // sp500_peter and sp500_steven are newly split slugs — treat "not_run" as ok until they accumulate history
  const newSlugs = new Set(["sp500_peter", "sp500_steven"]);
  const allOk = bots.every(b =>
    b.status === "ok" ||
    (beforeRunTime && b.status === "not_run") ||
    (newSlugs.has(b.slug) && b.status === "not_run")
  );

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <Card>
        <CardContent className="pt-5 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-50">
              <Activity className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Bots Ran Today</p>
              <p className="text-2xl font-bold text-foreground">
                {ranToday}
                <span className="text-sm font-normal text-muted-foreground">/{bots.length}</span>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50">
              <Mail className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Follow-ups Sent Today</p>
              <p className="text-2xl font-bold text-foreground">{totalSent}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5 pb-4">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${totalErrors > 0 ? "bg-red-50" : "bg-green-50"}`}>
              <AlertTriangle className={`h-5 w-5 ${totalErrors > 0 ? "text-red-500" : "text-green-600"}`} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Errors</p>
              <p className={`text-2xl font-bold ${totalErrors > 0 ? "text-red-600" : "text-green-600"}`}>
                {totalErrors}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5 pb-4">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${allOk ? "bg-green-50" : "bg-yellow-50"}`}>
              <TrendingUp className={`h-5 w-5 ${allOk ? "text-green-600" : "text-yellow-600"}`} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">System Health</p>
              <p className={`text-lg font-bold ${allOk ? "text-green-600" : "text-yellow-600"}`}>
                {allOk ? (beforeRunTime && ranToday === 0 ? "Awaiting Run" : "All Clear") : "Needs Attention"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Lead List Modal ──────────────────────────────────────────────────────────

function LeadListModal({
  bot,
  open,
  onClose,
}: {
  bot: BotHealth | null;
  open: boolean;
  onClose: () => void;
}) {
  const { data: leads, isLoading } = trpc.bots.contactedLeads.useQuery(
    { slug: bot?.slug ?? "", hours: 24 },
    { enabled: open && !!bot?.slug }
  );

  if (!bot) return null;

  const avatarLabel = BOT_AVATARS[bot.slug] ?? bot.slug.slice(0, 3).toUpperCase();
  const colorClass = BOT_COLORS[bot.slug] ?? "bg-gray-100 text-gray-800";

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className={`h-9 w-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${colorClass}`}>
              {avatarLabel}
            </div>
            <div>
              <DialogTitle className="text-base">{bot.name} — Leads Contacted Today</DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                Showing leads emailed in the last 24 hours · {leads?.length ?? 0} lead{leads?.length !== 1 ? "s" : ""}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto mt-2">
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : !leads || leads.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <User className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">No leads contacted in the last 24 hours</p>
              <p className="text-xs mt-1">This bot hasn't run today yet, or no eligible leads were found.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {leads.map((lead: ContactedLead) => (
                <Card key={lead.id} className="border border-border/60">
                  <CardContent className="py-3 px-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        {/* Lead name + stage + days stale */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-foreground">
                            {[lead.leadFirstName, lead.leadLastName].filter(Boolean).join(" ") || "Unknown Lead"}
                          </span>
                          {lead.stage && (
                            <Badge variant="outline" className="text-xs px-1.5 py-0">
                              {lead.stage}
                            </Badge>
                          )}
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Calendar className="h-3 w-3" />
                            {lead.daysStale}d stale
                          </span>
                        </div>
                        {/* Lead email */}
                        {lead.leadEmail && (
                          <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                            <Mail className="h-3 w-3" />
                            {lead.leadEmail}
                          </p>
                        )}
                        {/* Message preview */}
                        {lead.messageBody && (
                          <div className="mt-2 p-2 rounded-md bg-muted/50 border border-border/40">
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                              <MessageSquare className="h-3 w-3" />
                              Message sent:
                            </p>
                            <p className="text-xs text-foreground leading-relaxed line-clamp-4">
                              {lead.messageBody}
                            </p>
                          </div>
                        )}
                      </div>
                      {/* Sent time */}
                      <div className="text-right flex-shrink-0">
                        <p className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatLastRan(lead.sentAt)}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Bot Card ─────────────────────────────────────────────────────────────────

function BotCard({ bot, onClick }: { bot: BotHealth; onClick: () => void }) {
  const avatarLabel = BOT_AVATARS[bot.slug] ?? bot.slug.slice(0, 3).toUpperCase();
  const colorClass = BOT_COLORS[bot.slug] ?? "bg-gray-100 text-gray-800";

  return (
    <Card
      className={`transition-all hover:bg-slate-50 cursor-pointer group ${
        bot.status === "error"
          ? "border-red-200"
          : bot.status === "warning"
          ? "border-yellow-200"
          : ""
      }`}
      onClick={onClick}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`h-10 w-10 rounded-full flex items-center justify-center text-xs font-bold ${colorClass}`}>
              {avatarLabel}
            </div>
            <div>
              <CardTitle className="text-sm font-semibold leading-tight">{bot.name}</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                <Clock className="h-3 w-3 inline mr-1" />
                {formatLastRan(bot.lastRanAt)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={bot.status} />
            <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center p-2 rounded-lg bg-green-50 border border-green-100">
            <p className="text-xl font-bold text-green-700">{bot.sent}</p>
            <p className="text-xs text-green-600 mt-0.5">Sent</p>
          </div>
          <div className="text-center p-2 rounded-lg bg-slate-50 border border-slate-100">
            <p className="text-xl font-bold text-slate-600">{bot.skipped}</p>
            <p className="text-xs text-slate-500 mt-0.5">Skipped</p>
          </div>
          <div className={`text-center p-2 rounded-lg border ${bot.errored > 0 ? "bg-red-50 border-red-100" : "bg-slate-50 border-slate-100"}`}>
            <p className={`text-xl font-bold ${bot.errored > 0 ? "text-red-600" : "text-slate-400"}`}>
              {bot.errored}
            </p>
            <p className={`text-xs mt-0.5 ${bot.errored > 0 ? "text-red-500" : "text-slate-400"}`}>Errors</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground text-center mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
          Click to view leads contacted today
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Weekly Stats Table ───────────────────────────────────────────────────────

function WeeklyStatsTable({ slugFilter }: { slugFilter: string | null }) {
  const { data: weeklyData, isLoading } = trpc.bots.weeklyStats.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  const filtered = useMemo(() => {
    if (!weeklyData) return [];
    if (slugFilter) return weeklyData.filter((r: any) => r.botSlug === slugFilter);
    return weeklyData;
  }, [weeklyData, slugFilter]);

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!filtered.length) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        No run history in the past 7 days.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Bot</TableHead>
          <TableHead>Ran At (CT)</TableHead>
          <TableHead className="text-right">Sent</TableHead>
          <TableHead className="text-right">Skipped</TableHead>
          <TableHead className="text-right">Errors</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {filtered.map((row: any) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium text-sm">{row.botName}</TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {formatLastRan(row.ranAt)}
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
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AgentBots() {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [modalBot, setModalBot] = useState<BotHealth | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const { data: healthData, isLoading, refetch, isFetching } = trpc.bots.health.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  const { data: todayStats } = trpc.bots.todayStats.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  const bots: BotHealth[] = healthData ?? [];

  function handleBotClick(bot: BotHealth) {
    setModalBot(bot);
    setModalOpen(true);
    setSelectedSlug(bot.slug);
  }

  function handleModalClose() {
    setModalOpen(false);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Bot className="h-6 w-6 text-primary" />
            Agent Bot Activity
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live status for all Lifestyle Bots — click any bot card to see leads contacted today
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors px-3 py-2 rounded-lg hover:bg-accent"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Summary KPIs */}
      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : (
        <SummaryKPIs bots={bots} sentToday={todayStats?.sentToday} errorsToday={todayStats?.errorsToday} />
      )}

      {/* Bot Cards Grid */}
      <div>
        <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          Per-Agent Bot Status
          <span className="text-xs font-normal text-muted-foreground ml-1">— click a card to see today's leads</span>
        </h2>
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-44" />)}
          </div>
        ) : bots.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <Bot className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No bot run data yet. Bots will appear here after their first run.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {bots.map(bot => (
              <BotCard
                key={bot.slug}
                bot={bot}
                onClick={() => handleBotClick(bot)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 7-Day Run History */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            7-Day Run History
            {selectedSlug && (
              <Badge
                variant="outline"
                className="ml-2 cursor-pointer text-xs"
                onClick={() => setSelectedSlug(null)}
              >
                {bots.find(b => b.slug === selectedSlug)?.name ?? selectedSlug} ✕
              </Badge>
            )}
          </CardTitle>
          {!selectedSlug && (
            <p className="text-xs text-muted-foreground">Click a bot card above to filter by agent</p>
          )}
        </CardHeader>
        <CardContent className="pt-0">
          <WeeklyStatsTable slugFilter={selectedSlug} />
        </CardContent>
      </Card>

      {/* Schedule Reference */}
      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Daily Schedule (all times CT)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="font-mono bg-muted px-2 py-0.5 rounded text-xs">10:00 AM</span>
              Clock-in email sent to each agent + Peter &amp; Steven
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="font-mono bg-muted px-2 py-0.5 rounded text-xs">10:05 AM</span>
              Bot runs &amp; sends follow-up emails to leads
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="font-mono bg-muted px-2 py-0.5 rounded text-xs">6:00 PM</span>
              Clock-off summary email sent to each agent + Peter &amp; Steven
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Lead List Modal */}
      <LeadListModal
        bot={modalBot}
        open={modalOpen}
        onClose={handleModalClose}
      />
    </div>
  );
}
