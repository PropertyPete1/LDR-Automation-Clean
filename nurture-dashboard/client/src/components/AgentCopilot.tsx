import { useState, useRef, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Sparkles,
  X,
  Send,
  User,
  ChevronDown,
  Loader2,
  MessageSquareText,
  FileText,
  HelpCircle,
  Mail,
  Brain,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { trpc } from "@/lib/trpc";

export type CopilotLead = {
  id: number;
  name: string;
  phone?: string;
  stage?: string;
  city?: string;
  days_stale?: number;
  assigned_agent?: string;
  sms_body?: string;
  notes?: string;
  last_inbound_text?: string;
};

type Message = {
  role: "user" | "assistant";
  content: string;
};

type QuickAction = {
  label: string;
  icon: React.ReactNode;
  prompt: string;
};

interface AgentCopilotProps {
  leads?: CopilotLead[];
  initialLead?: CopilotLead | null;
}

export function AgentCopilot({ leads: propLeads, initialLead }: AgentCopilotProps) {
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

  // Self-fetch leads so the lead selector works on any page
  const { data: fetchedLeads } = trpc.fub.getPendingQueue.useQuery(
    { agentFilter: urlAgent || undefined, adminToken: urlAdminToken || undefined },
    {
      staleTime: 5 * 60 * 1000, // cache for 5 minutes
      enabled: !propLeads && !!(urlAdminToken || urlAgent), // only fetch if no leads were passed as props and we have access
    }
  );
  const leads = propLeads ?? fetchedLeads?.leads ?? [];

  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [selectedLead, setSelectedLead] = useState<CopilotLead | null>(initialLead ?? null);
  const [showLeadPicker, setShowLeadPicker] = useState(false);

  // Learning system — memory
  const agentName = selectedLead?.assigned_agent || "";
  const { data: memoriesData } = trpc.copilot.getMemories.useQuery(
    { agentName, ...accessParams },
    { enabled: !!agentName && isOpen, staleTime: 2 * 60 * 1000 }
  );
  const memoryCount = memoriesData?.memories?.length ?? 0;
  const saveMemoryMutation = trpc.copilot.saveMemory.useMutation();

  // When initialLead changes (e.g. agent clicks a different lead card), update selectedLead
  useEffect(() => {
    if (initialLead !== undefined) {
      setSelectedLead(initialLead);
    }
  }, [initialLead?.id]);

  // Listen for copilot:open-with-lead events fired by lead cards in the Power Queue
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<CopilotLead>).detail;
      if (detail) {
        setSelectedLead(detail);
        setIsOpen(true);
        setIsMinimized(false);
        // Clear previous conversation so the agent starts fresh for this lead
        setMessages([]);
      }
    };
    window.addEventListener("copilot:open-with-lead", handler);
    return () => window.removeEventListener("copilot:open-with-lead", handler);
  }, []);

  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Swipe-to-dismiss refs (mobile only)
  const touchStartYRef = useRef<number | null>(null);
  const touchCurrentYRef = useRef<number>(0);
  const [dragOffset, setDragOffset] = useState(0);
  const isDraggingRef = useRef(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    // Only activate on mobile screens
    if (window.innerWidth >= 640) return;
    touchStartYRef.current = e.touches[0].clientY;
    touchCurrentYRef.current = e.touches[0].clientY;
    isDraggingRef.current = true;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDraggingRef.current || touchStartYRef.current === null) return;
    if (window.innerWidth >= 640) return;
    const currentY = e.touches[0].clientY;
    touchCurrentYRef.current = currentY;
    const delta = currentY - touchStartYRef.current;
    // Only allow downward drag (positive delta)
    if (delta > 0) {
      setDragOffset(delta);
    }
  };

  const handleTouchEnd = () => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    const delta = touchCurrentYRef.current - (touchStartYRef.current ?? 0);
    touchStartYRef.current = null;
    if (delta > 100) {
      // Swiped down far enough — dismiss the panel
      // Haptic feedback on iOS PWA (navigator.vibrate is a no-op on unsupported devices)
      try { navigator.vibrate?.(10); } catch { /* ignore */ }
      setDragOffset(0);
      setIsOpen(false);
    } else {
      // Snap back
      setDragOffset(0);
    }
  };

  const chatMutation = trpc.ai.chat.useMutation({
    onSuccess: (data) => {
      const assistantMsg = { role: "assistant" as const, content: data.content };
      setMessages((prev) => [...prev, assistantMsg]);

      // Auto-extract and save a memory if the exchange seems valuable
      // We save a memory when: the response is substantive (>80 chars) and there's a lead selected
      if (agentName && data.content.length > 80 && messages.length > 0) {
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        if (lastUserMsg) {
          // Build a concise memory from the exchange
          const memoryText = `Agent asked: "${lastUserMsg.content.slice(0, 120)}" → Copilot noted: "${data.content.slice(0, 200)}"`;
          saveMemoryMutation.mutate({
            agentName,
            memoryText,
            category: "general",
            importanceScore: 1,
            ...accessParams,
          });
        }
      }
    },
    onError: (error) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Sorry, I ran into an issue: ${error.message}. Please try again.`,
        },
      ]);
    },
  });

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLDivElement;
    if (viewport) {
      requestAnimationFrame(() => {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
      });
    }
  }, [messages, chatMutation.isPending]);

  const quickActions: QuickAction[] = [
    {
      label: "Draft SMS",
      icon: <MessageSquareText className="h-3.5 w-3.5" />,
      prompt: selectedLead
        ? `Draft a short, friendly SMS for ${selectedLead.name} who is interested in homes in ${selectedLead.city || "Texas"} and hasn't been contacted in ${selectedLead.days_stale || "a few"} days. Keep it under 160 characters. Use first name only.`
        : "Draft a short, friendly SMS for a lead who hasn't been contacted in a while. Keep it under 160 characters. Use first name only.",
    },
    {
      label: "Draft Email",
      icon: <Mail className="h-3.5 w-3.5" />,
      prompt: selectedLead
        ? `Write a warm, personalized follow-up email for ${selectedLead.name} who is interested in homes in ${selectedLead.city || "Texas"}. Sign it from ${selectedLead.assigned_agent || "the agent"} at Lifestyle Design Realty.`
        : "Write a warm, personalized follow-up email for a lead interested in Texas real estate. Sign it from the agent at Lifestyle Design Realty.",
    },
    {
      label: "Show Deals",
      icon: <FileText className="h-3.5 w-3.5" />,
      prompt: selectedLead?.city
        ? `What new build homes do we have available in ${selectedLead.city}? Give me the community name, builder, price range, current rate, and estimated monthly payment.`
        : "What new build homes do we have available right now? List all communities with builder, price range, current rate, and estimated monthly payment.",
    },
    {
      label: "Objection Scripts",
      icon: <HelpCircle className="h-3.5 w-3.5" />,
      prompt: "Give me 3 word-for-word scripts for the most common buyer objections right now — rates too high, not the right time, and just browsing.",
    },
    {
      label: "How Power Queue Works",
      icon: <MessageSquareText className="h-3.5 w-3.5" />,
      prompt: "Explain how the Tap-to-Text Power Queue works. What is it, how do I use it, and what happens when I click Send Text Now?",
    },
    {
      label: "Summarize Lead",
      icon: <FileText className="h-3.5 w-3.5" />,
      prompt: selectedLead
        ? `Give me a quick 2-3 sentence summary of ${selectedLead.name}: Stage is ${selectedLead.stage || "Lead"}, interested in ${selectedLead.city || "Texas"}, hasn't been contacted in ${selectedLead.days_stale || "unknown"} days. What's the recommended next action?`
        : "Summarize this lead's status and recommend the best next action.",
    },
  ];

  const sendMessage = (content: string) => {
    if (!content.trim() || chatMutation.isPending) return;

    const userMessage: Message = { role: "user", content };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");

    chatMutation.mutate({
      messages: newMessages,
      leadContext: selectedLead
        ? {
            id: selectedLead.id,
            name: selectedLead.name,
            phone: selectedLead.phone,
            stage: selectedLead.stage,
            city: selectedLead.city,
            days_stale: selectedLead.days_stale,
            assigned_agent: selectedLead.assigned_agent,
            sms_body: selectedLead.sms_body,
            notes: selectedLead.notes,
            last_inbound_text: selectedLead.last_inbound_text,
          }
        : undefined,
      ...accessParams,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const clearChat = () => {
    setMessages([]);
    setSelectedLead(null);
  };

  return (
    <>
      {/* Floating Trigger Button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 group flex items-center gap-2.5 px-4 py-3 rounded-2xl bg-gradient-to-r from-amber-500 to-yellow-500 text-white font-semibold text-sm shadow-[0_0_30px_rgba(212,175,55,0.4)] hover:shadow-[0_0_45px_rgba(212,175,55,0.6)] transition-all duration-300 hover:scale-105 active:scale-[0.98]"
          style={{ animation: "copilot-pulse 3s ease-in-out infinite" }}
        >
          <Sparkles className="h-4 w-4" />
          <span>Agent Copilot</span>
          {/* Glow ring */}
          <span className="absolute inset-0 rounded-2xl ring-2 ring-amber-400/40 group-hover:ring-amber-400/70 transition-all duration-300" />
        </button>
      )}

      {/* Copilot Panel */}
      {isOpen && (
        <div
          className={cn(
            "fixed z-50 flex flex-col rounded-2xl overflow-hidden",
            "bg-[#0C0C0E] border border-amber-200",
            "shadow-[0_0_60px_rgba(212,175,55,0.15),0_25px_50px_rgba(0,0,0,0.6)]",
            // Only suppress transition during active drag for responsiveness
            isDraggingRef.current ? "" : "transition-all duration-300 ease-out",
            // Mobile: full-width anchored to bottom, no side offset
            // Desktop (sm+): fixed bottom-right corner
            isMinimized
              ? "bottom-4 right-4 left-4 sm:left-auto sm:right-6 sm:bottom-6 h-14 sm:w-80"
              : "bottom-0 left-0 right-0 h-[85vh] rounded-b-none sm:rounded-2xl sm:bottom-6 sm:right-6 sm:left-auto sm:w-[420px] sm:h-[600px]"
          )}
          style={dragOffset > 0 ? { transform: `translateY(${dragOffset}px)`, opacity: Math.max(0.4, 1 - dragOffset / 400) } : undefined}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {/* Drag handle — mobile only, shown above header */}
          {!isMinimized && (
            <div className="sm:hidden flex justify-center items-center pt-2.5 pb-1 bg-gradient-to-r from-stone-950 to-[#0C0C0E] shrink-0 cursor-grab active:cursor-grabbing">
              <div className="w-10 h-1 rounded-full bg-card/20" />
            </div>
          )}
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-amber-500/15 bg-gradient-to-r from-stone-950 to-[#0C0C0E] shrink-0">
            <div className="flex items-center gap-2.5">
              {/* Animated glow orb */}
              <div className="relative flex items-center justify-center w-7 h-7">
                <div className="absolute inset-0 rounded-full bg-amber-100 animate-pulse" />
                <Sparkles className="h-3.5 w-3.5 text-amber-600 relative z-10" />
              </div>
              <div>
                <span className="text-sm font-semibold text-white tracking-tight">
                  Agent Copilot
                </span>
                <span className="ml-2 text-[10px] text-amber-600/70 font-mono uppercase tracking-wider">
                  ● Live
                </span>
                {memoryCount > 0 && (
                  <span
                    className="ml-2 inline-flex items-center gap-0.5 text-[9px] text-emerald-600/80 font-mono uppercase tracking-wider"
                    title={`${memoryCount} memories stored for ${agentName}`}
                  >
                    <Brain className="h-2.5 w-2.5" />
                    {memoryCount} mem
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && !isMinimized && (
                <button
                  onClick={clearChat}
                  className="px-2 py-1 text-[10px] text-white/40 hover:text-white/70 transition-colors rounded font-mono uppercase tracking-wider"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setIsMinimized(!isMinimized)}
                className="p-1.5 text-white/40 hover:text-white/70 transition-colors rounded-lg hover:bg-card/8"
              >
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform duration-200",
                    isMinimized ? "rotate-180" : ""
                  )}
                />
              </button>
              <button
                onClick={() => {
                  setIsOpen(false);
                  setIsMinimized(false);
                }}
                className="p-1.5 text-white/40 hover:text-white/70 transition-colors rounded-lg hover:bg-card/8"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {!isMinimized && (
            <>
              {/* Lead Context Selector */}
              {leads.length > 0 && (
                <div className="px-3 py-2 border-b border-white/5 shrink-0">
                  <div className="relative">
                    <button
                      onClick={() => setShowLeadPicker(!showLeadPicker)}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-card/6 hover:bg-card/10 border border-white/8 text-xs transition-colors"
                    >
                      <span className="text-white/50">
                        {selectedLead ? (
                          <span className="text-amber-400 font-medium">
                            📍 {selectedLead.name} · {selectedLead.city || "Texas"} · {selectedLead.days_stale}d stale
                          </span>
                        ) : (
                          "Select a lead for context (optional)"
                        )}
                      </span>
                      <ChevronDown className={cn("h-3.5 w-3.5 text-white/40 transition-transform", showLeadPicker ? "rotate-180" : "")} />
                    </button>

                    {showLeadPicker && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-[#141416] border border-white/10 rounded-xl shadow-2xl z-10 max-h-48 overflow-y-auto">
                        <button
                          onClick={() => { setSelectedLead(null); setShowLeadPicker(false); }}
                          className="w-full text-left px-3 py-2 text-xs text-white/40 hover:bg-card/6 transition-colors border-b border-white/5"
                        >
                          No lead context
                        </button>
                        {leads.map((lead) => (
                          <button
                            key={lead.id}
                            onClick={() => { setSelectedLead(lead); setShowLeadPicker(false); }}
                            className={cn(
                              "w-full text-left px-3 py-2.5 text-xs transition-colors hover:bg-card/6",
                              selectedLead?.id === lead.id ? "bg-amber-500/10 text-amber-400" : "text-white/60"
                            )}
                          >
                            <div className="font-medium">{lead.name}</div>
                            <div className="text-white/30 mt-0.5">{lead.city || "Texas"} · {lead.days_stale}d stale · {lead.assigned_agent}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Messages Area */}
              <div ref={scrollAreaRef} className="flex-1 overflow-hidden">
                {messages.length === 0 ? (
                  <div className="flex flex-col h-full p-4">
                    {/* Empty state */}
                    <div className="flex flex-col items-center justify-center flex-1 gap-5 text-center">
                      <div className="relative">
                        <div className="absolute inset-0 rounded-full bg-amber-500/10 blur-xl animate-pulse" />
                        <div className="relative w-14 h-14 rounded-full bg-gradient-to-br from-amber-500/20 to-yellow-500/10 border border-amber-200 flex items-center justify-center">
                          <Sparkles className="h-6 w-6 text-amber-600" />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <p className="text-sm font-semibold text-white">
                          Lifestyle Agent Copilot
                        </p>
                        <p className="text-xs text-white/50 max-w-[260px] leading-relaxed">
                          Your AI broker — draft copy, look up new build deals, handle objections, and learn how the system works. Select a lead for personalized drafts.
                        </p>
                      </div>
                    </div>

                    {/* Quick Action Chips */}
                    <div className="grid grid-cols-2 gap-2 pb-1">
                      {quickActions.map((action) => (
                        <button
                          key={action.label}
                          onClick={() => sendMessage(action.prompt)}
                          disabled={chatMutation.isPending}
                          className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-card/5 hover:bg-card/8 border border-white/8 hover:border-amber-500/30 text-xs text-white/50 hover:text-white transition-all duration-150 text-left disabled:opacity-50 disabled:cursor-not-allowed group"
                        >
                          <span className="text-amber-600/70 group-hover:text-amber-600 transition-colors shrink-0">
                            {action.icon}
                          </span>
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <ScrollArea className="h-full">
                    <div className="flex flex-col space-y-4 p-4">
                      {messages.map((message, index) => (
                        <div
                          key={index}
                          className={cn(
                            "flex gap-2.5",
                            message.role === "user"
                              ? "justify-end items-start"
                              : "justify-start items-start"
                          )}
                        >
                          {message.role === "assistant" && (
                            <div className="w-7 h-7 shrink-0 mt-0.5 rounded-full bg-gradient-to-br from-amber-500/20 to-yellow-500/10 border border-amber-200 flex items-center justify-center">
                              <Sparkles className="h-3.5 w-3.5 text-amber-600" />
                            </div>
                          )}
                          <div
                            className={cn(
                              "max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm",
                              message.role === "user"
                              ? "bg-amber-500/15 text-amber-100 border border-amber-500/20"
                              : "bg-card/5 text-white/80 border border-white/8"
                            )}
                          >
                            {message.role === "assistant" ? (
                              <div className="prose prose-sm prose-invert max-w-none [&_p]:text-white/80 [&_strong]:text-white [&_li]:text-white/70 [&_code]:text-amber-400 [&_code]:bg-card/8 [&_code]:px-1 [&_code]:rounded">
                                <Streamdown>{message.content}</Streamdown>
                              </div>
                            ) : (
                              <p className="whitespace-pre-wrap">{message.content}</p>
                            )}
                          </div>
                          {message.role === "user" && (
                            <div className="w-7 h-7 shrink-0 mt-0.5 rounded-full bg-stone-700 border border-stone-600 flex items-center justify-center">
                              <User className="h-3.5 w-3.5 text-slate-600" />
                            </div>
                          )}
                        </div>
                      ))}

                      {chatMutation.isPending && (
                        <div className="flex items-start gap-2.5">
                          <div className="w-7 h-7 shrink-0 mt-0.5 rounded-full bg-gradient-to-br from-amber-500/20 to-yellow-500/10 border border-amber-200 flex items-center justify-center">
                            <Sparkles className="h-3.5 w-3.5 text-amber-600" />
                          </div>
                          <div className="rounded-xl bg-card/5 border border-white/8 px-4 py-3 flex items-center gap-2">
                            <div className="flex gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60 animate-bounce [animation-delay:0ms]" />
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60 animate-bounce [animation-delay:150ms]" />
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60 animate-bounce [animation-delay:300ms]" />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                )}
              </div>

              {/* Quick actions bar (when messages exist) */}
              {messages.length > 0 && (
                <div className="px-3 py-2 border-t border-white/5 flex gap-1.5 overflow-x-auto shrink-0 scrollbar-none">
                  {quickActions.map((action) => (
                    <button
                      key={action.label}
                      onClick={() => sendMessage(action.prompt)}
                      disabled={chatMutation.isPending}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-card/5 hover:bg-card/8 border border-white/8 hover:border-amber-500/30 text-[11px] text-white/40 hover:text-white/80 transition-all whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                    >
                      <span className="text-amber-500">{action.icon}</span>
                      {action.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Input Area */}
              <div className="px-3 pb-3 pt-2 border-t border-white/5 shrink-0">
                <div className="flex gap-2 items-end bg-card/5 border border-white/10 rounded-xl px-3 py-2 focus-within:border-amber-500/40 transition-colors">
                  <Textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask anything... draft copy, summarize a lead, market questions"
                    className="flex-1 max-h-28 resize-none min-h-[36px] bg-transparent border-none shadow-none focus-visible:ring-0 text-sm text-foreground placeholder:text-white/30 p-0"
                    rows={1}
                  />
                  <button
                    onClick={() => sendMessage(input)}
                    disabled={!input.trim() || chatMutation.isPending}
                    className="shrink-0 w-8 h-8 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:bg-stone-700 disabled:cursor-not-allowed flex items-center justify-center transition-all duration-150 active:scale-95"
                  >
                    {chatMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 text-white animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5 text-white" />
                    )}
                  </button>
                </div>
                <p className="hidden sm:block text-[10px] text-white/30 mt-1.5 text-center">
                  Enter to send · Shift+Enter for new line
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* Keyframe animation for the floating button */}
      <style>{`
        @keyframes copilot-pulse {
          0%, 100% { box-shadow: 0 0 20px rgba(212,175,55,0.3), 0 0 40px rgba(212,175,55,0.1); }
          50% { box-shadow: 0 0 35px rgba(212,175,55,0.5), 0 0 60px rgba(212,175,55,0.2); }
        }
      `}</style>
    </>
  );
}
