import { useEffect, useState } from "react";

/**
 * UpdateBanner — listens for the custom `sw-update-available` event fired by
 * the service worker registration in index.html, then shows a fixed amber
 * banner at the top of the screen. Tapping it reloads the page so the new
 * service worker activates and agents get the latest code immediately.
 */
export default function UpdateBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleUpdate = () => setVisible(true);
    window.addEventListener("sw-update-available", handleUpdate);
    return () => window.removeEventListener("sw-update-available", handleUpdate);
  }, []);

  if (!visible) return null;

  const handleReload = () => {
    // Tell the waiting service worker to take control immediately
    navigator.serviceWorker?.getRegistration().then((reg) => {
      reg?.waiting?.postMessage({ type: "SKIP_WAITING" });
    });
    window.location.reload();
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        // Slide down animation
        animation: "sw-banner-slide 0.25s cubic-bezier(0.23, 1, 0.32, 1) both",
      }}
    >
      <style>{`
        @keyframes sw-banner-slide {
          from { transform: translateY(-100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .sw-update-banner { animation: none !important; }
        }
      `}</style>
      <button
        onClick={handleReload}
        className="sw-update-banner w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold text-white cursor-pointer border-0 outline-none focus-visible:ring-2 focus-visible:ring-white"
        style={{
          background: "linear-gradient(90deg, #d97706 0%, #f59e0b 50%, #d97706 100%)",
          backgroundSize: "200% 100%",
          animation: "sw-banner-slide 0.25s cubic-bezier(0.23, 1, 0.32, 1) both",
        }}
        aria-label="New version available. Tap to refresh."
      >
        {/* Lightning bolt icon */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="w-4 h-4 flex-shrink-0"
          aria-hidden="true"
        >
          <path d="M11.983 1.907a.75.75 0 0 0-1.292-.657l-8.5 9.5A.75.75 0 0 0 2.75 12h6.572l-1.305 6.093a.75.75 0 0 0 1.292.657l8.5-9.5A.75.75 0 0 0 17.25 8h-6.572l1.305-6.093Z" />
        </svg>
        <span>New version available — tap to refresh</span>
        {/* Chevron right */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="w-4 h-4 flex-shrink-0 opacity-75"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
}
