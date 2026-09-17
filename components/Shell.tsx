"use client";

/**
 * App shell — ported from the original web-app SideBar + Dashboard 2.0:
 * - Desktop: 5rem icon rail (expands on hover with sliding labels), Upload pill,
 *   active = surface-8.
 * - Topbar: Database & Collection ScopeSwitcher pill for switching scopes.
 * - Mobile: compact header with logo + ScopeSwitcher + bottom navigation.
 */
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useAppConfig } from "@/lib/store/config";
import { Icon } from "@/components/Icon";
import { ConnectGate } from "@/components/ConnectGate";
import { ScopeSwitcher } from "@/components/ScopeSwitcher";
import { SaveStatusBanner } from "@/components/SaveStatusBanner";

export const NAV_ITEMS = [
  { href: "/ask", label: "Home", icon: "home", match: ["/ask"] },
  { href: "/chat-history", label: "Chats", icon: "history", match: ["/chat-history", "/chat"] },
  { href: "/context", label: "Context", icon: "layers", match: ["/context"] },
  { href: "/mindmap", label: "Mindmap", icon: "graph", match: ["/mindmap"] },
  { href: "/integrations", label: "Integrations", icon: "plug", match: ["/integrations"] },
  { href: "/settings", label: "Settings", icon: "settings", match: ["/settings"] },
];

export default function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { hasKey, authResolved } = useAppConfig();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const active = useMemo(() => {
    const item = NAV_ITEMS.find((n) =>
      n.match.some((m) => pathname === m || pathname.startsWith(`${m}/`)),
    );
    return item?.href ?? "/ask";
  }, [pathname]);

  // A single highlight that slides to the active nav item, like the composer
  // mode control. Measured from the active link's position within the scroll
  // container so it does not depend on fixed row math (the divider and the
  // upload pill make offsets uneven).
  const navRefs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const [navInd, setNavInd] = useState<{ top: number; height: number }>({
    top: 0,
    height: 0,
  });
  const [navReady, setNavReady] = useState(false);
  const measureNav = useCallback(() => {
    const el = navRefs.current[active];
    if (el) setNavInd({ top: el.offsetTop, height: el.offsetHeight });
  }, [active]);
  useEffect(() => {
    measureNav();
    const raf = requestAnimationFrame(measureNav);
    document.fonts?.ready.then(measureNav);
    return () => cancelAnimationFrame(raf);
  }, [measureNav, mounted]);
  useEffect(() => {
    if (navInd.height > 0 && !navReady) setNavReady(true);
  }, [navInd.height, navReady]);

  const showApp = mounted && hasKey;
  // Keys can live server-side (session cookie or HYDRA_API_KEY), so `hasKey` is
  // only meaningful once /api/auth/key has answered. Hold the loading state
  // until then, or an already-authenticated user sees the connect screen flash.
  const ready = mounted && authResolved;

  return (
    <div className="app">
      {/*
        Skip link. The rail puts eight focusable elements before the content on
        every page load, so without this a keyboard user tabs through the whole
        navigation each time. Visually hidden until focused.
      */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-surface-7 focus:px-3 focus:py-2 focus:text-sm focus:text-text-1"
      >
        Skip to content
      </a>
      {/*
        Desktop icon rail. A <nav>, not an <aside>: this IS the primary
        navigation, and as an aside the desktop layout exposed no navigation
        landmark at all (the real <nav> below is md:hidden).
      */}
      <nav aria-label="Main" className="sidebar group/sidebar">
        <div className="sidebar-panel">
          <div className="sidebar-brand">
            <Link href="/ask" title="Open Glean by Hydra DB">
              {/* Collapsed: the bare mark. Expanded: the full wordmark. Both are
                  transparent, so neither shows a tile behind it. */}
              <img
                src="/hydra-mark.png"
                alt="Hydra DB"
                className="brand-mark h-[26px] w-[26px]"
              />
              <img
                src="/static/images/logos/hydradb-white.png"
                alt="Hydra DB"
                className="brand-wordmark h-[19px] w-auto"
              />
            </Link>
          </div>

          <div className="sb-scroll relative">
            {/* The sliding active-page highlight, measured to the active item. */}
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-x-0 rounded-lg bg-surface-8",
                navInd.height === 0 ? "opacity-0" : "opacity-100",
                navReady && "transition-all duration-200 ease-out",
              )}
              style={{ top: navInd.top, height: navInd.height }}
            />
            <RailLink
              href="/context"
              label="Upload context"
              icon="upload"
              active={active === "/context"}
              pill
            />
            <div className="my-2 h-px w-full shrink-0 bg-stroke-1" />
            {NAV_ITEMS.map((item) => (
              <RailLink
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={active === item.href}
                linkRef={(el) => {
                  navRefs.current[item.href] = el;
                }}
              />
            ))}
          </div>
        </div>
      </nav>

      {/* Main column */}
      <div className="flex min-w-0 w-full flex-col">
        {/* Top bar with ScopeSwitcher */}
        {showApp && (
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-solid border-stroke-1 bg-surface-5 px-4 md:px-6">
            <div className="flex items-center gap-3">
              <div className="md:hidden">
                <img
                  src="/hydra-mark.png"
                  alt="Hydra DB"
                  className="h-6 w-6"
                />
              </div>
              <ScopeSwitcher />
            </div>

            <div className="flex items-center gap-2">
              <Link
                href="/context?add=1"
                className="hidden h-8 items-center gap-1.5 rounded-full bg-brand-1 px-3.5 text-xs font-medium text-[#140a03] shadow-sm transition-all duration-150 hover:-translate-y-px hover:bg-accent-2 hover:shadow-md active:translate-y-0 sm:flex"
              >
                <Icon name="plus" size={13} />
                <span>Add context</span>
              </Link>
            </div>
          </header>
        )}

        <SaveStatusBanner />

        <main
          id="main-content"
          // tabIndex so the skip link has something to move focus to.
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-hidden pb-14 md:pb-0"
        >
          {!ready ? (
            <div className="flex h-full items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-stroke-1 border-t-brand-1" />
            </div>
          ) : showApp ? (
            children
          ) : (
            <ConnectGate />
          )}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav
        aria-label="Bottom"
        className="fixed bottom-0 left-0 right-0 z-[60] flex items-stretch border-t border-solid border-stroke-1 bg-surface-5/95 backdrop-blur-sm md:hidden"
      >
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active === item.href ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center gap-0.5 py-2 text-[0.625rem] transition-colors",
              active === item.href ? "text-brand-1" : "text-text-2",
            )}
          >
            <Icon name={item.icon} size={18} />
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function RailLink({
  href,
  label,
  icon,
  active,
  pill = false,
  linkRef,
}: {
  href: string;
  label: string;
  icon: string;
  active: boolean;
  pill?: boolean;
  linkRef?: (el: HTMLAnchorElement | null) => void;
}) {
  return (
    <Link
      ref={linkRef}
      href={href}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        // One 44px-tall row. The icon lives in a fixed 44px box so it stays put
        // as the rail expands and the label appears beside it on the same line.
        // The active fill is a shared sliding indicator behind the links, so the
        // link itself only sets text colour and the accent bar.
        "rail-link group/link relative z-10 flex h-11 w-full shrink-0 items-center rounded-lg bg-transparent text-text-2 transition-colors",
        pill
          ? "mb-1 border border-solid border-stroke-1 bg-surface-4 text-text-1 hover:border-stroke-2 hover:bg-surface-7"
          : "hover:text-text-1",
        // Hover fill only on the inactive items; the active one already has the
        // sliding indicator behind it.
        !pill && !active && "hover:bg-surface-7/60",
        active && !pill && "text-text-1",
      )}
    >
      {/* Accent left-edge marks the active page. */}
      {active && !pill && (
        <span className="absolute left-0 top-1/2 z-10 h-5 w-[3px] -translate-y-1/2 rounded-full bg-brand-1" />
      )}
      <span className="flex h-11 w-11 shrink-0 items-center justify-center">
        <Icon name={icon} size={19} className="shrink-0" />
      </span>
      <span className="rail-label pointer-events-none hidden whitespace-nowrap text-sm font-medium">
        {label}
      </span>
      <span className="sr-only">{label}</span>
    </Link>
  );
}
