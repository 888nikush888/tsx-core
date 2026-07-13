import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { BrainCircuit, FolderOutput, Trash2, Plus, Save, FileCode } from "lucide-react"

const API_BASE = window.location.origin

export function ParserTab({ config, setConfig, envConfig, setEnvConfig }: any) {
  const [templates, setTemplates] = useState<Record<string, string>>({ default: "" })
  const [selectedTemplateName, setSelectedTemplateName] = useState<string>("default")
  const [newTemplateName, setNewTemplateName] = useState<string>("")
  const [activeContent, setActiveContent] = useState<string>("")
  const [isLoadingTemplates, setIsLoadingTemplates] = useState<boolean>(true)
  const [isSavingTemplate, setIsSavingTemplate] = useState<boolean>(false)

  const fetchTemplates = async (preferredName?: string) => {
    try {
      setIsLoadingTemplates(true)
      const res = await fetch(`${API_BASE}/api/templates`)
      const data = await res.json()
      if (data.templates) {
        setTemplates(data.templates)
        const requestedName = preferredName || selectedTemplateName
        const activeName = data.templates[requestedName] !== undefined ? requestedName : "default"
        setSelectedTemplateName(activeName)
        setActiveContent(data.templates[activeName] || "")
      }
    } catch (e) {
      console.error("Failed to fetch templates:", e)
    } finally {
      setIsLoadingTemplates(false)
    }
  }

  useEffect(() => {
    fetchTemplates()
  }, [])

  // Sync editor content when selected template changes
  useEffect(() => {
    setActiveContent(templates[selectedTemplateName] || "")
  }, [selectedTemplateName, templates])

  const handleXmlChange = (key: string, value: any) => {
    setConfig({
      ...config,
      xmlParsing: {
        ...config.xmlParsing,
        [key]: value
      }
    })
  }

  const handleSaveTemplate = async () => {
    setIsSavingTemplate(true)
    try {
      const res = await fetch(`${API_BASE}/api/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: selectedTemplateName, content: activeContent })
      })
      if (res.ok) {
        // Update local state
        setTemplates(prev => ({
          ...prev,
          [selectedTemplateName]: activeContent
        }))
        alert(`Prompt-Template „${selectedTemplateName}“ wurde gespeichert.`)
      } else {
        const err = await res.json()
        alert("Template konnte nicht gespeichert werden: " + err.error)
      }
    } catch (e: any) {
      alert("Template konnte nicht gespeichert werden: " + e.message)
    } finally {
      setIsSavingTemplate(false)
    }
  }

  const handleCreateTemplate = async () => {
    const cleanName = newTemplateName.trim().toLowerCase()
    if (!cleanName) return
    if (!/^[a-zA-Z0-9_-]+$/.test(cleanName)) {
      alert("Der Name darf nur Buchstaben, Zahlen, Bindestriche und Unterstriche enthalten.")
      return
    }
    if (templates[cleanName] !== undefined) {
      alert("Ein Template mit diesem Namen existiert bereits.")
      return
    }

    try {
      const res = await fetch(`${API_BASE}/api/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cleanName, content: "" })
      })
      if (res.ok) {
        setNewTemplateName("")
        await fetchTemplates(cleanName)
      } else {
        const err = await res.json()
        alert("Template konnte nicht erstellt werden: " + err.error)
      }
    } catch (e: any) {
      alert("Template konnte nicht erstellt werden: " + e.message)
    }
  }

  const handleDeleteTemplate = async (nameToDelete: string) => {
    if (nameToDelete === "default") return
    if (!window.confirm(`Template „${nameToDelete}“ wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`)) return

    try {
      const res = await fetch(`${API_BASE}/api/templates?name=${encodeURIComponent(nameToDelete)}`, {
        method: "DELETE"
      })
      if (res.ok) {
        const sourceTemplates = { ...(config.xmlParsing.sourceTemplates || {}) }
        Object.keys(sourceTemplates).forEach((channel) => {
          if (sourceTemplates[channel] === nameToDelete) delete sourceTemplates[channel]
        })
        setConfig({
          ...config,
          xmlParsing: { ...config.xmlParsing, sourceTemplates }
        })
        if (selectedTemplateName === nameToDelete) {
          setSelectedTemplateName("default")
        }
        await fetchTemplates(selectedTemplateName === nameToDelete ? "default" : selectedTemplateName)
      } else {
        const err = await res.json()
        alert("Template konnte nicht gelöscht werden: " + err.error)
      }
    } catch (e: any) {
      alert("Template konnte nicht gelöscht werden: " + e.message)
    }
  }

  if (!config || !config.xmlParsing) return null;

  return (
    <div className="space-y-6">
      
      <Card className="border-primary/50 shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-2 text-primary">
            <BrainCircuit className="h-6 w-6" />
            <CardTitle className="text-xl">OpenAI Parser</CardTitle>
          </div>
          <CardDescription>
            Intercepts incoming messages and passes them to OpenAI to extract structured XML signals.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-col sm:flex-row gap-4 justify-between items-center bg-muted/50 p-4 rounded-lg border">
            <div>
              <Label className="text-base font-semibold">Enable Parser Engine</Label>
              <p className="text-sm text-muted-foreground">Toggle the AI interceptor on or off globally.</p>
            </div>
            <Switch 
              checked={config.xmlParsing.enabled} 
              onCheckedChange={(c) => handleXmlChange("enabled", c)} 
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2 pt-2">
            <div className="space-y-2">
              <Label htmlFor="apiKey">OpenRouter API Key</Label>
              <Input 
                id="apiKey" 
                type="password"
                placeholder={envConfig?.openRouterApiKeyConfigured ? "•••••••••••••••• (Configured)" : "sk-or-v1-..."}
                value={envConfig?.openRouterApiKey || ''} 
                onChange={(e) => setEnvConfig?.({ ...envConfig, openRouterApiKey: e.target.value })} 
              />
              <p className="text-xs text-muted-foreground">Requires an OpenRouter API Key for AI inference.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="parserTimeout">Parser Timeout (ms)</Label>
              <Input 
                id="parserTimeout" 
                type="number"
                placeholder="60000"
                value={config.xmlParsing.timeout || 60000} 
                onChange={(e) => handleXmlChange("timeout", parseInt(e.target.value) || 60000)} 
              />
              <p className="text-xs text-muted-foreground">Time before the parser gives up on a message.</p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="primaryModel">Primary Model</Label>
              <Input 
                id="primaryModel" 
                placeholder="google/gemini-flash-1.5"
                value={envConfig?.openRouterModel || ''} 
                onChange={(e) => setEnvConfig?.({ ...envConfig, openRouterModel: e.target.value })} 
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="fallbackModel">Fallback Model</Label>
              <Input 
                id="fallbackModel" 
                placeholder="anthropic/claude-3-haiku"
                value={envConfig?.openRouterFallbackModel || ''} 
                onChange={(e) => setEnvConfig?.({ ...envConfig, openRouterFallbackModel: e.target.value })} 
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label className="text-base">Forward XML</Label>
                <p className="text-sm text-muted-foreground">Send the raw XML to target channel</p>
              </div>
              <Switch 
                checked={config.xmlParsing.forwardXmlToTarget} 
                onCheckedChange={(c) => handleXmlChange("forwardXmlToTarget", c)} 
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label className="text-base">Save to File</Label>
                <p className="text-sm text-muted-foreground">Write the XML output to disk</p>
              </div>
              <Switch 
                checked={config.xmlParsing.saveToFile} 
                onCheckedChange={(c) => handleXmlChange("saveToFile", c)} 
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FolderOutput className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Storage</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="signalsDir">Signals Output Directory</Label>
            <Input 
              id="signalsDir" 
              className="font-mono text-sm max-w-md"
              value={config.xmlParsing.signalsDir || ''} 
              onChange={(e) => handleXmlChange("signalsDir", e.target.value)} 
            />
          </div>
        </CardContent>
      </Card>

      {/* NEW: Prompt Templates Manager Card */}
      <Card className="border-primary/20">
        <CardHeader>
          <div className="flex items-center gap-2">
            <FileCode className="h-5 w-5 text-primary" />
            <CardTitle>Prompt Templates verwalten (.txt Dateien)</CardTitle>
          </div>
          <CardDescription>
            Erstellen und bearbeiten Sie die Prompts, die den KI-Verhalten für verschiedene Signaltypen steuern.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-4">
            <div className="md:col-span-1 space-y-4 border-r pr-4">
              <div className="space-y-2">
                <Label>Template auswählen:</Label>
                {isLoadingTemplates ? (
                  <div className="text-xs text-muted-foreground italic">Lade Templates...</div>
                ) : (
                  <div className="flex flex-col gap-1 max-h-[220px] overflow-y-auto">
                    {Object.keys(templates).map((name) => {
                      const isSelected = selectedTemplateName === name
                      return (
                        <div key={name} className="flex items-center justify-between group">
                          <button
                            onClick={() => setSelectedTemplateName(name)}
                            className={`flex-1 text-left px-2 py-1.5 text-xs rounded-md transition-colors truncate ${isSelected ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-muted'}`}
                          >
                            {name} {name === 'default' && <span className="text-[10px] opacity-75">(Standard)</span>}
                          </button>
                          {name !== 'default' && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:bg-destructive/10 shrink-0"
                              title={`Template ${name} löschen`}
                              aria-label={`Template ${name} löschen`}
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDeleteTemplate(name)
                              }}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="space-y-2 pt-4 border-t">
                <Label htmlFor="new-template-name">Neues Template erstellen</Label>
                <div className="flex gap-2">
                  <Input 
                    id="new-template-name"
                    placeholder="z.B. vip_signals" 
                    className="h-8 text-xs font-mono"
                    value={newTemplateName}
                    onChange={(e) => setNewTemplateName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        handleCreateTemplate()
                      }
                    }}
                  />
                  <Button size="sm" className="h-8" onClick={handleCreateTemplate} disabled={!newTemplateName.trim()}>
                    <Plus className="h-4 w-4" />
                    Erstellen
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Erlaubt sind Buchstaben, Zahlen, - und _.</p>
              </div>
            </div>

            <div className="md:col-span-3 space-y-4">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-semibold">
                  Editor: <span className="text-primary font-mono">{selectedTemplateName}.txt</span>
                </Label>
                <Button size="sm" onClick={handleSaveTemplate} disabled={isSavingTemplate || isLoadingTemplates}>
                  <Save className="h-4 w-4 mr-2" />
                  {isSavingTemplate ? "Speichere..." : "Prompt speichern"}
                </Button>
              </div>

              <Textarea
                rows={12}
                className="font-mono text-xs leading-relaxed"
                placeholder="Geben Sie hier die Prompt-Instruktionen ein..."
                value={activeContent}
                onChange={(e) => setActiveContent(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Speichern Sie Änderungen am aktiven Template ab, bevor Sie auf ein anderes Template wechseln.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* NEW: Channel to Template Assignment Mapping */}
      <Card className="border-primary/20">
        <CardHeader>
          <CardTitle>Kanälen Templates zuweisen</CardTitle>
          <CardDescription>
            Weisen Sie Ihren Quell-Kanälen die oben erstellten Prompt-Templates zu. Kanäle ohne Zuweisung verwenden das Standard-Template.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(!config.sourceChannels || config.sourceChannels.length === 0) ? (
            <p className="text-sm text-muted-foreground italic">Keine Quell-Kanäle konfiguriert. Bitte legen Sie diese zuerst im Kanäle-Tab an.</p>
          ) : (
            <div className="space-y-3 max-w-2xl">
              {config.sourceChannels.map((ch: string) => {
                const alias = config.sourceAliases?.[ch];
                const displayLabel = alias ? `${alias} (${ch})` : ch;
                const assignedTemplate = config.xmlParsing.sourceTemplates?.[ch] || "default";

                return (
                  <div key={ch} className="flex items-center justify-between gap-4 p-2 bg-muted/40 rounded-lg border">
                    <div className="font-mono text-xs truncate max-w-sm" title={displayLabel}>
                      {displayLabel}
                    </div>
                    <select
                      className="h-8 rounded-md border border-input bg-background px-3 py-1 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring font-mono"
                      value={assignedTemplate}
                      onChange={(e) => {
                        const val = e.target.value;
                        const newMappings = { ...(config.xmlParsing.sourceTemplates || {}) };
                        if (val === 'default') {
                          delete newMappings[ch];
                        } else {
                          newMappings[ch] = val;
                        }
                        setConfig({
                          ...config,
                          xmlParsing: {
                            ...config.xmlParsing,
                            sourceTemplates: newMappings
                          }
                        });
                      }}
                    >
                      <option value="default">default (Standard)</option>
                      {Object.keys(templates)
                        .filter(name => name !== 'default')
                        .map(name => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                    </select>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  )
}
