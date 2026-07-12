import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot, Activity, Mail, AlertTriangle, CheckCircle2, Clock, ArrowRight } from "lucide-react";
import { useLocation } from "wouter";

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

type BotStatus = "ok" | "warning" | "error" | "not_run";

function StatusBadge({ status }: { status: BotStatus }) {
  if (status === "ok") {
    return (
      <Badge className="bg-green-50 text-green-700 border-green-200 gap-1 text-xs">
        <CheckCircle2 className="h-3 w-3" />
        Ran Today
      </Badge>
    );
  }
  if (status === "warning") {
    return (
      <Badge className="bg-yellow-50 text-yellow-700 border-yellow-200 gap-1 text-xs">
        <AlertTriangle className="h-3 w-3" />
        Warning
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge className="bg-red-50 text-red-700 border-red-200 gap-1 text-xs">
        <AlertTriangle className="h-3 w-3" />
        Error
      </Badge>
    );
  }
  return (
      <Badge className="bg-slate-50 text-slate-600 border-slate-200 gap-1 text-xs">
      <Clock className="h-3 w-3" />
      Not Yet
    </Badge>
  );
}

export default function Home() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  const { data: healthData, isLoading: healthLoading } = trpc.bots.health.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  const { data: todayStats, isLoading: statsLoading } = trpc.bots.todayStats.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  const isLoading = healthLoading || statsLoading;
  const bots = healthData ?? [];
  const totalSent = todayStats?.sentToday ?? 0;
  const totalErrors = todayStats?.errorsToday ?? 0;
  const ranToday = todayStats?.botsRanToday ?? bots.filter((b: any) => b.ranToday).length;

  return (
    <div className="space-y-6">
      {/* Welcome Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Welcome back{user?.name ? `, ${user.name.split(" ")[0]}` : ""}! 👋
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Lifestyle Design Realty — Automation Command Center
        </p>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-50">
                <Bot className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Active Bots</p>
                <p className="text-2xl font-bold">{isLoading ? "—" : bots.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-50">
                <Activity className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Ran Today</p>
                {isLoading ? (
                  <Skeleton className="h-8 w-12 mt-1" />
                ) : (
                  <p className="text-2xl font-bold">
                    {ranToday}
                    <span className="text-sm font-normal text-muted-foreground">/{bots.length}</span>
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-50">
                <Mail className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Sent Today</p>
                {isLoading ? (
                  <Skeleton className="h-8 w-12 mt-1" />
                ) : (
                  <p className="text-2xl font-bold">{totalSent}</p>
                )}
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
                <p className="text-xs text-muted-foreground">Errors</p>
                {isLoading ? (
                  <Skeleton className="h-8 w-12 mt-1" />
                ) : (
                  <p className={`text-2xl font-bold ${totalErrors > 0 ? "text-red-600" : "text-green-600"}`}>
                    {totalErrors}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Agent Bot Quick Status */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Bot className="h-4 w-4 text-muted-foreground" />
              Agent Bot Status
            </CardTitle>
            <button
              onClick={() => setLocation("/agent-bots")}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              View All
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : bots.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              <Bot className="h-8 w-8 mx-auto mb-2 opacity-30" />
              No bot run data yet. Bots will appear here after their first scheduled run.
            </div>
          ) : (
            <div className="space-y-2">
              {bots.map((bot: any) => (
                <div
                  key={bot.slug}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/40 hover:bg-muted/70 transition-colors cursor-pointer"
                  onClick={() => setLocation("/agent-bots")}
                >
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <Bot className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{bot.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Last ran: {formatLastRan(bot.lastRanAt)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right hidden sm:block">
                      <p className="text-sm font-semibold text-green-700">{bot.sent} sent</p>
                      {bot.errored > 0 && (
                        <p className="text-xs text-red-500">{bot.errored} errors</p>
                      )}
                    </div>
                    <StatusBadge status={bot.status as BotStatus} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Schedule Info */}
      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Daily Bot Schedule (all times CT)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="font-mono bg-muted px-2 py-0.5 rounded text-xs">10:00 AM</span>
              Clock-in emails → each agent + Peter &amp; Steven
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="font-mono bg-muted px-2 py-0.5 rounded text-xs">10:05 AM</span>
              Bots run follow-ups on stale leads
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="font-mono bg-muted px-2 py-0.5 rounded text-xs">6:00 PM</span>
              Clock-off summary emails sent
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
