import { useEffect, useState } from "react";
import { Download, Share, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { detectIos, detectAndroid, type InstallEnv } from "@/lib/installDetect";

/**
 * BeforeInstallPromptEvent isn't in the standard TS DOM lib yet.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function currentEnv(): InstallEnv {
  if (typeof navigator === "undefined") return { userAgent: "" };
  const standalone =
    (typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches) ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return {
    userAgent: navigator.userAgent || "",
    platform: navigator.platform,
    maxTouchPoints: (navigator as unknown as { maxTouchPoints?: number }).maxTouchPoints,
    standalone,
  };
}

function isStandalone(): boolean {
  return currentEnv().standalone === true;
}

function isIos(): boolean {
  return detectIos(currentEnv());
}

function isAndroid(): boolean {
  return detectAndroid(currentEnv());
}

/**
 * "Install on your phone" helper.
 * - Android/Chrome: fires the native install prompt via beforeinstallprompt.
 * - iOS Safari: shows step-by-step Add-to-Home-Screen instructions (no JS prompt exists).
 * - Hidden entirely once the app is already installed (standalone display mode).
 */
export default function InstallAppButton({ className }: { className?: string }) {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone());
  const [showIosSheet, setShowIosSheet] = useState(false);
  const ios = isIos();

  useEffect(() => {
    if (installed) return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [installed]);

  // Already installed → nothing to show.
  if (installed) return null;

  // Show on any phone-class device (iOS, Android) or whenever a native prompt is
  // available. This guarantees the owner always has a visible install path on
  // mobile, instead of depending solely on the beforeinstallprompt event.
  const canShow = ios || isAndroid() || !!deferredPrompt;
  if (!canShow) return null;

  const handleClick = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => undefined);
      setDeferredPrompt(null);
      return;
    }
    // No native prompt available (iOS always, or Android before the event):
    // show the platform-appropriate instructions.
    setShowIosSheet(true);
  };

  return (
    <>
      <button
        onClick={handleClick}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-transform active:scale-[0.97]",
          className
        )}
        style={{ transitionTimingFunction: "var(--ease-out)" }}
        aria-label="Install app on your phone"
      >
        <Download className="h-3.5 w-3.5" />
        Install app
      </button>

      {showIosSheet && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowIosSheet(false)}
        >
          <div
            className="w-full max-w-md rounded-t-2xl border border-border/60 bg-card p-6 pb-9 text-card-foreground"
            style={{
              animation: "ldsSheetIn 240ms var(--ease-out, cubic-bezier(0.23,1,0.32,1)) both",
            }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <p className="font-display text-2xl text-primary">
                {ios ? "Add to Home Screen" : "Install app"}
              </p>
              <button
                onClick={() => setShowIosSheet(false)}
                className="rounded-full p-1 text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Install this studio on your phone so you can open it like an app and tap Confirm in
              one step.
            </p>
            {ios ? (
              <ol className="mt-5 space-y-4">
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    1
                  </span>
                  <span className="flex items-center gap-1.5 text-sm">
                    Tap the <Share className="inline h-4 w-4 text-primary" /> <b>Share</b> button in
                    Safari&apos;s toolbar.
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    2
                  </span>
                  <span className="flex items-center gap-1.5 text-sm">
                    Scroll down and tap{" "}
                    <span className="inline-flex items-center gap-1 font-medium">
                      <Plus className="inline h-4 w-4 text-primary" /> Add to Home Screen
                    </span>
                    .
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    3
                  </span>
                  <span className="text-sm">
                    Tap <b>Add</b> in the top corner. The studio icon appears on your home screen.
                  </span>
                </li>
              </ol>
            ) : (
              <ol className="mt-5 space-y-4">
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    1
                  </span>
                  <span className="text-sm">
                    Open the browser menu (the <b>⋮</b> three dots, top-right in Chrome).
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    2
                  </span>
                  <span className="flex items-center gap-1.5 text-sm">
                    Tap{" "}
                    <span className="inline-flex items-center gap-1 font-medium">
                      <Plus className="inline h-4 w-4 text-primary" /> Install app
                    </span>{" "}
                    (or <b>Add to Home screen</b>).
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    3
                  </span>
                  <span className="text-sm">
                    Confirm <b>Install</b>. The studio icon appears on your home screen.
                  </span>
                </li>
              </ol>
            )}
            <p className="mt-5 text-xs text-muted-foreground">
              {ios ? (
                <>Tip: must be opened in <b>Safari</b> (not Chrome or in-app browsers) for this to appear on iPhone.</>
              ) : (
                <>Tip: open this page in <b>Chrome</b> for the cleanest install experience.</>
              )}
            </p>
          </div>
          <style>{`@keyframes ldsSheetIn { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>
        </div>
      )}
    </>
  );
}
