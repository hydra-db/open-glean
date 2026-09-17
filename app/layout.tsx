import type { Metadata, Viewport } from "next";
import { reportEnv } from "@/lib/env";
import { Inter } from "next/font/google";
import { StoreProvider } from "@/lib/store/config";
import { ChatStoreProvider } from "@/lib/store/chat";
import { ToastProvider } from "@/lib/toast";
import { ThemeBoot } from "@/components/ThemeBoot";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Open Glean, your second brain on Hydra DB",
  description:
    "Ask a question and get an answer from your notes, files, and connected apps. Built on Hydra DB.",
  applicationName: "Open Glean",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
      { url: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#101010",
  width: "device-width",
  initialScale: 1,
  // No maximumScale: capping it blocked pinch-zoom on iOS and Android, which
  // is a WCAG 1.4.4 failure. This app renders a lot of 10-13px text, so the
  // users most likely to zoom are exactly the ones it was blocking.
};

// Once per server start, not per request. A misconfigured deployment should
// say so in the boot log rather than fail confusingly inside a request.
reportEnv();

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" className={inter.variable} suppressHydrationWarning>
      <body className="font-sans">
        <StoreProvider>
          <ChatStoreProvider>
            <ToastProvider>
              <ThemeBoot />
              {children}
            </ToastProvider>
          </ChatStoreProvider>
        </StoreProvider>
      </body>
    </html>
  );
}