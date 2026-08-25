import * as React from "react";

export type Theme = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => null,
};

export const ThemeProviderContext =
  React.createContext<ThemeProviderState>(initialState);
