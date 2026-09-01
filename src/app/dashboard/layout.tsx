import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegister } from "./service-worker-register";

// PWA wiring for /dashboard and its subpages: links the manifest, sets the
// install/apple metadata, and registers the service worker.
export const metadata: Metadata = {
  applicationName: "Routing Dashboard",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Routing",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return (
    <>
      {children}
      <ServiceWorkerRegister />
    </>
  );
}
