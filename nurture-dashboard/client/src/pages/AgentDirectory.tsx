import React, { useMemo } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, ArrowRight } from "lucide-react";

// Dynamic: roster from trpc.agent.getRoster (Golden Rule — no hardcoded names)
import { trpc } from "@/lib/trpc";
import { getAgentAvatarGradient } from "@shared/agentColors";

export default function AgentDirectory() {
  // URL-param access context
  const urlAdminToken = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("admin") ?? "";
  }, []);
  const urlAgent = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("agent") ?? "";
  }, []);
  const accessParams = useMemo(() => ({
    ...(urlAdminToken ? { adminToken: urlAdminToken } : {}),
    ...(urlAgent ? { agent: urlAgent } : {}),
  }), [urlAdminToken, urlAgent]);

  const { data: rosterData } = trpc.agent.getRoster.useQuery(accessParams, { staleTime: 10 * 60_000 });
  const AGENTS = (rosterData?.roster ?? []).map(a => ({
    name: a.name,
    initial: a.name.charAt(0).toUpperCase(),
    color: getAgentAvatarGradient(a.slug),
    role: a.slug === "peter" ? "Broker / Owner" : "Agent",
    isOwner: a.slug === "peter",
  }));

  return (
    <div className="min-h-screen bg-background gold-glow-bg pb-16">
      {/* ── Header ── */}
      <header className="sticky top-0 z-50 w-full border-b border-white/8 bg-background/95 backdrop-blur-md">
        <div className="container flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="icon" className="h-9 w-9 rounded-lg text-muted-foreground hover:bg-card/8 hover:text-foreground">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-base font-semibold text-white tracking-tight">Agent Command Centers</h1>
              </div>
              <p className="text-[11px] text-muted-foreground tracking-wide">
                Lifestyle Design Realty <span className="text-[oklch(0.76_0.14_78/40%)]">·</span> Select your dashboard
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
            <Badge className="bg-[oklch(0.76_0.14_78/10%)] text-[oklch(0.76_0.14_78)] border border-[oklch(0.76_0.14_78/25%)] hover:bg-[oklch(0.76_0.14_78/15%)] text-[10px] px-2 py-0.5 font-mono">
              {AGENTS.length > 0 ? `${AGENTS.length - 1} Agents + Broker` : "Loading..."}
            </Badge>
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <div className="relative overflow-hidden bg-gradient-to-r from-[oklch(0.76_0.14_78/5%)] via-card to-[oklch(0.76_0.14_78/5%)] border-b border-[oklch(0.76_0.14_78/12%)]">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(212,175,55,0.06)_0%,transparent_70%)] pointer-events-none" />
        <div className="container max-w-4xl px-4 py-10 text-center">
          <p className="text-[10px] font-light tracking-[0.4em] text-amber-500 uppercase mb-3">
            Personal Command Centers
          </p>
          <h2 className="text-3xl font-light text-foreground tracking-wide mb-2">
            Select Your{" "}
            <span className="font-semibold text-[oklch(0.76_0.14_78)]">Dashboard</span>
          </h2>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Each agent has a personal dashboard showing only their assigned leads, sorted by priority tier.
            Bookmark your link for quick daily access.
          </p>
          <div className="flex items-center justify-center gap-1.5 mt-4">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-[10px] text-[oklch(0.76_0.14_78)] font-mono tracking-wider uppercase">Live Data from Follow Up Boss</span>
          </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-amber-500/20 to-transparent" />
      </div>

      {/* ── Agent Grid ── */}
      <main className="container max-w-4xl px-4 py-10">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {AGENTS.map((agent) => (
            <Link key={agent.name} href={`/agent/${agent.name.toLowerCase()}`}>
              <Card className="group relative overflow-hidden bg-card border border-white/8 hover:border-[oklch(0.76_0.14_78/35%)] transition-all duration-300 hover:shadow-[0_0_28px_rgba(212,175,55,0.10)] cursor-pointer">
                {/* Subtle gradient overlay on hover */}
                <div className="absolute inset-0 bg-gradient-to-br from-amber-500/0 to-amber-500/0 group-hover:from-amber-500/3 group-hover:to-transparent transition-all duration-500 pointer-events-none" />

                <div className="p-6 flex items-center gap-4">
                  {/* Avatar */}
                  <div className={`h-14 w-14 rounded-2xl bg-gradient-to-br ${agent.color} flex items-center justify-center text-white text-xl font-bold shadow-lg flex-shrink-0`}>
                    {agent.initial}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold text-white tracking-tight">{agent.name}</h3>
                      {agent.isOwner && (
                        <span className="text-[9px] font-bold tracking-widest uppercase px-1.5 py-0.5 rounded bg-[oklch(0.76_0.14_78/12%)] text-[oklch(0.76_0.14_78)] border border-[oklch(0.76_0.14_78/30%)]">Owner</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{agent.role}</p>
                    <p className="text-[10px] text-amber-500 font-mono mt-1 tracking-wider uppercase">
                      /agent/{agent.name.toLowerCase()}
                    </p>
                  </div>

                  {/* Arrow */}
                  <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-[oklch(0.76_0.14_78)] group-hover:translate-x-0.5 transition-all duration-200 flex-shrink-0" />
                </div>

                {/* Bottom accent line */}
                <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-amber-500/0 group-hover:via-amber-500/20 to-transparent transition-all duration-500" />
              </Card>
            </Link>
          ))}
        </div>

        {/* ── Tip ── */}
        <div className="mt-10 text-center space-y-2">
          <p className="text-xs text-muted-foreground">
            <span className="text-[oklch(0.76_0.14_78/70%)]">Tip:</span> Bookmark your personal dashboard URL for instant daily access from any device.
          </p>
          <p className="text-[10px] text-muted-foreground/40 tracking-[0.2em] uppercase">
            Powered by Lifestyle Technologies · Lifestyle Design Realty
          </p>
        </div>
      </main>
    </div>
  );
}
