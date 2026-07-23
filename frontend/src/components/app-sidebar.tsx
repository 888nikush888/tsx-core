"use client"

import * as React from "react"
import {
  LayoutDashboard,
  TerminalSquare,
  Shield,
  FileCode,
  ChartCandlestick
} from "lucide-react"
import { Link } from "react-router-dom"
import { Logo } from "@/components/logo"
import { NavMain } from "@/components/nav-main"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

const data = {
  navGroups: [
    {
      label: "Apps",
      items: [
        {
          title: "Dashboard",
          url: "/dashboard",
          icon: LayoutDashboard,
        },
        {
          title: "Signale & Nachrichten",
          url: "/dashboard?tab=signals",
          icon: FileCode,
        },
        {
          title: "Trading",
          url: "/dashboard?tab=trading",
          icon: ChartCandlestick,
        },
        {
          title: "Logs",
          url: "/dashboard?tab=logs",
          icon: TerminalSquare,
        },
        {
          title: "System & Backup",
          url: "/dashboard?tab=system",
          icon: Shield,
        },
      ],
    },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="h-16">
              <Link to="/dashboard" aria-label="TSX Core Dashboard" className="group-data-[collapsible=icon]:justify-center">
                <Logo variant="full" size={44} className="group-data-[collapsible=icon]:hidden" />
                <Logo variant="mark" size={32} className="hidden group-data-[collapsible=icon]:inline-block" />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {data.navGroups.map((group) => (
          <NavMain key={group.label} label={group.label} items={group.items} />
        ))}
      </SidebarContent>
      <SidebarFooter>
        {/* User profile removed as requested */}
      </SidebarFooter>
    </Sidebar>
  )
}
