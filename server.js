// server.js : contrôle LIFX en réseau local (LAN), sans cloud ni token.
// La page web (index.html) parle à ce serveur, qui parle aux ampoules en UDP (port 56700).
const http = require("http");
const fs = require("fs");
const path = require("path");
const Lifx = require("node-lifx-lan");

const PORT = process.env.PORT || 3000;
let devices = [];

async function getDevices(force = false) {
  if (force || devices.length === 0) devices = await Lifx.discover();
  return devices;
}

// "#rrggbb" -> teinte et saturation entre 0 et 1
function hexToHs(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return { hue: h, saturation: max ? d / max : 0 };
}

// Traduit la commande de la page en appels node-lifx-lan
async function apply(device, { power, brightness, color, duration }) {
  const ms = Math.round((duration || 0) * 1000);
  if (power === "off") return device.turnOff({ duration: ms });

  const cur = (await device.lightGet()).color;
  const b = typeof brightness === "number" ? brightness : cur.brightness;
  let c = null;

  if (typeof color === "string" && color.startsWith("kelvin:")) {
    c = { hue: 0, saturation: 0, brightness: b, kelvin: Number(color.slice(7)) };
  } else if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) {
    c = { ...hexToHs(color), brightness: b };
  } else if (typeof brightness === "number") {
    c = { hue: cur.hue, saturation: cur.saturation, brightness: b };
  }
  return device.turnOn(c ? { color: c, duration: ms } : { duration: ms });
}

async function readState() {
  const list = await getDevices();
  const out = [];
  for (const d of list) {
    try {
      const s = await d.lightGet();
      out.push({
        power: s.power ? "on" : "off",
        brightness: s.color.brightness,
        color: { hue: s.color.hue * 360, saturation: s.color.saturation, kelvin: s.color.kelvin },
      });
    } catch (e) { /* ampoule injoignable : ignorée */ }
  }
  return out;
}

async function sendCommand(body) {
  let list = await getDevices();
  const run = (ds) => Promise.allSettled(ds.map((d) => apply(d, body)));
  let settled = await run(list);
  // Si tout a échoué (IP changée, ampoule redémarrée), on refait une découverte et on réessaie une fois
  if (list.length && settled.every((r) => r.status === "rejected")) {
    list = await getDevices(true);
    settled = await run(list);
  }
  return { results: settled.map((r) => ({ status: r.status === "fulfilled" ? "ok" : "offline" })) };
}

// ── IA : transforme un texte libre en commande pour l'ampoule ──
// Par défaut Groq (gratuit). Tout fournisseur compatible OpenAI fonctionne en changeant les 3 variables.
// La clé reste côté serveur, elle n'est jamais envoyée au navigateur.
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.GROQ_API_KEY;
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1";
const LLM_MODEL = process.env.LLM_MODEL || "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `Tu pilotes une ampoule connectée LIFX. L'utilisateur décrit une ambiance, une couleur ou une action (en français ou en anglais).
Réponds UNIQUEMENT par un objet JSON, sans texte autour ni balises markdown, de la forme :
{"power":"on"|"off","color":"#rrggbb"|null,"kelvin":1500-9000|null,"brightness":0-100|null,"message":"phrase courte en français décrivant ce que tu fais"}
Règles :
- "color" pour une couleur vive (rouge, bleu océan, coucher de soleil...). "kelvin" pour un blanc (bougie ~2000, chaud ~2700, neutre ~4000, froid ~6500). N'en donne qu'un des deux, l'autre à null.
- "brightness" en pourcentage ; null si l'utilisateur ne précise rien et que l'ambiance n'impose pas d'intensité.
- Si l'utilisateur demande d'éteindre : power "off", le reste à null.
- Si la demande n'a aucun rapport avec l'éclairage, choisis quand même l'ambiance la plus proche.`;

async function askLLM(prompt) {
  if (!LLM_API_KEY) throw new Error("LLM_API_KEY manquante sur le serveur");
  const r = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || data.error || `L'IA a répondu ${r.status}`);

  const raw = data.choices?.[0]?.message?.content || "";
  const match = raw.match(/\{[\s\S]*\}/); // tolère d'éventuelles balises ```json
  if (!match) throw new Error("Réponse de l'IA illisible");
  return JSON.parse(match[0]);
}

// Ne fait jamais confiance à la sortie du modèle : on valide tout avant d'envoyer à l'ampoule
function toCommand(g) {
  const message = typeof g.message === "string" ? g.message.slice(0, 200) : "";
  if (g.power === "off") {
    return { command: { power: "off", duration: 0.4 }, interpreted: { power: "off", color: null, kelvin: null, brightness: null, message } };
  }
  const hex = typeof g.color === "string" && /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : null;
  const kelvin = !hex && Number.isFinite(Number(g.kelvin)) && g.kelvin !== null
    ? Math.min(9000, Math.max(1500, Math.round(Number(g.kelvin)))) : null;
  const brightness = g.brightness !== null && Number.isFinite(Number(g.brightness))
    ? Math.min(100, Math.max(1, Math.round(Number(g.brightness)))) : null;

  const command = { power: "on", duration: 0.5 };
  if (hex) command.color = hex;
  else if (kelvin) command.color = `kelvin:${kelvin}`;
  if (brightness !== null) command.brightness = brightness / 100;
  return { command, interpreted: { power: "on", color: hex, kelvin, brightness, message } };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 10000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function reply(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      return reply(res, 200, fs.readFileSync(path.join(__dirname, "index.html")), "text/html; charset=utf-8");
    }
    if (req.url === "/api/light" && req.method === "GET") return reply(res, 200, await readState());
    if (req.url === "/api/light" && req.method === "POST") return reply(res, 200, await sendCommand(await readJson(req)));
    if (req.url === "/api/prompt" && req.method === "POST") {
      const { prompt } = await readJson(req);
      if (typeof prompt !== "string" || !prompt.trim()) return reply(res, 400, { error: "Prompt vide" });
      if (!LLM_API_KEY) return reply(res, 503, { error: "LLM_API_KEY non configurée" });
      const { command, interpreted } = toCommand(await askLLM(prompt.trim().slice(0, 500)));
      const { results } = await sendCommand(command);
      return reply(res, 200, { results, interpreted });
    }
    reply(res, 404, { error: "Introuvable" });
  } catch (e) {
    reply(res, 500, { error: e.message });
  }
}).listen(PORT, async () => {
  console.log(`Ouvre http://localhost:${PORT}`);
  console.log(LLM_API_KEY ? `IA activée (${LLM_MODEL})` : "LLM_API_KEY absente : les prompts utiliseront l'interprétation locale.");
  const found = await getDevices();
  console.log(found.length ? `${found.length} ampoule(s) trouvée(s) : ${found.map((d) => d.ipAddress).join(", ")}` : "Aucune ampoule trouvée pour l'instant.");
});