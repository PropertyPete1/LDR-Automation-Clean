import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import SmsRedirect from "@/pages/SmsRedirect";
import SmsQueue from "@/pages/SmsQueue";
import { Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import AgentDashboard from "./pages/AgentDashboard";
import AgentDirectory from "./pages/AgentDirectory";
import { AgentCopilot } from "./components/AgentCopilot";
import UpdateBanner from "./components/UpdateBanner";

function Router() {
  // make sure to consider if you need authentication for certain routes
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/sms-redirect"} component={SmsRedirect} />
      <Route path={"/sms-queue"} component={SmsQueue} />
      <Route path={"/agents"} component={AgentDirectory} />
      <Route path={"/agent/:agentName"} component={AgentDashboard} />
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  const [location] = useLocation();
  // AgentDashboard mounts its own Copilot with agent-specific leads.
  // Suppress the global Copilot on /agent/* routes to avoid duplicate widgets
  // and ensure agents see only their own leads in the Copilot lead picker.
  const isAgentDashboard = location.startsWith("/agent/");

  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="dark"
        // switchable
      >
        <TooltipProvider>
          <UpdateBanner />
          <Toaster />
          <Router />
          {!isAgentDashboard && <AgentCopilot />}
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
