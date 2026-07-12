import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import DashboardLayout from "@/components/DashboardLayout";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import AgentBots from "./pages/AgentBots";
import PondNurture from "./pages/PondNurture";
import AgentView from "./pages/AgentView";

function Router() {
  return (
    <Switch>
      {/* Public agent-scoped view — no login required, linked from clock-in emails */}
      <Route path="/agent/:slug">
        {(params) => <AgentView slug={params.slug ?? ""} />}
      </Route>

      {/* Protected full dashboard — requires login */}
      <Route>
        <DashboardLayout>
          <Switch>
            <Route path={"/"} component={Home} />
            <Route path={"/agent-bots"} component={AgentBots} />
            <Route path={"/pond-nurture"} component={PondNurture} />
            <Route path={"/404"} component={NotFound} />
            <Route component={NotFound} />
          </Switch>
        </DashboardLayout>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
