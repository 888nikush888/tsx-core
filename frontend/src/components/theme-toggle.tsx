import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ThemeProviderContext } from "@/contexts/theme-context";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = React.useContext(ThemeProviderContext);
  const light = resolvedTheme === "light";
  const label = light ? "Dunklen Modus aktivieren" : "Hellen Modus aktivieren";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={label}
            aria-pressed={light}
            onClick={() => setTheme(light ? "dark" : "light")}
          />
        }
      >
        {light ? <Moon /> : <Sun />}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
