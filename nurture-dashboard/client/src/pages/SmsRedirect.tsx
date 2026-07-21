import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";

export default function SmsRedirect() {
  const [_, setLocation] = useLocation();
  const [phone, setPhone] = useState("");
  const [body, setBody] = useState("");
  const [agent, setAgent] = useState("");
  const [leadId, setLeadId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [redirectAttempted, setRedirectAttempted] = useState(false);

  const logSentNote = trpc.leads.logSentNote.useMutation({
    onError: (err) => console.error("FUB note log failed:", err.message),
  });

  useEffect(() => {
    // Parse query parameters
    const params = new URLSearchParams(window.location.search);
    const phoneParam = params.get("phone") || "";
    const bodyParam = params.get("body") || "";
    const agentParam = params.get("agent") || "";
    const leadIdParam = params.get("lead_id") || "";

    if (!phoneParam) {
      setError("No phone number provided. Please verify the link.");
      return;
    }

    setPhone(phoneParam);
    setBody(bodyParam);
    setAgent(agentParam);

    const parsedLeadId = leadIdParam ? parseInt(leadIdParam, 10) : null;
    if (parsedLeadId && !isNaN(parsedLeadId)) {
      setLeadId(parsedLeadId);
    }

    // Track click event via our backend API (for leaderboard)
    fetch("/api/track-click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: agentParam || "Unknown Agent",
        phone: phoneParam,
        body: bodyParam,
        lead_id: parsedLeadId || undefined,
      })
    }).catch(err => console.error("Failed to log tap-to-text click:", err));

    // Log a note in FUB if we have a lead_id
    if (parsedLeadId && !isNaN(parsedLeadId) && agentParam) {
      logSentNote.mutate({
        personId: parsedLeadId,
        agentName: agentParam,
        messageBody: bodyParam || undefined,
        agent: agentParam,
      });
    }

    // Clean up phone number
    let cleanPhone = phoneParam.replace(/[^\d+]/g, "");
    if (!cleanPhone.startsWith("+") && cleanPhone.length === 10) {
      cleanPhone = "+1" + cleanPhone;
    }

    // Build the correct SMS URI format
    const isApple = /iPhone|iPad|iPod|Macintosh/i.test(navigator.userAgent);
    const encodedBody = encodeURIComponent(bodyParam);
    
    const smsUri = isApple 
      ? `sms:${cleanPhone}&body=${encodedBody}` 
      : `sms:${cleanPhone}?body=${encodedBody}`;

    // Attempt automatic redirect after 1.5 seconds for a premium, deliberate feel
    const timer = setTimeout(() => {
      window.location.href = smsUri;
      setRedirectAttempted(true);
    }, 1500);

    return () => clearTimeout(timer);
  }, []);

  const handleManualClick = () => {
    // Log click event again on manual button press to ensure we track it
    fetch("/api/track-click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: agent || "Unknown Agent",
        phone: phone,
        body: body,
        lead_id: leadId || undefined,
      })
    }).catch(err => console.error("Failed to log manual click:", err));

    // Also log FUB note on manual tap if not already logged
    if (leadId && agent && !logSentNote.isSuccess && !logSentNote.isPending) {
      logSentNote.mutate({
        personId: leadId,
        agentName: agent,
        messageBody: body || undefined,
        agent: agent,
      });
    }

    let cleanPhone = phone.replace(/[^\d+]/g, "");
    if (!cleanPhone.startsWith("+") && cleanPhone.length === 10) {
      cleanPhone = "+1" + cleanPhone;
    }
    const isApple = /iPhone|iPad|iPod|Macintosh/i.test(navigator.userAgent);
    const encodedBody = encodeURIComponent(body);
    const smsUri = isApple 
      ? `sms:${cleanPhone}&body=${encodedBody}` 
      : `sms:${cleanPhone}?body=${encodedBody}`;
    
    window.location.href = smsUri;
  };

  const formattedAgentName = agent 
    ? agent.trim().charAt(0).toUpperCase() + agent.trim().slice(1).toLowerCase()
    : "";

  return (
    <div className="min-h-screen bg-[#08080A] text-white flex flex-col items-center justify-between p-8 font-sans relative overflow-hidden">
      {/* Premium Radial Background Glow */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(212,175,55,0.07)_0%,transparent_65%)] pointer-events-none" />
      
      {/* Top Section - Minimal Spacer */}
      <div className="h-12" />

      {/* Middle Section - Luxury Loading Experience */}
      <div className="flex flex-col items-center justify-center max-w-md w-full text-center space-y-10 z-10">
        
        {/* Luxury Concentric Gold Loading Animation */}
        <div className="relative w-32 h-32 flex items-center justify-center">
          {/* Outer Pulsing Aura */}
          <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-amber-500/10 to-yellow-500/5 animate-pulse blur-md" />
          
          {/* Outer Ring - Slow Clockwise */}
          <div className="absolute w-28 h-28 rounded-full border-2 border-transparent border-t-amber-400/40 border-r-amber-500/20 animate-[spin_3s_linear_infinite]" />
          
          {/* Middle Ring - Faster Counter-Clockwise */}
          <div className="absolute w-24 h-24 rounded-full border-2 border-transparent border-b-yellow-300/60 border-l-yellow-400/20 animate-[spin_1.5s_linear_infinite_reverse]" />
          
          {/* Inner Ring - Shimmering Static Accent */}
          <div className="absolute w-20 h-20 rounded-full border border-amber-500/10" />
          
          {/* Central Glowing Core */}
          <div className="w-4 h-4 rounded-full bg-gradient-to-r from-amber-300 to-yellow-500 shadow-[0_0_15px_rgba(212,175,55,0.6)] animate-pulse" />
        </div>

        {/* Greetings & Agent Typography */}
        <div className="space-y-3">
          {formattedAgentName && (
            <p className="text-amber-200/80 font-light tracking-[0.25em] text-xs uppercase">
              Welcome Back
            </p>
          )}
          
          <h1 className="text-3xl font-extralight tracking-wide text-neutral-100">
            {formattedAgentName ? `Hi, ${formattedAgentName}` : "Hello"}
          </h1>
          
          <p className="text-sm font-light text-neutral-400 max-w-xs mx-auto leading-relaxed">
            {error ? "An error occurred" : "Opening your messaging app to pre-fill your client text..."}
          </p>

          {/* FUB note status indicator */}
          {leadId && !error && (
            <p className="text-[11px] text-neutral-600 font-light">
              {logSentNote.isSuccess
                ? "✓ FUB note logged"
                : logSentNote.isPending
                ? "Logging to FUB..."
                : logSentNote.isError
                ? "⚠ FUB note failed"
                : ""}
            </p>
          )}
        </div>

        {/* Fallback & Error States */}
        {error ? (
          <div className="bg-red-950/40 text-red-300 px-6 py-4 rounded-lg border border-red-900/50 text-sm max-w-xs backdrop-blur-sm">
            {error}
          </div>
        ) : (
          <div className="w-full max-w-xs pt-4 transition-all duration-500">
            {redirectAttempted ? (
              <div className="space-y-4 animate-fade-in">
                <button
                  onClick={handleManualClick}
                  className="w-full py-3.5 px-6 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 active:scale-[0.98] transition-all text-neutral-950 font-medium tracking-wider uppercase text-xs rounded-full shadow-[0_4px_20px_rgba(212,175,55,0.25)] flex items-center justify-center gap-2"
                >
                  <span>📲 Send Text Now</span>
                </button>
                <p className="text-xs text-neutral-500 font-light">
                  If the app didn't open automatically, tap above.
                </p>
              </div>
            ) : (
              <button
                onClick={handleManualClick}
                className="w-full py-3.5 px-6 bg-transparent hover:bg-card/5 border border-amber-500/20 active:scale-[0.98] transition-all text-amber-200/80 font-light tracking-wider uppercase text-xs rounded-full flex items-center justify-center gap-2"
              >
                <span>Skip Wait & Open</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Bottom Section - Premium Branding */}
      <div className="flex flex-col items-center space-y-3 z-10">
        <div className="w-12 h-[1px] bg-gradient-to-r from-transparent via-amber-500/30 to-transparent" />
        <p className="text-[10px] text-neutral-500 font-light tracking-[0.3em] uppercase text-center">
          Powered by <span className="text-neutral-400 font-normal">Lifestyle Technologies</span>
        </p>
        
        <button 
          onClick={() => setLocation(agent ? `/agent/${agent.trim().toLowerCase()}` : "/")}
          className="text-[10px] text-neutral-600 hover:text-amber-200/60 transition-colors tracking-widest uppercase pt-2"
        >
          Return to Dashboard
        </button>
      </div>
    </div>
  );
}
