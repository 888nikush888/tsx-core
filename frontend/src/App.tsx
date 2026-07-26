import { ThemeProvider } from '@/components/theme-provider'
import { SidebarConfigProvider } from '@/contexts/sidebar-context'
import { AppRouter } from '@/components/router/app-router'
import { useEffect } from 'react'
import { initGTM } from '@/utils/analytics'
import { DashboardAuthGate } from '@/components/dashboard-auth-gate'
import { NavigationProvider } from '@/lib/navigation'

// Get basename from environment (for deployment) or use empty string for development
const basename = import.meta.env.VITE_BASENAME || ''

function App() {
  // Initialize GTM on app load
  useEffect(() => {
    initGTM();
  }, []);

  return (
    <div className="font-sans antialiased" style={{ fontFamily: 'var(--font-inter)' }}>
      <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
        <SidebarConfigProvider>
          <NavigationProvider basename={basename}>
            <DashboardAuthGate>
              <AppRouter />
            </DashboardAuthGate>
          </NavigationProvider>
        </SidebarConfigProvider>
      </ThemeProvider>
    </div>
  )
}

export default App
