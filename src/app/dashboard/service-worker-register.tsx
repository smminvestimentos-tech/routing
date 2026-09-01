"use client";

import { useEffect } from "react";

// Registers /sw.js so the dashboard is installable as a PWA. No-ops where
// service workers aren't available; failures are swallowed (the app works
// fine without it).
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    };
    if (document.readyState === "complete") onLoad();
    else {
      window.addEventListener("load", onLoad);
      return () => window.removeEventListener("load", onLoad);
    }
  }, []);

  return null;
}
