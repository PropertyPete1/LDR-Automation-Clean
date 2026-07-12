import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Users,
  RefreshCw,
  TrendingUp,
  AlertCircle,
  CheckCircle2,
  Clock,
  Bot,
  ExternalLink,
  Droplets,
  Activity,
} from "lucide-react";
import { useState } from "react";

const AGENT_COLORS: Record<string, string> = {
  peter: "bg-orange-500",
  steven: "bg-blue-600",
  tiffany: "bg-teal-500",
  rue: "bg-pink-500",
  // Stefanie Graham's first name is "Stefanie" — alias to rue's color
  stefanie: "bg-pink-500",
  abby: "bg-purple-500",
  irma: "bg-amber-600",
  laila: "bg-green-600",
};

const AGENT_ROLES: Record<string, string> = {
  peter: "Realtor & Owner",
  steven: "Broker & Owner",
  tiffany: "Austin",
  rue: "San Antonio",
  // Stefanie Graham's first name is "Stefanie" — alias to rue's role
  stefanie: "San Antonio",
  abby: "Austin",
  irma: "DFW",
  laila: "San Antonio",
};

// Map FUB first-name keys to bot slugs for health status lookup
const AGENT_BOT_SLUG: Record<string, string> = {
  peter: "sp500_peter",
  steven: "sp500_steven",
  tiffany: "tiffany",
  rue: "stefanie",
  stefanie: "stefanie",
  abby: "abby",
  irma: "irma",
  laila: "laila",
};

function getAgentKey(name: string): string {
  return name.split(" ")[0].toLowerCase();
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

function AgentCard({
  agent,
}: {
  agent: {
    id: number;
    name: string;
    email: string;
    totalLeads: number;
    hotLeads: number;
    activeClients: number;
    pipeline: number;
  };
}) {
  const key = getAgentKey(agent.name);
  const color = AGENT_COLORS[key] ?? "bg-slate-500";
  const role = AGENT_ROLES[key] ?? "";

  return (
    <Card className="hover:bg-slate-50 transition-colors cursor-pointer border">
      <CardContent className="p-4">
        <div className="flex items-start gap-3 mb-3">
          <div
            className={`h-10 w-10 rounded-full ${color} flex items-center justify-center text-white font-semibold text-sm shrink-0`}
          >
            {getInitials(agent.name)}
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-sm truncate">{agent.name}</p>
            <p className="text-xs text-muted-foreground truncate">{role}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {agent.totalLeads} leads
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-lg font-bold text-amber-600">
              {agent.activeClients}
            </p>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Active
            </p>
          </div>
          <div>
            <p className="text-lg font-bold text-red-600">{agent.hotLeads}</p>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Hot
            </p>
          </div>
          <div>
            <p className="text-lg font-bold text-[#0F1117]">
              {agent.pipeline}
            </p>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Pipeline
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BotStatusRow({
  bot,
}: {
  bot: {
    slug: string;
    name: string;
    ranToday: boolean;
    sent: number;
    errored: number;
    skipped: number;
    lastRanAt: Date | null;
    status: string;
  };
}) {
  const statusColor =
    bot.status === "ok" || bot.ranToday
      ? "bg-green-50 text-green-700 border border-green-200"
      : bot.status === "warning"
      ? "bg-yellow-50 text-yellow-700 border border-yellow-200"
      : bot.status === "error"
      ? "bg-red-50 text-red-700 border border-red-200"
      : "bg-slate-50 text-slate-600 border border-slate-200";

  const statusLabel =
    bot.ranToday && bot.status !== "error"
      ? "Ran Today"
      : bot.status === "warning"
      ? "Warning"
      : bot.status === "error"
      ? "Error"
      : "Not Yet";

  return (
    <div className="flex items-center justify-between py-2.5 border-b last:border-0">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
          <Bot className="h-4 w-4 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium">{bot.name}</p>
          <p className="text-xs text-muted-foreground">
            Last ran:{" "}
            {bot.lastRanAt
              ? new Date(bot.lastRanAt).toLocaleString()
              : "Never"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-muted-foreground">
          {bot.sent} sent
        </span>
        {bot.errored > 0 && (
          <span className="text-xs text-red-600 font-medium">
            {bot.errored} err
          </span>
        )}
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColor}`}
        >
          {statusLabel}
        </span>
      </div>
    </div>
  );
}

// System services that map to bot slugs for live status
const SYSTEM_SERVICES = [
  { label: "Peter Bot", slug: "sp500_peter" },
  { label: "Steven Bot", slug: "sp500_steven" },
  { label: "Tiffany Bot", slug: "tiffany" },
  { label: "Rue Bot", slug: "stefanie" },
  { label: "Abby Bot", slug: "abby" },
  { label: "Irma Bot", slug: "irma" },
  { label: "Laila Bot", slug: "laila" },
];

export default function PondNurture() {
  const [agentRefetchKey, setAgentRefetchKey] = useState(0);

  const { data: agentStats, isLoading: agentsLoading, refetch: refetchAgents } =
    trpc.pondNurture.agentStats.useQuery(undefined, {
      staleTime: 2 * 60 * 1000,
      refetchInterval: 2 * 60 * 1000,
    });

  const { data: pondMetrics, isLoading: metricsLoading, refetch: refetchMetrics } =
    trpc.pondNurture.pondMetrics.useQuery(undefined, {
      staleTime: 2 * 60 * 1000,
      refetchInterval: 2 * 60 * 1000,
    });

  const { data: botHealth, isLoading: botsLoading, refetch: refetchBots } =
    trpc.bots.health.useQuery(undefined, {
      staleTime: 60 * 1000,
      refetchInterval: 2 * 60 * 1000,
    });

  const handleRefreshAll = () => {
    refetchAgents();
    refetchMetrics();
    refetchBots();
    setAgentRefetchKey((k) => k + 1);
  };

  const totalLeads = agentStats?.reduce((s, a) => s + a.totalLeads, 0) ?? 0;
  const totalHot = agentStats?.reduce((s, a) => s + a.hotLeads, 0) ?? 0;
  const totalActive = agentStats?.reduce((s, a) => s + a.activeClients, 0) ?? 0;
  const totalPipeline = agentStats?.reduce((s, a) => s + a.pipeline, 0) ?? 0;

  const botsRanToday = botHealth?.filter((b) => b.ranToday).length ?? 0;
  const totalBots = botHealth?.length ?? 6;
  const totalErrors = botHealth?.reduce((s, b) => s + b.errored, 0) ?? 0;

  // Build a lookup map from bot slug → health status for System Status badges
  const botStatusMap = new Map<string, string>();
  if (botHealth) {
    for (const b of botHealth) {
      botStatusMap.set(b.slug, b.status);
    }
  }

  function getServiceBadgeClass(slug: string): string {
    const status = botStatusMap.get(slug);
    if (!status || status === "ok") return "bg-green-50 text-green-700 border-green-200";
    if (status === "warning") return "bg-yellow-50 text-yellow-700 border-yellow-200";
    if (status === "error") return "bg-red-50 text-red-700 border-red-200";
    // never ran yet — neutral
    return "bg-slate-50 text-slate-600 border-slate-200";
  }

  function getServiceIcon(slug: string): string {
    const status = botStatusMap.get(slug);
    if (!status || status === "ok") return "✓";
    if (status === "warning") return "⚠";
    if (status === "error") return "✗";
    return "○";
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Pond Nurture</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Lifestyle Design Realty · Live pipeline &amp; automation overview
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshAll}
            className="gap-2"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh All
          </Button>
          <Button
            size="sm"
            className="gap-2"
            onClick={() =>
              window.open("https://app.followupboss.com/2/people", "_blank")
            }
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Full Dashboard
          </Button>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Total Leads</span>
            </div>
            <p className="text-2xl font-bold">
              {agentsLoading ? "—" : totalLeads.toLocaleString()}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle className="h-4 w-4 text-red-500" />
              <span className="text-xs text-muted-foreground">Hot Prospects</span>
            </div>
            <p className="text-2xl font-bold text-red-600">
              {agentsLoading ? "—" : totalHot}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 className="h-4 w-4 text-orange-500" />
              <span className="text-xs text-muted-foreground">Active Clients</span>
            </div>
            <p className="text-2xl font-bold text-amber-600">
              {agentsLoading ? "—" : totalActive}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="h-4 w-4 text-blue-500" />
              <span className="text-xs text-muted-foreground">Pipeline</span>
            </div>
            <p className="text-2xl font-bold text-[#0F1117]">
              {agentsLoading ? "—" : totalPipeline.toLocaleString()}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Droplets className="h-4 w-4 text-cyan-500" />
              <span className="text-xs text-muted-foreground">In Pond</span>
            </div>
            <p className="text-2xl font-bold text-[#0F1117]">
              {metricsLoading ? "—" : (pondMetrics?.pondTotal ?? 0).toLocaleString()}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-4 w-4 text-amber-500" />
              <span className="text-xs text-muted-foreground">Stale (20d+)</span>
            </div>
            <p className="text-2xl font-bold text-amber-600">
              {metricsLoading ? "—" : (pondMetrics?.staleTotal ?? 0).toLocaleString()}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agent Command Center */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Agent Command Center
            </h2>
            <Badge variant="outline" className="text-xs">
              Live from FUB
            </Badge>
          </div>
          {agentsLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {Array.from({ length: 7 }).map((_, i) => (
                <Card key={i} className="animate-pulse">
                  <CardContent className="p-4 h-32" />
                </Card>
              ))}
            </div>
          ) : agentStats && agentStats.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {agentStats.map((agent) => (
                <AgentCard key={agent.id} agent={agent} />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <Users className="h-8 w-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">
                  No agent data — check FUB API key in settings
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Agent Bot Activity */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Bot className="h-5 w-5 text-primary" />
              Agent Bot Activity
            </h2>
            <div className="flex items-center gap-2">
              <Badge
                variant={botsRanToday === totalBots ? "default" : "secondary"}
                className="text-xs"
              >
                {botsRanToday}/{totalBots} ran today
              </Badge>
              {totalErrors > 0 && (
                <Badge variant="destructive" className="text-xs">
                  {totalErrors} errors
                </Badge>
              )}
            </div>
          </div>

          <Card>
            <CardContent className="p-4">
              {botsLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-12 bg-muted animate-pulse rounded"
                    />
                  ))}
                </div>
              ) : botHealth && botHealth.length > 0 ? (
                <div>
                  {botHealth.map((bot) => (
                    <BotStatusRow key={bot.slug} bot={bot} />
                  ))}
                </div>
              ) : (
                <div className="text-center text-muted-foreground py-6">
                  <Bot className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">No bot activity yet</p>
                  <p className="text-xs mt-1">
                    Bots run daily at 10am CT
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Live Status Badges — wired to real bot health */}
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="h-4 w-4 text-green-500" />
                System Status
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="flex flex-wrap gap-1.5">
                {SYSTEM_SERVICES.map(({ label, slug }) => (
                  <Badge
                    key={slug}
                    variant="outline"
                    className={`text-[10px] ${getServiceBadgeClass(slug)}`}
                  >
                    {getServiceIcon(slug)} {label}
                  </Badge>
                ))}
              </div>
              <Separator className="my-3" />
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-sm font-bold">20d</p>
                  <p className="text-[10px] text-muted-foreground">Stale Threshold</p>
                </div>
                <div>
                  <p className="text-sm font-bold">14d</p>
                  <p className="text-[10px] text-muted-foreground">Nurture Cadence</p>
                </div>
                <div>
                  <p className="text-sm font-bold">15/run</p>
                  <p className="text-[10px] text-muted-foreground">Bot Cap</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Link to full old dashboard */}
          <Card className="border-dashed">
            <CardContent className="p-4 text-center">
              <p className="text-xs text-muted-foreground mb-2">
                Full pond nurture analytics, audit logs, and city personalization
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-full gap-2 text-xs"
                onClick={() =>
                  window.open(
                    "https://app.followupboss.com/2/people",
                    "_blank"
                  )
                }
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open FUB People
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
