"use client"

import * as React from "react"
import { useNavigate } from "@/lib/navigation"
import { Command as CommandPrimitive } from "cmdk"
import {
  Search,
  LayoutDashboard,
  Shield,
  Settings,
  Inbox,
  Database,
  ChartCandlestick,
  Activity,
  FileJson2,
  Radio,
  Bot,
  type LucideIcon,
} from "lucide-react"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { apiFetch } from "@/lib/api"

const API_BASE = window.location.origin

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      "flex h-full w-full flex-col overflow-hidden rounded-xl bg-white dark:bg-zinc-950 text-zinc-950 dark:text-zinc-50",
      className
    )}
    {...props}
  />
))
Command.displayName = CommandPrimitive.displayName

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Input
    ref={ref}
    className={cn(
      "flex h-12 w-full border-none bg-transparent px-4 py-3 text-[17px] outline-none placeholder:text-zinc-500 dark:placeholder:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800 mb-4",
      className
    )}
    {...props}
  />
))
CommandInput.displayName = CommandPrimitive.Input.displayName

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn("max-h-[400px] overflow-y-auto overflow-x-hidden pb-2", className)}
    {...props}
  />
))
CommandList.displayName = CommandPrimitive.List.displayName

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className="flex h-12 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400"
    {...props}
  />
))
CommandEmpty.displayName = CommandPrimitive.Empty.displayName

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      "overflow-hidden px-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-zinc-500 dark:[&_[cmdk-group-heading]]:text-zinc-400 [&:not(:first-child)]:mt-2",
      className
    )}
    {...props}
  />
))
CommandGroup.displayName = CommandPrimitive.Group.displayName

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex h-12 cursor-pointer select-none items-center gap-2 rounded-lg px-4 text-sm text-zinc-700 dark:text-zinc-300 outline-none transition-colors data-[disabled=true]:pointer-events-none data-[selected=true]:bg-zinc-100 dark:data-[selected=true]:bg-zinc-800 data-[selected=true]:text-zinc-900 dark:data-[selected=true]:text-zinc-100 data-[disabled=true]:opacity-50 [&+[cmdk-item]]:mt-1",
      className
    )}
    {...props}
  />
))
CommandItem.displayName = CommandPrimitive.Item.displayName

interface SearchItem {
  title: string
  url?: string
  group: string
  icon?: LucideIcon
  keywords?: string
  action?: () => Promise<void>
}

interface CommandSearchProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

function contractKeywords(contract: any): string {
  const versions = Array.isArray(contract.versions) ? contract.versions : []
  const versionKeywords = versions
    .map((version: any) => `v${version.version} ${version.status}`)
    .join(" ")
  return [String(contract.id), versionKeywords].filter(Boolean).join(" ")
}

export function CommandSearch({ open, onOpenChange }: CommandSearchProps) {
  const navigate = useNavigate()
  const commandRef = React.useRef<HTMLDivElement>(null)
  const [tradingItems, setTradingItems] = React.useState<SearchItem[]>([])

  React.useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void apiFetch(`${API_BASE}/api/trading`, { signal: controller.signal })
      .then(async response => response.ok ? response.json() : Promise.reject(new Error("Trading-Suche nicht verfügbar.")))
      .then(data => {
        const contracts: SearchItem[] = (data.signalContracts || []).map((contract: any) => ({
          title: `Vertrag: ${contract.name}`,
          keywords: contractKeywords(contract),
          url: `/dashboard?tab=trading&workspace=contracts&contract=${encodeURIComponent(contract.id)}`,
          group: "Verträge",
          icon: FileJson2,
        }))
        const channels = new Map<string, string>()
        for (const channel of data.configuredChannels || []) channels.set(String(channel.id), String(channel.name))
        for (const route of data.routes || []) if (!channels.has(String(route.channelId))) channels.set(String(route.channelId), String(route.channelId))
        const channelItems: SearchItem[] = [...channels].map(([id, name]) => ({
          title: `Kanal: ${name}`,
          keywords: id,
          url: `/dashboard?tab=trading&workspace=routing&channel=${encodeURIComponent(id)}`,
          group: "Kanäle",
          icon: Radio,
        }))
        const positions: SearchItem[] = (data.activity?.positions || [])
          .filter((position: any) => position.status !== "closed")
          .map((position: any) => ({
            title: `Position: ${position.symbol} ${position.side}`,
            keywords: `${position.id} ${position.channelId} ${position.accountId}`,
            url: `/dashboard?tab=trading&workspace=activity&position=${encodeURIComponent(position.id)}`,
            group: "Positionen",
            icon: ChartCandlestick,
          }))
        setTradingItems([...contracts, ...channelItems, ...positions])
      })
      .catch(error => {
        if (error?.name !== "AbortError") setTradingItems([])
      })
    return () => controller.abort()
  }, [open])

  const reconcile = async () => {
    const response = await apiFetch(`${API_BASE}/api/trading/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(payload.error || "Exchange-Abgleich fehlgeschlagen.")
    }
    navigate("/dashboard")
  }

  const searchItems: SearchItem[] = [
    { title: "Dashboard", url: "/dashboard", group: "Apps", icon: LayoutDashboard },
    { title: "Signal Control Center", url: "/dashboard?tab=signals", group: "Apps", icon: Database },
    { title: "Nachrichten-Verlauf", url: "/dashboard?tab=signals&workspace=messages", group: "Signale", icon: Inbox },
    { title: "Signale-Datenbank", url: "/dashboard?tab=signals&workspace=signals", group: "Signale", icon: Database },
    { title: "Kanalverwaltung", url: "/dashboard?tab=signals&workspace=channels", group: "Signale", icon: Settings },
    { title: "Verarbeitung", url: "/dashboard?tab=signals&workspace=processing", group: "Signale", icon: Settings },
    { title: "Filter & Regex", url: "/dashboard?tab=signals&workspace=filters", group: "Signale", icon: Settings },
    { title: "KI-Parser", url: "/dashboard?tab=signals&workspace=parser", group: "Signale", icon: Settings },
    { title: "Trading Control Center", url: "/dashboard?tab=trading", group: "Apps", icon: ChartCandlestick },
    { title: "Trading Analytics", url: "/dashboard?tab=analytics", group: "Apps", icon: ChartCandlestick },
    { title: "MCP-Agenten verwalten", url: "/dashboard?tab=mcp", group: "Apps", icon: Bot },
    { title: "Signal-Verträge verwalten", url: "/dashboard?tab=trading&workspace=contracts", group: "Trading", icon: FileJson2 },
    { title: "Kanal-Risiko verwalten", url: "/dashboard?tab=trading&workspace=routing", group: "Trading", icon: Radio },
    { title: "Aktive Positionen anzeigen", url: "/dashboard?tab=trading&workspace=activity", group: "Trading", icon: Activity },
    { title: "Trade Journal öffnen", url: "/dashboard?tab=trading&workspace=journal", group: "Trading", icon: Activity },
    { title: "Jetzt mit Börsen abgleichen", group: "Aktionen", icon: Activity, action: reconcile },
    { title: "Notfallaktionen öffnen", url: "/dashboard", group: "Aktionen", icon: Shield },
    { title: "System Logs", url: "/dashboard?tab=logs", group: "System", icon: Settings },
    { title: "System & Backup", url: "/dashboard?tab=system", group: "System", icon: Shield },
    ...tradingItems,
  ]

  const groupedItems = searchItems.reduce((acc, item) => {
    if (!acc[item.group]) {
      acc[item.group] = []
    }
    acc[item.group].push(item)
    return acc
  }, {} as Record<string, SearchItem[]>)

  const handleSelect = async (item: SearchItem) => {
    try {
      if (item.action) await item.action()
      else if (item.url) navigate(item.url)
      onOpenChange(false)
    } catch (error) {
      console.error("Command-Palette-Aktion fehlgeschlagen.", error)
    }
    // Bounce effect like Vercel
    if (commandRef.current) {
      commandRef.current.style.transform = 'scale(0.96)'
      setTimeout(() => {
        if (commandRef.current) {
          commandRef.current.style.transform = ''
        }
      }, 100)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 shadow-2xl border border-zinc-200 dark:border-zinc-800 max-w-[640px]">
        <DialogTitle className="sr-only">Command Search</DialogTitle>
        <Command
          ref={commandRef}
          className="transition-transform duration-100 ease-out"
        >
          <CommandInput placeholder="What do you need?" autoFocus />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            {Object.entries(groupedItems).map(([group, items]) => (
              <CommandGroup key={group} heading={group}>
                {items.map((item) => {
                  const Icon = item.icon
                  return (
                    <CommandItem
                      key={`${group}-${item.title}`}
                      value={`${item.title} ${item.keywords || ""}`}
                      onSelect={() => void handleSelect(item)}
                    >
                      {Icon && <Icon className="mr-2 h-4 w-4" />}
                      {item.title}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

export function SearchTrigger({ onClick }: Readonly<{ onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-8 px-3 py-1 relative w-full justify-start text-muted-foreground sm:pr-12 md:w-36 lg:w-56"
    >
      <Search className="mr-2 h-3.5 w-3.5" />
      <span className="hidden lg:inline-flex">Search...</span>
      <span className="inline-flex lg:hidden">Search...</span>
      <kbd className="pointer-events-none absolute right-1.5 top-1.5 hidden h-4 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
        <span className="text-xs">⌘</span>K
      </kbd>
    </button>
  )
}
