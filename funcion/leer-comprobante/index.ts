// Lee una foto o captura de un comprobante de transferencia (Nequi, Bancolombia, Daviplata...) con Gemini
// y devuelve los datos en JSON. La app manda {pin, imagen (base64 JPEG)}; sin el PIN correcto no responde.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const MODELOS = ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"];

let secretos: Record<string, string> | null = null;
async function cargar() {
  if (secretos) return secretos;
  const filas = await sql`select name, decrypted_secret from vault.decrypted_secrets where name in ('gemini_api_key', 'suma_pagos_pin')`;
  secretos = Object.fromEntries(filas.map((f) => [f.name, f.decrypted_secret]));
  return secretos;
}
function iguales(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const responder = (cuerpo: unknown, estado = 200) =>
  new Response(JSON.stringify(cuerpo), { status: estado, headers: { ...CORS, "Content-Type": "application/json" } });

const INSTRUCCIONES = `Eres un lector de comprobantes de transferencias bancarias de Colombia (Nequi, Bancolombia, Daviplata, Nu, Davivienda, BBVA, Banco de Bogotá, Transfiya, Bre-B, etc.).
La imagen puede ser una captura de pantalla o una FOTO de un celular, con reflejos o inclinada. Léela con cuidado.
Devuelve SOLO un JSON con estos campos:
- es_comprobante: true si la imagen es un comprobante de pago o transferencia, false si no.
- banco: app o banco desde donde se ve el comprobante (ej. "Nequi").
- valor: el monto transferido como número entero en pesos colombianos, sin puntos ni decimales. En Colombia el punto separa miles y la coma los decimales: "60.000,00" = 60000; "$ 1.250.000" = 1250000.
- fecha: fecha del movimiento en formato AAAA-MM-DD ("08 de octubre de 2026" = "2026-10-08").
- hora: hora en formato 24 h HH:MM ("5:23 p.m." = "17:23"). Vacío si no aparece.
- referencia: número o código de referencia/comprobante/aprobación tal cual aparece. Vacío si no hay.
- remitente: quién envió la plata: nombre, o el número desde donde se hizo el envío. Vacío si no aparece.
- destinatario: a quién le llegó (nombre o llave que aparece en "Para").
- estado: "exitoso", "pendiente" o "fallido" según lo que diga el comprobante.
- confianza: "alta" si el valor se lee claramente, "media" o "baja" si hay dudas.
Si un dato no aparece, déjalo como cadena vacía (o 0 en valor). No inventes datos.`;

const ESQUEMA = {
  type: "OBJECT",
  properties: {
    es_comprobante: { type: "BOOLEAN" }, banco: { type: "STRING" }, valor: { type: "NUMBER" },
    fecha: { type: "STRING" }, hora: { type: "STRING" }, referencia: { type: "STRING" },
    remitente: { type: "STRING" }, destinatario: { type: "STRING" }, estado: { type: "STRING" }, confianza: { type: "STRING" },
  },
  required: ["es_comprobante", "valor", "fecha", "referencia", "confianza"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return responder({ error: "Usa POST" }, 405);
  let cuerpo: { pin?: string; imagen?: string; tipo?: string };
  try { cuerpo = await req.json(); } catch { return responder({ error: "Cuerpo inválido" }, 400); }
  const s = await cargar();
  if (!cuerpo.pin || !s.suma_pagos_pin || !iguales(String(cuerpo.pin), s.suma_pagos_pin)) return responder({ error: "PIN incorrecto" }, 401);
  if (!cuerpo.imagen) return responder({ ok: true }); // sirve para comprobar el PIN
  if (cuerpo.imagen.length > 6_000_000) return responder({ error: "La imagen es muy grande" }, 413);

  const peticion = {
    contents: [{ parts: [{ inlineData: { mimeType: cuerpo.tipo || "image/jpeg", data: cuerpo.imagen } }, { text: INSTRUCCIONES }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: ESQUEMA, temperature: 0 },
  };
  let ultimoError = "";
  for (const modelo of MODELOS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
        method: "POST", headers: { "x-goog-api-key": s.gemini_api_key, "Content-Type": "application/json" }, body: JSON.stringify(peticion),
      });
      if (!r.ok) { ultimoError = `${modelo}: ${r.status}`; continue; }
      const j = await r.json();
      const texto = j.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") || "";
      const datos = JSON.parse(texto);
      datos.valor = Math.round(Number(datos.valor) || 0);
      return responder({ ok: true, modelo, datos });
    } catch (e) { ultimoError = `${modelo}: ${(e as Error).message}`; }
  }
  return responder({ error: "No pude leer la imagen ahora. Intenta en un minuto.", detalle: ultimoError }, 503);
});
