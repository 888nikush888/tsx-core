import { useState } from "react";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BellRing, CircleAlert, Search } from "lucide-react";
import { NAVIGATION } from "@/shell/navigation";
import { useDemo } from "@/adapter/demo-kontext";
import { SZENARIEN, isOffline } from "@/adapter/memory";
import { catalogParams } from "@/data/fixtures";

export function TsxAppShell({ pfad, gehen, children }: { pfad: string; gehen: (z: string) => void; children: React.ReactNode }) {
  const { szenario, setzeSzenario, rolle, setzeRolle, demoKonto, setzeDemoKonto } = useDemo();
  const [sucheOffen, setSucheOffen] = useState(false);
  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <div className="flex items-center gap-2 px-2 py-1">
              <div className="flex size-8 items-center justify-center rounded-md bg-primary font-semibold text-primary-foreground">TX</div>
              <div>
                <p className="text-sm font-semibold">TSX Core</p>
                <p className="text-xs text-muted-foreground">Designvorschau</p>
              </div>
            </div>
          </SidebarHeader>
          <SidebarContent>
            {NAVIGATION.map((b) => (
              <SidebarGroup key={b.id}>
                <SidebarGroupLabel>{b.titel}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {b.eintraege.map((e) => (
                      <SidebarMenuItem key={e.route}>
                        <SidebarMenuButton isActive={pfad === e.route || pfad.startsWith(e.route + "/")} onClick={() => gehen(e.route)}>
                          <span>{e.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>
        </Sidebar>
        <SidebarInset>
          <div className="border-b bg-amber-50 px-4 py-1.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200" role="note">
            Designvorschau – ausschliesslich Beispieldaten – keine echten Aktionen.
          </div>
          <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
            <SidebarTrigger />
            <Button variant="outline" size="sm" onClick={() => setSucheOffen(true)}>
              <Search data-icon="inline-start" /> Suchen <kbd className="ml-2 rounded border px-1 text-xs">Strg K</kbd>
            </Button>
            <Badge variant={demoKonto === "paper-1" ? "secondary" : "destructive"}>Paper-Labor</Badge>
            <Select value={demoKonto} onValueChange={(v) => { if (v) setzeDemoKonto(v); }}>
              <SelectTrigger className="w-44" aria-label="Demokonto"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="paper-1">Paper-Labor</SelectItem><SelectItem value="live-1">Live-Testkonto (Demo)</SelectItem></SelectContent>
            </Select>
            <span className="flex-1" />
            <Badge variant={isOffline() || szenario === "offline" ? "destructive" : "secondary"}>
              {isOffline() || szenario === "offline" ? "Getrennt (simuliert)" : "Verbunden (simuliert)"}
            </Badge>
            <Badge variant="outline">Gespeichert · Rev. 7</Badge>
            <Button variant="ghost" size="sm" onClick={() => gehen("/betrieb/logs")} aria-label="Handlungsbedarf">
              <BellRing data-icon="inline-start" /> 2
            </Button>
            <Select value={rolle} onValueChange={(v) => { if (v === "admin" || v === "lesend") setzeRolle(v); }}>
              <SelectTrigger className="w-32" aria-label="Demorolle"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="admin">Admin (Demo)</SelectItem><SelectItem value="lesend">Lesend (Demo)</SelectItem></SelectContent>
            </Select>
            <Select value={szenario} onValueChange={(v) => { if (v) setzeSzenario(v as typeof szenario); }}>
              <SelectTrigger className="w-48" aria-label="Szenario"><SelectValue placeholder="Szenario" /></SelectTrigger>
              <SelectContent>
                {SZENARIEN.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </header>
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
        </SidebarInset>
        <Dialog open={sucheOffen} onOpenChange={setSucheOffen}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Globale Suche</DialogTitle>
            <Command label="Globale Suche">
              <CommandInput placeholder="Seite, Ressource oder Parameter suchen (deutsch oder technisch) …" />
              <CommandList>
                <CommandEmpty>Keine Treffer.</CommandEmpty>
                <CommandGroup heading="Seiten">
                  {NAVIGATION.flatMap((b) => b.eintraege).map((e) => (
                    <CommandItem key={e.route} value={e.label} onSelect={() => { gehen(e.route); setSucheOffen(false); }}>{e.label}</CommandItem>
                  ))}
                </CommandGroup>
                <CommandGroup heading="Parameter">
                  {catalogParams.map((p) => (
                    <CommandItem key={p.path} value={`${p.label} ${p.path}`} onSelect={() => { gehen(p.route); setSucheOffen(false); }}>
                      {p.label} <span className="text-muted-foreground">· {p.path}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
            <p className="flex items-center gap-1 text-xs text-muted-foreground"><CircleAlert data-icon="inline-start" /> Suchindex enthaelt keine Secrets.</p>
          </DialogContent>
        </Dialog>
        <Separator />
      </SidebarProvider>
    </TooltipProvider>
  );
}
