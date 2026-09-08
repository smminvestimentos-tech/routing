import type { Metadata } from "next";
import Image from "next/image";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Routing TFS",
  description: "Routing and fleet management dashboard",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="pt"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="relative min-h-full flex flex-col isolate">
        {/* Background photo */}
      <body className="relative min-h-full flex flex-col">
        {/* Background photo & overlay */}
        <div
          aria-hidden="true"
          className="fixed inset-0 -z-20 bg-cover bg-center bg-no-repeat bg-fixed"
          style={{ backgroundImage: "url('/background.jpg')" }}
        />
        {/* Ambient overlay / scrim so text and components remain crisp and readable */}
        <div
          aria-hidden="true"
          className="fixed inset-0 -z-10 bg-white/80 backdrop-blur-[1px] dark:bg-black/85"
        />
        <div className="relative z-0 flex min-h-full flex-1 flex-col">
          className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
        >
          <Image
            src="/background.jpg"
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-cover object-center"
            quality={90}
          />
          <div className="absolute inset-0 bg-white/65 backdrop-blur-[1px] dark:bg-black/75" />
        </div>

        {/* Foreground content */}
        <div className="relative z-10 flex min-h-full flex-1 flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
