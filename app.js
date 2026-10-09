// Suma de pagos: lee fotos o capturas de comprobantes de transferencia con IA y las suma.
// Los datos se guardan solo en este celular (localStorage). La lectura la hace la función
// "leer-comprobante" de Supabase, que pide el PIN.
const URL_LECTOR = "https://qzszwuiehdjndzqfbvsw.supabase.co/functions/v1/leer-comprobante";
const $ = (id) => document.getElementById(id);
const plata = (n) => "$" + Math.round(n || 0).toLocaleString("es-CO");

let pagos = cargar();
let pin = leerLocal("pin");

// ---------- Guardado local ----------
function leerLocal(k) { try { return localStorage.getItem(k); } catch { return null; } }
function cargar() { try { return JSON.parse(localStorage.getItem("pagos") || "[]"); } catch { return []; } }
function guardar() {
  const limpio = pagos.map(({ archivo, ...p }) => p);
  for (let intento = 0; intento < 3; intento++) {
    try { localStorage.setItem("pagos", JSON.stringify(limpio)); return; }
    catch {
      // Si se llena la memoria del navegador, quita las fotos grandes más viejas (se conservan miniaturas y datos)
      const conVista = limpio.filter((p) => p.vista);
      conVista.slice(0, Math.ceil(conVista.length / 3) || 1).forEach((p) => delete p.vista);
    }
  }
  toast("El celular se quedó sin espacio para guardar; borra comprobantes viejos.");
}
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("ver");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("ver"), 3000);
}

// ---------- PIN ----------
async function probarPin(p) {
  const r = await fetch(URL_LECTOR, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: p }) });
  return r.ok;
}
function mostrar() {
  $("pantalla-pin").hidden = !!pin;
  $("app").hidden = !pin;
  if (pin) pintar();
}
$("form-pin").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = $("pin").value.trim();
  $("pin-error").textContent = "";
  try {
    if (await probarPin(p)) { pin = p; try { localStorage.setItem("pin", p); } catch {} mostrar(); }
    else $("pin-error").textContent = "PIN incorrecto.";
  } catch { $("pin-error").textContent = "Sin conexión. Intenta de nuevo."; }
});

// ---------- Imágenes ----------
async function reducir(archivo, lado, calidad) {
  const bmp = await createImageBitmap(archivo);
  const escala = Math.min(1, lado / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * escala); c.height = Math.round(bmp.height * escala);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL("image/jpeg", calidad);
}

async function leer(pago) {
  const imagen = (await reducir(pago.archivo, 1600, 0.85)).split(",")[1];
  for (let intento = 0; intento < 4; intento++) {
    let r;
    try {
      r = await fetch(URL_LECTOR, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin, imagen, tipo: "image/jpeg" }) });
    } catch { await new Promise((ok) => setTimeout(ok, 3000 * (intento + 1))); continue; }
    if (r.status === 401) { pin = null; try { localStorage.removeItem("pin"); } catch {} mostrar(); throw new Error("PIN"); }
    if (r.ok) return (await r.json()).datos;
    await new Promise((ok) => setTimeout(ok, 4000 * (intento + 1))); // el lector está ocupado: espera y reintenta
  }
  throw new Error("No se pudo leer");
}

let cola = [], trabajando = 0;
function procesar() {
  while (trabajando < 2 && cola.length) {
    const pago = cola.shift(); trabajando++;
    leer(pago)
      .then((datos) => { Object.assign(pago, { estado: "listo", datos, valor: datos.valor }); })
      .catch((e) => { pago.estado = e.message === "PIN" ? "pendiente" : "fallo"; })
      .finally(() => { delete pago.archivo; trabajando--; guardar(); pintar(); procesar(); });
  }
}

$("archivos").addEventListener("change", async (e) => {
  const archivos = [...e.target.files];
  e.target.value = "";
  for (const archivo of archivos) {
    const pago = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), agregado: Date.now(), estado: "leyendo", archivo };
    try {
      pago.mini = await reducir(archivo, 160, 0.7);
      pago.vista = await reducir(archivo, 700, 0.7);
    } catch { pago.estado = "fallo"; }
    pagos.push(pago);
    if (pago.estado === "leyendo") cola.push(pago);
  }
  pintar(); procesar();
  if (archivos.length) toast(archivos.length === 1 ? "Leyendo el comprobante…" : `Leyendo ${archivos.length} comprobantes…`);
});

// ---------- Cuentas ----------
const normal = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function marcar() {
  const vistos = new Map();
  for (const p of [...pagos].sort((a, b) => a.agregado - b.agregado)) {
    p.repetido = false; p.motivo = "";
    if (p.estado !== "listo") continue;
    const d = p.datos || {};
    if (!d.es_comprobante) { p.motivo = "No parece un comprobante"; continue; }
    if (d.estado === "fallido") { p.motivo = "Transferencia fallida"; continue; }
    if (!p.valor) { p.motivo = "No se leyó el valor"; continue; }
    const llave = normal(d.referencia) ? "R" + normal(d.referencia) + "|" + p.valor : `S${p.valor}|${d.fecha}|${d.hora}|${normal(d.remitente)}`;
    if (vistos.has(llave)) { p.repetido = true; continue; }
    vistos.set(llave, p.id);
  }
}
const cuenta = (p) => p.estado === "listo" && !p.repetido && !p.motivo;

function pintar() {
  marcar();
  const filtro = $("filtro-fecha").value;
  // Fechas disponibles en el filtro
  const fechas = [...new Set(pagos.filter((p) => p.estado === "listo" && p.datos?.fecha).map((p) => p.datos.fecha))].sort().reverse();
  const sel = $("filtro-fecha");
  sel.innerHTML = '<option value="">Todas las fechas</option>' + fechas.map((f) => `<option value="${f}">${nombreFecha(f)}</option>`).join("");
  sel.value = fechas.includes(filtro) ? filtro : "";

  const visibles = pagos.filter((p) => !sel.value || p.datos?.fecha === sel.value || p.estado !== "listo");
  const validos = visibles.filter(cuenta);
  const total = validos.reduce((s, p) => s + p.valor, 0);
  const repetidos = visibles.filter((p) => p.repetido).length;
  const leyendo = pagos.filter((p) => p.estado === "leyendo").length;
  $("total-titulo").textContent = sel.value ? "Total del " + nombreFecha(sel.value) : "Total de transferencias";
  $("total").textContent = plata(total);
  $("total-detalle").textContent = !pagos.length ? "Todavía no hay comprobantes"
    : `${validos.length} ${validos.length === 1 ? "comprobante" : "comprobantes"}` + (repetidos ? ` · ${repetidos} repetido${repetidos > 1 ? "s" : ""} sin contar` : "") + (leyendo ? ` · leyendo ${leyendo}…` : "");
  $("btn-compartir").disabled = !validos.length;
  $("btn-borrar").hidden = !pagos.length;

  const ul = $("lista"); ul.innerHTML = "";
  if (!pagos.length) { ul.innerHTML = '<li class="vacio">Agrega las fotos o capturas de las transferencias y aquí te aparece la suma.</li>'; return; }
  // Primero los que se están leyendo o fallaron, luego por día (más reciente arriba)
  const sinFecha = visibles.filter((p) => p.estado !== "listo" || !p.datos?.fecha);
  sinFecha.forEach((p) => ul.appendChild(fila(p)));
  for (const f of fechas.filter((x) => !sel.value || x === sel.value)) {
    const delDia = visibles.filter((p) => p.estado === "listo" && p.datos?.fecha === f).sort((a, b) => (b.datos.hora || "").localeCompare(a.datos.hora || ""));
    const sub = delDia.filter(cuenta).reduce((s, p) => s + p.valor, 0);
    const li = document.createElement("li"); li.className = "dia";
    li.innerHTML = `<b></b><span></span>`; li.querySelector("b").textContent = nombreFecha(f); li.querySelector("span").textContent = plata(sub);
    ul.appendChild(li);
    delDia.forEach((p) => ul.appendChild(fila(p)));
  }
}
function nombreFecha(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(a, m - 1, d).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" });
}
function horaBonita(h) {
  if (!h) return "";
  const [hh, mm] = h.split(":").map(Number);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${hh >= 12 ? "p. m." : "a. m."}`;
}
const ICONO_EDITAR = '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICONO_BORRAR = '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
function fila(p) {
  const li = document.createElement("li");
  li.className = "pago" + (p.estado === "leyendo" ? " leyendo" : p.estado !== "listo" ? " fallo" : "") + (p.estado === "listo" && !cuenta(p) ? " excluido" : "");
  li.innerHTML = `<img alt="Comprobante" /><div><div class="valor"></div><div class="info"></div></div><div class="acciones"></div>`;
  const img = li.querySelector("img");
  if (p.mini) img.src = p.mini;
  img.addEventListener("click", () => verImagen(p));
  const d = p.datos || {};
  const valor = li.querySelector(".valor"), info = li.querySelector(".info");
  if (p.estado === "leyendo") valor.textContent = "Leyendo…";
  else if (p.estado === "pendiente") valor.textContent = "Falta el PIN";
  else if (p.estado === "fallo") valor.textContent = "No se pudo leer";
  else {
    valor.textContent = plata(p.valor);
    info.textContent = [d.banco, horaBonita(d.hora), d.referencia && "Ref. " + d.referencia, d.remitente && "De " + d.remitente].filter(Boolean).join(" · ");
    const marca = p.repetido ? ["repetido", "Repetido · no se suma"] : p.motivo ? ["revisar", p.motivo + " · no se suma"] : d.confianza !== "alta" ? ["revisar", "Revisa el valor"] : null;
    if (marca) { const s = document.createElement("span"); s.className = "etiqueta " + marca[0]; s.textContent = marca[1]; info.after(s); }
  }
  const acc = li.querySelector(".acciones");
  if (p.estado === "listo") {
    const ed = document.createElement("button"); ed.className = "icono"; ed.innerHTML = ICONO_EDITAR; ed.setAttribute("aria-label", "Corregir valor");
    ed.addEventListener("click", () => {
      const v = prompt("Valor correcto de este comprobante (solo números):", p.valor);
      if (v === null) return;
      const n = Number(String(v).replace(/[^\d]/g, ""));
      if (n > 0) { p.valor = n; if (p.motivo === "No se leyó el valor") p.datos.es_comprobante = true; guardar(); pintar(); toast("Valor corregido"); }
    });
    acc.appendChild(ed);
  } else if ((p.estado === "fallo" || p.estado === "pendiente") && p.vista) {
    const re = document.createElement("button"); re.className = "icono"; re.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>'; re.setAttribute("aria-label", "Intentar de nuevo");
    re.addEventListener("click", async () => { p.archivo = await (await fetch(p.vista)).blob(); p.estado = "leyendo"; cola.push(p); pintar(); procesar(); });
    acc.appendChild(re);
  }
  const bo = document.createElement("button"); bo.className = "icono borrar"; bo.innerHTML = ICONO_BORRAR; bo.setAttribute("aria-label", "Quitar este comprobante");
  bo.addEventListener("click", () => { if (!confirm("¿Quitar este comprobante de la suma?")) return; pagos = pagos.filter((x) => x !== p); guardar(); pintar(); });
  acc.appendChild(bo);
  return li;
}
function verImagen(p) {
  if (!p.vista && !p.mini) return;
  const v = document.createElement("div"); v.className = "visor";
  v.innerHTML = '<img alt="Comprobante" />'; v.querySelector("img").src = p.vista || p.mini;
  v.addEventListener("click", () => v.remove());
  document.body.appendChild(v);
}

$("filtro-fecha").addEventListener("change", pintar);
$("btn-borrar").addEventListener("click", () => {
  if (!confirm("¿Borrar TODOS los comprobantes de este celular? Esto no se puede deshacer.")) return;
  pagos = []; guardar(); pintar(); toast("Listo, empezamos de cero");
});
$("btn-compartir").addEventListener("click", async () => {
  const sel = $("filtro-fecha").value;
  const validos = pagos.filter((p) => cuenta(p) && (!sel || p.datos.fecha === sel));
  const porDia = {};
  validos.forEach((p) => { porDia[p.datos.fecha] = (porDia[p.datos.fecha] || 0) + p.valor; });
  const lineas = Object.keys(porDia).sort().map((f) => `• ${nombreFecha(f)}: ${plata(porDia[f])}`);
  const texto = `Transferencias Club F10${sel ? " (" + nombreFecha(sel) + ")" : ""}\n${lineas.join("\n")}\nTotal: ${plata(validos.reduce((s, p) => s + p.valor, 0))} en ${validos.length} comprobantes`;
  if (navigator.share) { try { await navigator.share({ text: texto }); return; } catch { /* cancelado */ } }
  location.href = "https://wa.me/?text=" + encodeURIComponent(texto);
});

// ---------- Instalar como app ----------
let avisoInstalar = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); avisoInstalar = e; $("btn-instalar").hidden = false; });
$("btn-instalar").addEventListener("click", async () => {
  if (!avisoInstalar) return;
  avisoInstalar.prompt(); await avisoInstalar.userChoice; avisoInstalar = null; $("btn-instalar").hidden = true;
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(console.error);

// Si se cerró la app mientras leía, esos quedan para reintentar
pagos.forEach((p) => { if (p.estado === "leyendo") p.estado = "fallo"; });
mostrar();
