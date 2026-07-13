"use client"

import * as React from "react"
import {
  LayoutDashboard,
  Settings,
  Filter,
  BrainCircuit,
  TerminalSquare,
  ListTree,
  Shield,
  MessageSquare,
  FileCode
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
          title: "Nachrichten-Verlauf",
          url: "/dashboard?tab=messages",
          icon: MessageSquare,
        },
        {
          title: "Signale-Datenbank",
          url: "/dashboard?tab=signals",
          icon: FileCode,
        },
        {
          title: "Kanalverwaltung",
          url: "/dashboard?tab=channels",
          icon: ListTree,
        },
        {
          title: "Optionen",
          url: "/dashboard?tab=options",
          icon: Settings,
        },
        {
          title: "Filter & Regex",
          url: "/dashboard?tab=filters",
          icon: Filter,
        },
        {
          title: "KI-Parser",
          url: "/dashboard?tab=parser",
          icon: BrainCircuit,
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
            <SidebarMenuButton size="lg" asChild>
              <Link to="/dashboard">
                <div className="flex aspect-square size-8 items-center justify-center">
                  <Logo size={28} className="text-black dark:text-white" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Forwarder</span>
                  <span className="truncate text-xs">Admin Dashboard</span>
                </div>
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
