import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DetailPage } from "@/templates/DetailPage";

// Dieselben Komponenten wie auf den Fachseiten, keine Imitationen.
export function KomponentenSeite() {
  return <DetailPage pfad={[]} titel="Komponentenuebersicht"
    zusammenfassung={
    <div className="flex flex-col gap-3">
      <Card><CardHeader><CardTitle>Schaltflaechen & Kennzeichen</CardTitle><CardDescription>Varianten im Einsatz.</CardDescription></CardHeader><CardContent>
        <div className="flex flex-wrap items-center gap-2">
          <Button>Primaer</Button><Button variant="secondary">Sekundaer</Button><Button variant="outline">Kontur</Button>
          <Button variant="ghost">Geist</Button><Button variant="destructive">Gefahr</Button>
          <Badge>Standard</Badge><Badge variant="secondary">Zusatz</Badge><Badge variant="destructive">Fehler</Badge><Badge variant="outline">Kontur</Badge>
          <Avatar><AvatarFallback>TX</AvatarFallback></Avatar>
        </div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Eingaben</CardTitle></CardHeader><CardContent>
        <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5"><Label htmlFor="c-input">Text</Label><Input id="c-input" defaultValue="Beispiel" /></div>
          <div className="flex flex-col gap-1.5"><Label htmlFor="c-area">Bereich</Label><Textarea id="c-area" defaultValue="Mehrzeilig" /></div>
          <div className="flex flex-col gap-1.5"><Label>Auswahl</Label><Select defaultValue="a"><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="a">Option A</SelectItem><SelectItem value="b">Option B</SelectItem></SelectContent></Select></div>
          <div className="flex items-center gap-2"><Switch id="c-sw" defaultChecked /><Label htmlFor="c-sw">Schalter</Label></div>
          <div className="flex items-center gap-2"><Checkbox id="c-cb" defaultChecked /><Label htmlFor="c-cb">Kontrolle</Label></div>
          <div className="flex flex-col gap-1.5"><Label>Stufe</Label><Slider defaultValue={[40]} max={100} step={1} aria-label="Stufe" /></div>
          <RadioGroup defaultValue="x" className="flex gap-3"><div className="flex items-center gap-1.5"><RadioGroupItem value="x" id="r-x" /><Label htmlFor="r-x">X</Label></div><div className="flex items-center gap-1.5"><RadioGroupItem value="y" id="r-y" /><Label htmlFor="r-y">Y</Label></div></RadioGroup>
        </div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Rueckmeldung</CardTitle></CardHeader><CardContent>
        <div className="flex flex-col gap-3">
          <Alert><AlertTitle>Hinweis</AlertTitle><AlertDescription>Ruhige Informationsbox.</AlertDescription></Alert>
          <Tabs defaultValue="a"><TabsList><TabsTrigger value="a">Reiter A</TabsTrigger><TabsTrigger value="b">Reiter B</TabsTrigger></TabsList>
            <TabsContent value="a"><p className="text-sm">Inhalt A.</p></TabsContent><TabsContent value="b"><p className="text-sm">Inhalt B.</p></TabsContent></Tabs>
          <Empty><EmptyHeader><EmptyTitle>Leer</EmptyTitle><EmptyDescription>Leere Variante.</EmptyDescription></EmptyHeader></Empty>
          <div className="flex items-center gap-3"><Skeleton className="h-10 w-40" />
            <Tooltip><TooltipTrigger><Button variant="outline">Hinweis zeigen</Button></TooltipTrigger><TooltipContent>Kurzhilfe.</TooltipContent></Tooltip>
          </div>
        </div>
      </CardContent></Card>
      <Separator />
      <p className="text-xs text-muted-foreground">Tokens: neutral, Inter Variable, Standard-Radius · Hell/Dunkel ueber Preset-Tokens.</p>
    </div>} />;
}
