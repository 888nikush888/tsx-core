"use client";

import * as React from "react";
import {
  ThemeProviderContext,
  type ResolvedTheme,
  type Theme,
} from "@/contexts/theme-context";

type ThemeProviderProps = Readonly<{
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}>;

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = React.useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme,
  );
  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );
  const resolvedTheme = theme === "system" ? systemTheme : theme;

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () =>
      setSystemTheme(media.matches ? "dark" : "light");
    updateSystemTheme();
    media.addEventListener("change", updateSystemTheme);
    return () => media.removeEventListener("change", updateSystemTheme);
  }, []);

  React.useEffect(() => {
    const root = window.document.documentElement;

    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const updateTheme = React.useCallback(
    (nextTheme: Theme) => {
      localStorage.setItem(storageKey, nextTheme);
      setTheme(nextTheme);
    },
    [storageKey],
  );

  const value = React.useMemo(
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
