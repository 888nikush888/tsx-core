import { useState } from "react"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { XCircle, Regex, FileType, Info } from "lucide-react"

export function FiltersTab({ config, setConfig }: any) {
  const [selectedSource, setSelectedSource] = useState<string | null>(null);

  if (!config?.filters) return null;

  const handleFilterChange = (key: string, rawText: string) => {
    setConfig({
      ...config,
      filters: {
        ...config.filters,
        [key]: rawText.split('\n').map(s => s.trim())
      }
    })
  }

  const handleSourceRegexChange = (source: string, rawText: string) => {
    const newSourceFilters = { ...config.sourceFilters };
    const patterns = rawText.split('\n').map(s => s.trim());
    
    if (patterns.length === 0 || (patterns.length === 1 && patterns[0] === '')) {
      delete newSourceFilters[source];
    } else {
      if (!newSourceFilters[source]) newSourceFilters[source] = {};
      newSourceFilters[source].regexPatterns = patterns;
    }

    setConfig({
      ...config,
      sourceFilters: newSourceFilters
    });
  }

  return (
    <div className="space-y-6">
      
      <div className="grid gap-6 md:grid-cols-2">
        
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2 font-medium text-foreground">
              <XCircle className="h-5 w-5" />
              <CardTitle>Blocked Keywords</CardTitle>
            </div>
            <CardDescription>
              Drop messages that contain ANY of these keywords, regardless of other rules.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea 
              rows={5}
              placeholder="scam&#10;spam&#10;discount"
              value={(config.filters.blockedKeywords || []).join('\n')}
              onChange={(e) => handleFilterChange("blockedKeywords", e.target.value)} 
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileType className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Allowed Message Types</CardTitle>
            </div>
            <CardDescription>
              Restrict forwarding to specific media types (e.g. text only).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea 
              rows={5}
              placeholder="message&#10;photo&#10;video"
              value={(config.filters.allowedTypes || []).join('\n')}
              onChange={(e) => handleFilterChange("allowedTypes", e.target.value)} 
            />
            <p className="text-sm text-muted-foreground mt-2">Leave empty to allow all types.</p>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Regex className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Global Regex Filters</CardTitle>
            </div>
            <CardDescription>
              Advanced rule matching. Messages matching these patterns are dropped across ALL channels.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea 
              rows={5}
              className="font-mono text-sm"
              placeholder="^Drop me.*$&#10;https?:\/\/.*"
              value={(config.filters.regexPatterns || []).join('\n')}
              onChange={(e) => handleFilterChange("regexPatterns", e.target.value)} 
            />
          </CardContent>
        </Card>

        <Card className="md:col-span-2 border-primary/20">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Regex className="h-5 w-5 text-primary" />
              <CardTitle>Source-Specific Regex Filters</CardTitle>
            </div>
            <CardDescription>
              Override or extend regex patterns for specific source channels.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(!config.sourceChannels || config.sourceChannels.length === 0) ? (
              <p className="text-sm text-muted-foreground">No source channels configured yet.</p>
            ) : (
              <div className="grid gap-4 md:grid-cols-4">
                <div className="md:col-span-1 space-y-2 border-r pr-4">
                  <p className="text-sm font-medium">Select Source:</p>
                  <div className="flex flex-col gap-1 max-h-[250px] overflow-y-auto">
                    {config.sourceChannels.map((ch: string) => {
                      const alias = config.sourceAliases?.[ch];
                      const displayLabel = alias ? `${alias} (${ch})` : ch;
                      const hasSpecific = Boolean(config.sourceFilters?.[ch]?.regexPatterns?.length);
                      const isSelected = selectedSource === ch;
                      return (
                        <button
                          type="button"
                          key={ch}
                          onClick={() => setSelectedSource(ch)}
                          className={`text-left px-2 py-1.5 text-xs rounded-md transition-colors truncate ${isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                          title={displayLabel}
                        >
                          {displayLabel}
                          {hasSpecific && !isSelected && <span className="ml-1 text-[8px] bg-primary/20 text-primary px-1 rounded font-sans font-normal">Custom</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="md:col-span-3">
                  {selectedSource ? (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">
                        Regex Patterns for {" "}
                        <span className="text-primary font-mono">
                          {config.sourceAliases?.[selectedSource] ? `${config.sourceAliases[selectedSource]} (${selectedSource})` : selectedSource}
                        </span>
                      </p>
                      <Textarea 
                        rows={6}
                        className="font-mono text-sm"
                        placeholder="^Drop me.*$&#10;https?:\/\/.*"
                        value={(config.sourceFilters?.[selectedSource]?.regexPatterns || []).join('\n')}
                        onChange={(e) => handleSourceRegexChange(selectedSource, e.target.value)} 
                      />
                      <p className="text-sm text-muted-foreground">Leave empty to use global regex rules.</p>
                    </div>
                  ) : (
                    <div className="h-full flex items-center justify-center text-muted-foreground text-sm border-2 border-dashed rounded-md p-6">
                      Select a source channel from the list to configure its specific regex filters.
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

      </div>

      {/* Kurzanleitung: ausschließlich Regex-Muster und -Zeichen */}
      <Card className="bg-muted/50 border-zinc-200 dark:border-zinc-800">
        <CardContent className="pt-6 flex gap-3">
          <Info className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="space-y-1 text-sm text-foreground">
            <h4 className="font-semibold text-zinc-900 dark:text-zinc-100">Kurzanleitung: Regex-Muster und Zeichen</h4>
            <p className="text-xs text-muted-foreground">Nur für reguläre Ausdrücke: Jedes Muster wird in einer eigenen Zeile geprüft.</p>
            <div className="grid gap-2 sm:grid-cols-2 mt-3 text-xs text-muted-foreground font-mono">
              <div className="space-y-1">
                <div><span className="text-primary font-semibold">^Text</span> – Zeilenanfang</div>
                <div><span className="text-primary font-semibold">Text$</span> – Zeilenende</div>
                <div><span className="text-primary font-semibold">.</span> – ein beliebiges Zeichen</div>
                <div><span className="text-primary font-semibold">.*</span> – beliebig viele Zeichen</div>
              </div>
              <div className="space-y-1">
                <div><span className="text-primary font-semibold">wort1|wort2</span> – entweder/oder</div>
                <div><span className="text-primary font-semibold">[0-9]+</span> – eine oder mehr Ziffern</div>
                <div><span className="text-primary font-semibold">?</span> – vorheriges Zeichen optional</div>
                <div><span className="text-primary font-semibold">\bwort\b</span> – ganzes Wort</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

    </div>
  )
}
