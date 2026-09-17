"use client";

/** Applies the resolved theme to <html data-theme>. */
import { useEffect } from "react";
import { resolvedTheme, useAppConfig } from "@/lib/store/config";

export function ThemeBoot() {
  const { config } = useAppConfig();
  const theme = resolvedTheme(config.theme);

  useEffect(() => {
    const root = document.documentElement;
    const mode = resolvedTheme(config.theme);
    root.setAttribute("data-theme", mode);
  }, [config.theme, theme]);

  return null;
}