import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenAI } from 'openai';
import { addLog } from './ui.js';

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const SYSTEM_PROMPT = `You are an expert system that extracts structured cryptocurrency trading signals from unstructured chat messages and formats them into raw XML.
You must strictly return only valid XML conforming to the requested schema.
Do not include any conversational text, introductory text, markdown formatting blocks (like \`\`\`xml ... \`\`\`), or HTML tags outside of the defined XML schema.
Output ONLY the raw XML string starting with <signal> and ending with </signal>.

XML Schema:
<signal>
    <action>[LONG or SHORT]</action>
    <pair>[Trading pair, e.g. HYPEUSDT, BTCUSDT]</pair>
    <entry_range>
        <min>[Minimum entry price, float/decimal]</min>
        <max>[Maximum entry price, float/decimal]</max>
    </entry_range>
    <targets>
        <target id="[1, 2, ...]">[Target price, float/decimal]</target>
    </targets>
    <stoploss>[Stoploss price, float/decimal]</stoploss>
    <leverage>[Leverage multiplier, integer, optional]</leverage>
</signal>

Rules for extraction:
1. Action must be normalized to either "LONG" or "SHORT". "Buy", "Long", "Call" map to "LONG". "Sell", "Short", "Put" map to "SHORT".
2. If leverage is specified as a range or has text, extract only the numeric integer value (e.g. "15x" -> 15, "Cross 10x" -> 10). If leverage is not present in the message, omit the <leverage> element completely.
3. If entry range is a single price (e.g. "Entry: 95000" or "Einstieg bei 95000"), set both <min> and <max> to that price. If entry range is completely missing, omit the <entry_range> element.
4. Extracted target prices must be in order and assigned sequential IDs starting from 1.
5. All prices must be extracted as numbers (e.g. float or integer). Do not include currency symbols or text inside the price tags.

Here are examples of input messages and the expected XML output:

Example 1:
Input:
➡️ SHORT HYPEUSDT ❇️ Entry: 68.60000000 - 70.07400000☑️ Target 1: 67.32600000☑️ Target 2: 65.95200000☑️ Target 3: 64.57800000☑️ Target 4: 63.20400000⛔ Stoploss: 70.97474000💫 Leverage : 15x
Output:
<signal>
    <action>SHORT</action>
    <pair>HYPEUSDT</pair>
    <entry_range>
        <min>68.60000000</min>
        <max>70.07400000</max>
    </entry_range>
    <targets>
        <target id="1">67.32600000</target>
        <target id="2">65.95200000</target>
        <target id="3">64.57800000</target>
        <target id="4">63.20400000</target>
    </targets>
    <stoploss>70.97474000</stoploss>
    <leverage>15</leverage>
</signal>

Example 2:
Input:
LONG ETHUSDT Einstieg bei 3400.50 SL 3300.00 Targets: 1.) 3500.00 2.) 3600.00 3.) 3700.00
Output:
<signal>
    <action>LONG</action>
    <pair>ETHUSDT</pair>
    <entry_range>
        <min>3400.50</min>
        <max>3400.50</max>
    </entry_range>
    <targets>
        <target id="1">3500.00</target>
        <target id="2">3600.00</target>
        <target id="3">3700.00</target>
    </targets>
    <stoploss>3300.00</stoploss>
</signal>

Example 3:
Input:
Sell SOLUSDT Stop Loss: 150 Target: 130
Output:
<signal>
    <action>SHORT</action>
    <pair>SOLUSDT</pair>
    <targets>
        <target id="1">130</target>
    </targets>
    <stoploss>150</stoploss>
</signal>
`;

export function validateXmlStructure(xml: string, isDefaultTemplate = true): void {
  let cleanXml = xml.replace(/<!--.*?-->/gs, '').trim();

  if (!cleanXml.startsWith('<signal>') || !cleanXml.endsWith('</signal>')) {
    throw new Error("Root tag must be 'signal' and properly closed.");
  }

  if (!isDefaultTemplate) {
    return;
  }

  // Extract action
  const actionMatch = cleanXml.match(/<action>(.*?)<\/action>/s);
  if (!actionMatch || !actionMatch[1]) throw new Error("Missing required tag or value for 'action'");
  const action = actionMatch[1].trim();
  if (action !== 'LONG' && action !== 'SHORT') {
    throw new Error(`Action must be 'LONG' or 'SHORT', got '${action}'`);
  }

  // Extract pair
  const pairMatch = cleanXml.match(/<pair>(.*?)<\/pair>/s);
  if (!pairMatch || !pairMatch[1] || !pairMatch[1].trim()) throw new Error("Missing required tag or value for 'pair'");

  // Extract stoploss
  const stoplossMatch = cleanXml.match(/<stoploss>(.*?)<\/stoploss>/s);
  if (!stoplossMatch || !stoplossMatch[1] || !stoplossMatch[1].trim()) throw new Error("Missing required tag or value for 'stoploss'");
  const stoplossVal = stoplossMatch[1].trim();
  const stoploss = parseFloat(stoplossVal);
  if (isNaN(stoploss)) {
    throw new Error(`Stoploss must be a valid number, got '${stoplossVal}'`);
  }

  // Optional entry_range
  const entryRangeMatch = cleanXml.match(/<entry_range>(.*?)<\/entry_range>/s);
  if (entryRangeMatch) {
    const entryRangeText = entryRangeMatch[1];
    const minMatch = entryRangeText.match(/<min>(.*?)<\/min>/s);
    const maxMatch = entryRangeText.match(/<max>(.*?)<\/max>/s);
    if (!minMatch || !minMatch[1] || !minMatch[1].trim()) throw new Error("entry_range is missing 'min' tag or value");
    if (!maxMatch || !maxMatch[1] || !maxMatch[1].trim()) throw new Error("entry_range is missing 'max' tag or value");
    const min = parseFloat(minMatch[1].trim());
    const max = parseFloat(maxMatch[1].trim());
    if (isNaN(min) || isNaN(max)) {
      throw new Error(`min/max in entry_range must be valid numbers, got '${minMatch[1]}'/'${maxMatch[1]}'`);
    }
  }

  // Optional targets
  const targetsMatch = cleanXml.match(/<targets>(.*?)<\/targets>/s);
  if (targetsMatch) {
    const targetsText = targetsMatch[1];
    const targetBlocks = Array.from(targetsText.matchAll(/<target(.*?)>(.*?)<\/target>/gs));
    if (targetBlocks.length === 0) {
      const hasAnyTarget = targetsText.includes('<target');
      if (hasAnyTarget) {
        throw new Error("target element is missing 'id' attribute or malformed");
      }
      throw new Error("targets tag is present but contains no target tags");
    }
    for (const match of targetBlocks) {
      const startTagContent = match[1];
      const val = match[2].trim();
      
      const idMatch = startTagContent.match(/id="([^"]+)"/);
      if (!idMatch || !idMatch[1]) {
        throw new Error("target element is missing 'id' attribute");
      }
      if (!val) {
        throw new Error("target element is empty");
      }
      if (isNaN(parseFloat(val))) {
        throw new Error(`target value must be a valid number, got '${val}'`);
      }
    }
  }

  // Optional leverage
  const leverageMatch = cleanXml.match(/<leverage>(.*?)<\/leverage>/s);
  if (leverageMatch && leverageMatch[1] && leverageMatch[1].trim()) {
    const levVal = leverageMatch[1].trim();
    if (!/^-?\d+$/.test(levVal)) {
      throw new Error(`leverage must be an integer, got '${levVal}'`);
    }
  }
}

export async function parseSignalToXml(messageText: string, templateName?: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const primaryModel = process.env.OPENROUTER_MODEL || "google/gemini-flash-1.5";
  const fallbackModel = process.env.OPENROUTER_FALLBACK_MODEL || "anthropic/claude-3-haiku";

  if (!apiKey || apiKey.trim() === "your_openrouter_api_key_here" || apiKey.trim() === "") {
    throw new Error(
      "OPENROUTER_API_KEY environment variable is not set. " +
      "Please configure it in the .env file or export it in your shell environment."
    );
  }

  let systemPrompt = SYSTEM_PROMPT;
  let isDefaultTemplate = true;

  if (templateName && templateName.trim() && templateName.toLowerCase() !== "default") {
    const cleanName = templateName.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(cleanName)) {
      console.error(`[XML-Parser WARN] Ungültiger Template-Name '${cleanName}' (Nur Alphanumerische Zeichen, Bindestriche und Unterstriche erlaubt). Verwende Standard-Prompt.`);
    } else {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const templatePath = path.join(__dirname, "..", "templates", `${cleanName}.txt`);
      try {
        if (fs.existsSync(templatePath)) {
          systemPrompt = await fsPromises.readFile(templatePath, "utf-8");
          isDefaultTemplate = false;
        } else {
          console.error(`[XML-Parser WARN] Template-Datei '${templatePath}' nicht gefunden. Verwende Standard-Prompt.`);
        }
      } catch (e: any) {
        console.error(`[XML-Parser WARN] Fehler beim Lesen von Template '${cleanName}': ${e.message}. Verwende Standard-Prompt.`);
      }
    }
  }

  const client = new OpenAI({
    baseURL: OPENROUTER_BASE_URL,
    apiKey: apiKey,
    defaultHeaders: {
      "HTTP-Referer": "http://localhost:8080",
      "X-Title": "Telegram Forwarder"
    }
  });

  async function fetchFromModel(modelName: string, maxAttempts: number, attemptLabel: string): Promise<string> {
    let lastError: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.error(`[XML-Parser] Sende Anfrage an ${attemptLabel} '${modelName}' (Versuch {attempt}/{maxAttempts})...`.replace("{attempt}", String(attempt)).replace("{maxAttempts}", String(maxAttempts)));
        
        const response = await client.chat.completions.create({
          model: modelName,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Input:\n${messageText}\nOutput:` }
          ],
          temperature: 0.0,
          extra_body: { include_reasoning: true } as any
        } as any);

        if (!response.choices || response.choices.length === 0) {
          throw new Error("OpenRouter API returned an empty response (no choices).");
        }

        const messageObj = response.choices[0].message;
        
        // Extract reasoning (thinking) path if any
        let reasoning: string | null = (messageObj as any).reasoning || null;
        if (!reasoning && (messageObj as any).model_extra) {
          reasoning = (messageObj as any).model_extra.reasoning || null;
        }

        if (reasoning) {
          console.error(`\n[OpenRouter Denkwege]\n${reasoning.trim()}\n[Ende Denkwege]`);
        }

        const reqId = response.id || 'N/A';
        const actualModel = response.model || modelName;
        console.error(`[OpenRouter INFO] Request-ID: ${reqId} | Model: ${actualModel}`);
        if (response.usage) {
          console.error(`[OpenRouter USAGE] Prompt: ${response.usage.prompt_tokens} | Completion: ${response.usage.completion_tokens} | Total: ${response.usage.total_tokens}`);
        }

        let xmlCandidate = messageObj.content;
        if (!xmlCandidate) {
          throw new Error("OpenRouter API returned empty message content.");
        }

        // Extract reasoning block inside tags if present
        const thinkMatch = xmlCandidate.match(/<think>(.*?)<\/think>/s);
        if (thinkMatch) {
          const extractedReasoning = thinkMatch[1].trim();
          if (extractedReasoning && !reasoning) {
            console.error(`\n[OpenRouter Denkwege (aus Content)]\n${extractedReasoning}\n[Ende Denkwege]`);
          }
          xmlCandidate = xmlCandidate.replace(/<think>.*?<\/think>/gs, '');
        }

        // Clean candidate response markdown blocks
        xmlCandidate = xmlCandidate.trim();
        if (xmlCandidate.startsWith("```")) {
          const lines = xmlCandidate.split(/\r?\n/);
          if (lines.length >= 3) {
            const startIdx = (lines[0].includes("xml") || lines[0].includes("html") || lines[0].trim() === "```") ? 1 : 0;
            const endIdx = lines[lines.length - 1].trim() === "```" ? lines.length - 1 : lines.length;
            xmlCandidate = lines.slice(startIdx, endIdx).join("\n").trim();
          }
        }

        const startTag = xmlCandidate.indexOf("<");
        const endTag = xmlCandidate.lastIndexOf(">");
        if (startTag !== -1 && endTag !== -1) {
          xmlCandidate = xmlCandidate.substring(startTag, endTag + 1);
        }

        validateXmlStructure(xmlCandidate, isDefaultTemplate);
        return xmlCandidate;

      } catch (err: any) {
        console.error(`[XML-Parser WARN] ${attemptLabel}-Versuch ${attempt}/${maxAttempts} fehlgeschlagen: ${err.message}`);
        lastError = err;
      }
    }
    throw lastError;
  }

  try {
    return await fetchFromModel(primaryModel, 4, "Primärmodell");
  } catch (primaryExc: any) {
    console.error(`[XML-Parser] Primärmodell '${primaryModel}' endgültig fehlgeschlagen nach 4 Retries. Wechsle zu Fallback-Modell '${fallbackModel}'...`);
    try {
      return await fetchFromModel(fallbackModel, 2, "Fallback-Modell");
    } catch {
      throw primaryExc;
    }
  }
}

// CLI entry point
const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && (
  process.argv[1] === __filename ||
  path.basename(process.argv[1]) === 'signal_parser.ts' ||
  path.basename(process.argv[1]) === 'signal_parser.js'
);

if (isMain) {
  const args = process.argv.slice(2);
  let text = '';
  let stdin = false;
  let filePath = '';
  let outputPath = '';
  let template = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--text') {
      text = args[++i];
    } else if (args[i] === '--stdin') {
      stdin = true;
    } else if (args[i] === '--file') {
      filePath = args[++i];
    } else if (args[i] === '--output') {
      outputPath = args[++i];
    } else if (args[i] === '--template') {
      template = args[++i];
    }
  }

  const runCli = async () => {
    let messageText = '';
    if (text) {
      messageText = text;
    } else if (filePath) {
      messageText = await fsPromises.readFile(filePath, 'utf-8');
    } else if (stdin) {
      messageText = await new Promise<string>((resolve) => {
        let input = '';
        process.stdin.on('data', chunk => { input += chunk; });
        process.stdin.on('end', () => { resolve(input); });
      });
    }

    if (!messageText.trim()) {
      console.error("Error: Input message text is empty.");
      process.exit(1);
    }

    try {
      const xmlOutput = await parseSignalToXml(messageText, template);
      if (outputPath) {
        const dir = path.dirname(outputPath);
        if (dir) {
          await fsPromises.mkdir(dir, { recursive: true });
        }
        await fsPromises.writeFile(outputPath, xmlOutput, 'utf-8');
        console.error(`Successfully saved XML to ${outputPath}`);
      } else {
        console.log(xmlOutput);
      }
      process.exit(0);
    } catch (err: any) {
      if (err.message?.includes("environment variable is not set")) {
        console.error(`Validation/Configuration Error: ${err.message}`);
        process.exit(2);
      } else {
        console.error(`Runtime/API Error: ${err.message}`);
        process.exit(3);
      }
    }
  };

  runCli().catch(err => {
    console.error(`Unexpected Error: ${err.message}`);
    process.exit(4);
  });
}
