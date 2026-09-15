"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  ThemeProviderContext,
  type ResolvedTheme,
  type Theme,
} from "@/contexts/theme-context";

type ThemeProviderProps = Readonly<{
  children: ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}>;

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme,
  );
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );
  const resolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () =>
      setSystemTheme(media.matches ? "dark" : "light");
    updateSystemTheme();
    media.addEventListener("change", updateSystemTheme);
    return () => media.removeEventListener("change", updateSystemTheme);
  }, []);

  useEffect(() => {
    const root = window.document.documentElement;

    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const updateTheme = useCallback(
    (nextTheme: Theme) => {
      localStorage.setItem(storageKey, nextTheme);
      setTheme(nextTheme);
    },
    [storageKey],
  );

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      setTheme: updateTheme,
    }),
    [resolvedTheme, theme, updateTheme],
  );

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}
