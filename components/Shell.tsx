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
import { Home } from "pixelarticons/react/Home";
import { MessageText } from "pixelarticons/react/MessageText";
import { Database } from "pixelarticons/react/Database";
import { GitBranch } from "pixelarticons/react/GitBranch";
import { PlugSolid } from "pixelarticons/react/PlugSolid";
import { SettingsCog } from "pixelarticons/react/SettingsCog";
import { Plus } from "pixelarticons/react/Plus";

type PixelIcon = (props: React.SVGProps<SVGSVGElement>) => React.JSX.Element;

// Pixel-art icons (pixelarticons, MIT) to match the Geist Pixel type. They
// are drawn on a 24px grid, so they render at 24px or a multiple to stay
// crisp.
export const NAV_ITEMS: { href: string; label: string; icon: PixelIcon; match: string[] }[] = [
  { href: "/ask", label: "Home", icon: Home, match: ["/ask"] },
  { href: "/chat-history", label: "Chats", icon: MessageText, match: ["/chat-history", "/chat"] },
  { href: "/context", label: "Context", icon: Database, match: ["/context"] },
  { href: "/mindmap", label: "Mindmap", icon: GitBranch, match: ["/mindmap"] },
  { href: "/integrations", label: "Integrations", icon: PlugSolid, match: ["/integrations"] },
  { href: "/settings", label: "Settings", icon: SettingsCog, match: ["/settings"] },
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
            <Link href="/ask" aria-label="Open Glean home">
              {/* The mark sits in the same 44px box as the nav icons, so the
                  logo lines up with them in both states; the name slides in
                  beside it when the rail expands, like the nav labels. */}
              <span className="flex h-11 w-11 shrink-0 items-center justify-center">
                <img src="/hydra-mark.png" alt="" className="h-[24px] w-[24px]" />
              </span>
              <span className="rail-label pointer-events-none hidden whitespace-nowrap font-pixel text-[16px] leading-none text-text-3">
                Open Glean
              </span>
            </Link>
          </div>

          <div className="sb-scroll relative">
            {/* The sliding active-page highlight, measured to the active item. */}
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-x-0 rounded-lg bg-white/[0.07]",
                navInd.height === 0 ? "opacity-0" : "opacity-100",
                navReady && "transition-all duration-200 ease-out",
              )}
              style={{ top: navInd.top, height: navInd.height }}
            />
            <AddContextButton />
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
                className="hidden h-8 items-center gap-1.5 rounded-full border border-solid border-stroke-1 px-3.5 text-xs font-medium text-text-1 transition-colors hover:border-stroke-3 hover:bg-white/[0.06] sm:flex"
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
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-stroke-1 border-t-text-1" />
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
            <item.icon width={20} height={20} aria-hidden />
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/**
 * The rail's primary action. It opens the add-context dialog directly rather
 * than landing on the Context list, since adding is why someone clicks it.
 * A quiet outlined row, not a filled block: it should be the first thing you
 * find, not the loudest thing on screen.
 */
function AddContextButton() {
  return (
    <Link
      href="/context?add=1"
      className="group/add relative z-10 mb-1 flex h-11 w-full shrink-0 items-center rounded-lg border border-solid border-stroke-1 bg-white/[0.03] text-text-1 transition-colors hover:border-stroke-3 hover:bg-white/[0.07]"
    >
      <span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center">
        <Plus
          width={20}
          height={20}
          aria-hidden
          className="transition-transform duration-200 group-hover/add:rotate-90"
        />
      </span>
      <span className="rail-label pointer-events-none hidden whitespace-nowrap text-sm font-medium">
        Add context
      </span>
      <span className="sr-only">Add context</span>
    </Link>
  );
}

function RailLink({
  href,
  label,
  icon: IconCmp,
  active,
  linkRef,
}: {
  href: string;
  label: string;
  icon: PixelIcon;
  active: boolean;
  linkRef?: (el: HTMLAnchorElement | null) => void;
}) {
  return (
    <Link
      ref={linkRef}
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        // One 44px-tall row. The icon lives in a fixed 44px box so it stays put
        // as the rail expands and the label appears beside it on the same line.
        // The active fill is a shared sliding indicator behind the links, so the
        // link itself only sets colours.
        "rail-link group/link relative z-10 flex h-11 w-full shrink-0 items-center rounded-lg bg-transparent text-fg-4 transition-colors",
        active ? "text-text-3" : "hover:bg-white/[0.04] hover:text-text-1",
      )}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center">
        {/* The active page's icon takes the brand colour, so the current page
            reads at a glance without an extra marker. */}
        <IconCmp
          width={24}
          height={24}
          aria-hidden
          className={cn("shrink-0 transition-colors", active && "text-brand-1")}
        />
      </span>
      <span className="rail-label pointer-events-none hidden whitespace-nowrap text-sm font-medium">
        {label}
      </span>
      <span className="sr-only">{label}</span>
    </Link>
  );
}
