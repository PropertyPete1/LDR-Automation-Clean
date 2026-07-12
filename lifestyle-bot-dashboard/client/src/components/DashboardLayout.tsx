import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getLoginUrl } from "@/const";
import { Bot, LayoutDashboard, Droplets, Zap, LogOut } from "lucide-react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";

const navItems = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/" },
  { icon: Bot, label: "Agent Bots", path: "/agent-bots" },
  { icon: Droplets, label: "Pond Nurture", path: "/pond-nurture" },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { loading, user } = useAuth();

  if (loading) {
    return <DashboardLayoutSkeleton />;
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#F8F9FC] flex items-center justify-center">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center">
              <Zap className="h-4 w-4 text-white" />
            </div>
            <span className="font-semibold text-[#0F1117] tracking-tight">
              Lifestyle Bot Dashboard
            </span>
          </div>
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-[#0F1117]">
              Sign in to continue
            </h1>
            <p className="text-sm text-slate-500 max-w-sm">
              Access to this dashboard requires authentication.
            </p>
          </div>
          <Button
            onClick={() => {
              window.location.href = getLoginUrl();
            }}
            size="lg"
            className="w-full bg-amber-500 hover:bg-amber-600 text-white font-medium transition-all"
          >
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  return <DashboardLayoutContent>{children}</DashboardLayoutContent>;
}

function DashboardLayoutContent({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-[#F8F9FC] text-[#0F1117] font-sans antialiased">
      {/* Top nav */}
      <header className="sticky top-0 z-40 w-full bg-white border-b border-[#E4E7EF]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
          {/* Left: Logo + title */}
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-amber-500 flex items-center justify-center">
              <Zap className="h-4 w-4 text-white" />
            </div>
            <span className="font-semibold text-sm text-[#0F1117] tracking-tight">
              Lifestyle Bot
            </span>
            <span className="hidden sm:block text-xs text-slate-400">
              / Lifestyle Design Realty
            </span>
          </div>

          {/* Right: Nav links + user */}
          <div className="flex items-center gap-2">
            {/* Nav links */}
            {navItems.map((item) => {
              const isActive = location === item.path;
              return (
                <button
                  key={item.path}
                  onClick={() => setLocation(item.path)}
                  className={`hidden sm:flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium transition-all duration-150 ${
                    isActive
                      ? "bg-amber-50 text-amber-700 border border-amber-200"
                      : "text-slate-600 bg-slate-50 hover:bg-slate-100 border border-[#E4E7EF]"
                  }`}
                >
                  <item.icon className="h-3.5 w-3.5" />
                  {item.label}
                </button>
              );
            })}


            {/* User avatar dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 h-8 px-2 rounded-lg hover:bg-slate-100 border border-[#E4E7EF] transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Avatar className="h-5 w-5">
                    <AvatarFallback className="text-[10px] font-medium bg-amber-100 text-amber-700">
                      {user?.name?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="hidden sm:block text-xs font-medium text-[#0F1117] max-w-[100px] truncate">
                    {user?.name?.split(" ")[0]}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <div className="px-2 py-1.5 border-b border-[#E4E7EF]">
                  <p className="text-xs font-medium text-[#0F1117] truncate">{user?.name}</p>
                  <p className="text-xs text-slate-500 truncate">{user?.email}</p>
                </div>
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive mt-1"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Mobile nav row */}
        <div className="sm:hidden flex items-center gap-1 px-4 pb-2 overflow-x-auto">
          {navItems.map((item) => {
            const isActive = location === item.path;
            return (
              <button
                key={item.path}
                onClick={() => setLocation(item.path)}
                className={`flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-150 ${
                  isActive
                    ? "bg-amber-50 text-amber-700 border border-amber-200"
                    : "text-slate-600 bg-slate-50 hover:bg-slate-100 border border-[#E4E7EF]"
                }`}
              >
                <item.icon className="h-3 w-3" />
                {item.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {children}
      </main>
    </div>
  );
}
