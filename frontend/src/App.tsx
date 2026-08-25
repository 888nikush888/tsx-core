import { ThemeProvider } from "@/components/theme-provider";
import { AppRouter } from "@/components/router/app-router";
import { useEffect } from "react";
import { initGTM } from "@/utils/analytics";
import { DashboardAuthGate } from "@/components/dashboard-auth-gate";
import { NavigationProvider } from "@/lib/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";

// Get basename from environment (for deployment) or use empty string for development
const basename = import.meta.env.VITE_BASENAME || "";

function App() {
  // Initialize GTM on app load
  useEffect(() => {
    initGTM();
  }, []);

  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <TooltipProvider>
        <NavigationProvider basename={basename}>
          <DashboardAuthGate>
            <AppRouter />
          </DashboardAuthGate>
        </NavigationProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

export default App;
