// Suma de pagos: lee fotos o capturas de comprobantes de transferencia con IA y suma por día.
// Los comprobantes se guardan en Firebase (proyecto del club) para verlos desde cualquier celular.
// La lectura la hace la función "leer-comprobante" de Supabase, que pide el PIN.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, query, where, onSnapshot, doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// App con nombre propio para que su sesión no se mezcle con la app de reservas (mismo dominio)
const fb = initializeApp({
  apiKey: "AIzaSyDSGcVPLr2S5CQhI8Lm8UVBAYoUD3fB-Bg",
  authDomain: "reservas-club-f10.firebaseapp.com",
  projectId: "reservas-club-f10",
  storageBucket: "reservas-club-f10.firebasestorage.app",
  messagingSenderId: "836276193806",
  appId: "1:836276193806:web:3c6ddbc11c3b9f90418a5f",
}, "suma-pagos");
const auth = getAuth(fb);
const db = getFirestore(fb);
const CORREO_APP = "pagos@club-f10.app";
const claveDe = (pin) => `Suma-${pin}-F10`;
const URL_LECTOR = "https://qzszwuiehdjndzqfbvsw.supabase.co/functions/v1/leer-comprobante";
const DIAS_HISTORIAL = 120;

const $ = (id) => document.getElementById(id);
const plata = (n) => "$" + Math.round(n || 0).toLocaleString("es-CO");
const leerLocal = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const escribirLocal = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin espacio */ } };

let pin = leerLocal("pin");
let dia = hoyISO();
const nube = new Map();      // comprobantes guardados en Firebase (id -> datos)
let locales = [];            // los que se están leyendo, fallaron o no se suman (solo en este celular)
const vistas = new Map();    // fotos grandes de esta sesión (id -> dataURL)
let cancelarEscucha = null, nubeLista = false;

// ---------- Fechas ----------
function hoyISO() { const d = new Date(); return aISO(d); }
function aISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function aFecha(iso) { const [a, m, d] = iso.split("-").map(Number); return new Date(a, m - 1, d); }
function sumarDias(iso, n) { const f = aFecha(iso); f.setDate(f.getDate() + n); return aISO(f); }
const nombreFecha = (iso) => aFecha(iso).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" });
function etiquetaDia(iso) {
  if (iso === hoyISO()) return "hoy";
  if (iso === sumarDias(hoyISO(), -1)) return "ayer";
  return nombreFecha(iso);
}
function horaBonita(h) {
  if (!h || !/^\d{1,2}:\d{2}/.test(h)) return "";
  const [hh, mm] = h.split(":").map(Number);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${hh >= 12 ? "p. m." : "a. m."}`;
}
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("ver");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("ver"), 3000);
}

// ---------- Entrada con PIN ----------
onAuthStateChanged(auth, (u) => {
  const dentro = !!u && !!pin;
  $("pantalla-pin").hidden = dentro;
  $("app").hidden = !dentro;
  if (dentro) { escucharNube(); irA(dia); }
  else if (cancelarEscucha) { cancelarEscucha(); cancelarEscucha = null; }
});
$("form-pin").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = $("pin").value.trim();
  $("pin-error").textContent = ""; $("btn-pin").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, CORREO_APP, claveDe(p));
    pin = p; escribirLocal("pin", p);
    $("pantalla-pin").hidden = true; $("app").hidden = false;
    escucharNube(); irA(dia);
  } catch (err) {
    $("pin-error").textContent = /network/i.test(err.code || "") ? "Sin conexión. Intenta de nuevo." : "PIN incorrecto.";
  } finally { $("btn-pin").disabled = false; }
});

// ---------- Nube ----------
function escucharNube() {
  if (cancelarEscucha) return;
  const desde = sumarDias(hoyISO(), -DIAS_HISTORIAL);
  cancelarEscucha = onSnapshot(query(collection(db, "pagos"), where("fecha", ">=", desde)), (snap) => {
    nube.clear();
    snap.docs.forEach((d) => nube.set(d.id, { id: d.id, ...d.data() }));
    if (!nubeLista) { nubeLista = true; migrarViejos(); }
    $("estado-nube").textContent = "☁️ Guardado en la nube · se ve igual en todos los celulares";
    pintar();
  }, (err) => {
    console.error(err);
    $("estado-nube").textContent = "No pude conectar con la nube. Revisa el internet.";
  });
}
// Llave única por comprobante: misma referencia o la misma imagen exacta = repetido, no se suma dos veces
function llave(d, valor, huella) {
  const n = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return n(d.referencia).length >= 5 ? `R_${n(d.referencia)}_${valor}`.slice(0, 140) : `H_${huella}`;
}
async function huellaDe(datos) {
  const bytes = typeof datos === "string" ? new TextEncoder().encode(datos) : await datos.arrayBuffer();
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...h.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function motivoNoSuma(d, valor) {
  if (!d.es_comprobante) return "No parece un comprobante";
  if (d.estado === "fallido") return "Transferencia fallida";
  if (!valor) return "No se leyó el valor";
  return "";
}
// Se suma en el día en que se mandó la foto (el día que estaba abierto en la app), no en la fecha del comprobante
async function guardarEnNube(item) {
  const d = item.datos;
  if (!item.huella) item.huella = await huellaDe(item.mini || JSON.stringify(d));
  // Solo se revisan repetidos dentro del mismo día; con "Sumar igual" se guarda aunque parezca repetido
  const fecha = item.dia || hoyISO();
  const id = item.forzar ? `${fecha}_X_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : `${fecha}_${llave(d, item.valor, item.huella)}`;
  if (!item.forzar && (nube.has(id) || (await getDoc(doc(db, "pagos", id))).exists())) { item.estado = "repetido"; return; }
  await setDoc(doc(db, "pagos", id), {
    valor: item.valor, fecha, fecha_comprobante: d.fecha || "", hora: d.hora || "", banco: d.banco || "", referencia: d.referencia || "",
    remitente: d.remitente || "", destinatario: d.destinatario || "", confianza: d.confianza || "",
    mini: item.mini || "", creado: serverTimestamp(),
  });
  if (item.vista) vistas.set(id, item.vista);
  locales = locales.filter((x) => x !== item);
}
// Los comprobantes que se habían subido antes (solo en este celular) pasan a la nube una sola vez
async function migrarViejos() {
  let viejos = [];
  try { viejos = JSON.parse(leerLocal("pagos") || "[]"); } catch { /* nada */ }
  if (!viejos.length) return;
  let subidos = 0;
  for (const p of viejos) {
    if (p.estado !== "listo" || !p.datos || motivoNoSuma(p.datos, p.valor)) continue;
    try { const item = { ...p, estado: "listo" }; await guardarEnNube(item); if (item.estado !== "repetido") subidos++; } catch (e) { console.error(e); }
  }
  escribirLocal("pagos_antes_de_la_nube", leerLocal("pagos"));
  escribirLocal("pagos", null);
  if (subidos) toast(`Subí a la nube ${subidos} comprobantes que tenías en este celular`);
}

// ---------- Leer imágenes ----------
async function reducir(archivo, lado, calidad) {
  const bmp = await createImageBitmap(archivo);
  const escala = Math.min(1, lado / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * escala); c.height = Math.round(bmp.height * escala);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL("image/jpeg", calidad);
}
async function leer(item) {
  const imagen = (await reducir(item.archivo, 1600, 0.85)).split(",")[1];
  for (let intento = 0; intento < 4; intento++) {
    let r;
    try { r = await fetch(URL_LECTOR, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin, imagen, tipo: "image/jpeg" }) }); }
    catch { await new Promise((ok) => setTimeout(ok, 3000 * (intento + 1))); continue; }
    if (r.ok) return (await r.json()).datos;
    if (r.status === 401) throw new Error("PIN");
    await new Promise((ok) => setTimeout(ok, 4000 * (intento + 1))); // lector ocupado: espera y reintenta
  }
  throw new Error("No se pudo leer");
}
const cola = []; let trabajando = 0;
function procesar() {
  while (trabajando < 2 && cola.length) {
    const item = cola.shift(); trabajando++;
    leer(item)
      .then(async (datos) => {
        item.datos = datos; item.valor = Math.round(datos.valor || 0);
        item.motivo = motivoNoSuma(datos, item.valor);
        if (item.motivo) { item.estado = "revisar"; return; }
        await guardarEnNube(item);
      })
      .catch((e) => { item.estado = "fallo"; item.error = e.message; if (e.message === "PIN") { pin = null; escribirLocal("pin", null); signOut(auth); toast("El PIN cambió: entra con el nuevo"); } })
      .finally(() => { trabajando--; pintar(); procesar(); });
  }
}
$("archivos").addEventListener("change", (e) => { const a = [...e.target.files]; e.target.value = ""; agregar(a); });
// En el PC: copiar la imagen en WhatsApp (clic derecho > Copiar) y pegarla aquí con Ctrl+V, o arrastrarla a la app
document.addEventListener("paste", (e) => {
  const a = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (a.length && !$("app").hidden) { e.preventDefault(); agregar(a); }
});
document.addEventListener("dragover", (e) => { if (!$("app").hidden) e.preventDefault(); });
document.addEventListener("drop", (e) => {
  const a = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!$("app").hidden) { e.preventDefault(); if (a.length) agregar(a); }
});
async function agregar(archivos) {
  for (const archivo of archivos) {
    const item = { id: "local-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), estado: "leyendo", archivo, dia };
    try { item.huella = await huellaDe(archivo); item.mini = await reducir(archivo, 140, 0.6); item.vista = await reducir(archivo, 900, 0.75); }
    catch { item.estado = "fallo"; }
    locales.push(item);
    if (item.estado === "leyendo") cola.push(item);
  }
  pintar(); procesar();
  if (archivos.length) toast(archivos.length === 1 ? "Leyendo el comprobante…" : `Leyendo ${archivos.length} comprobantes…`);
}

// ---------- Pantalla ----------
function irA(iso) { dia = iso; $("fecha-input").value = iso; pintar(); }
$("dia-anterior").addEventListener("click", () => irA(sumarDias(dia, -1)));
$("dia-siguiente").addEventListener("click", () => irA(sumarDias(dia, 1)));
$("fecha-input").addEventListener("change", (e) => e.target.value && irA(e.target.value));

function totalesPorDia() {
  const t = {};
  for (const p of nube.values()) { (t[p.fecha] ||= { total: 0, n: 0 }); t[p.fecha].total += p.valor; t[p.fecha].n++; }
  return t;
}
function pintar() {
  const nombre = etiquetaDia(dia);
  $("fecha-texto").textContent = nombre === "hoy" ? "Hoy, " + nombreFecha(dia) : nombre === "ayer" ? "Ayer, " + nombreFecha(dia) : nombre;
  const delDia = [...nube.values()].filter((p) => p.fecha === dia).sort((a, b) => (b.hora || "").localeCompare(a.hora || ""));
  const total = delDia.reduce((s, p) => s + p.valor, 0);
  $("total-titulo").textContent = "Total " + (nombre === "hoy" || nombre === "ayer" ? "de " + nombre : "del " + nombre);
  $("total").textContent = plata(total);
  const pendientes = locales.filter((x) => x.estado === "leyendo").length;
  $("total-detalle").textContent = (delDia.length ? `${delDia.length} ${delDia.length === 1 ? "comprobante" : "comprobantes"}` : "Sin comprobantes este día") + (pendientes ? ` · leyendo ${pendientes}…` : "");

  const ul = $("lista"); ul.innerHTML = "";
  // Arriba lo que pasa en este celular (leyendo, fallidos, repetidos, por revisar)
  for (const item of locales) if ((item.dia || dia) === dia) ul.appendChild(filaLocal(item));
  delDia.forEach((p) => ul.appendChild(filaNube(p)));

  // Totales por día
  const t = totalesPorDia(), dias = Object.keys(t).sort().reverse();
  const ud = $("lista-dias"); ud.innerHTML = "";
  if (!dias.length) ud.innerHTML = '<li class="vacio">Aquí vas a ver el total de cada día.</li>';
  for (const f of dias) {
    const li = document.createElement("li");
    if (f === dia) li.classList.add("activo");
    li.innerHTML = '<span class="d-nombre"><span></span><small></small></span><span class="d-total"></span>';
    li.querySelector(".d-nombre span").textContent = etiquetaDia(f) === "hoy" ? "Hoy" : etiquetaDia(f) === "ayer" ? "Ayer" : nombreFecha(f);
    li.querySelector(".d-nombre small").textContent = `${t[f].n} ${t[f].n === 1 ? "comprobante" : "comprobantes"}`;
    li.querySelector(".d-total").textContent = plata(t[f].total);
    li.addEventListener("click", () => { irA(f); window.scrollTo({ top: 0, behavior: "smooth" }); });
    ud.appendChild(li);
  }
  $("btn-compartir").disabled = !dias.length;
}

const ICONO_EDITAR = '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICONO_BORRAR = '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
const ICONO_REINTENTAR = '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';
function boton(icono, etiqueta, clase, accion) {
  const b = document.createElement("button"); b.className = "icono" + (clase ? " " + clase : "");
  b.innerHTML = icono; b.setAttribute("aria-label", etiqueta); b.addEventListener("click", accion); return b;
}
function armarFila(clase, mini, vista, valorTexto, info, etiqueta) {
  const li = document.createElement("li");
  li.className = "pago" + (clase ? " " + clase : "");
  li.innerHTML = `<img alt="Comprobante" /><div><div class="valor"></div><div class="info"></div></div><div class="acciones"></div>`;
  const img = li.querySelector("img");
  if (mini) img.src = mini;
  img.addEventListener("click", () => verImagen(vista || mini));
  li.querySelector(".valor").textContent = valorTexto;
  li.querySelector(".info").textContent = info;
  if (etiqueta) { const s = document.createElement("span"); s.className = "etiqueta " + etiqueta[0]; s.textContent = etiqueta[1]; li.querySelector(".info").after(s); }
  return li;
}
const infoDe = (d) => [d.banco, horaBonita(d.hora), d.referencia && "Ref. " + d.referencia, d.remitente && "De " + d.remitente].filter(Boolean).join(" · ");

function filaNube(p) {
  const li = armarFila("", p.mini, vistas.get(p.id), plata(p.valor), infoDe(p), p.confianza && p.confianza !== "alta" ? ["revisar", "Revisa el valor"] : null);
  const acc = li.querySelector(".acciones");
  acc.appendChild(boton(ICONO_EDITAR, "Corregir valor", "", async () => {
    const v = prompt("Valor correcto de este comprobante (solo números):", p.valor);
    if (v === null) return;
    const n = Number(String(v).replace(/[^\d]/g, ""));
    if (!(n > 0)) return;
    try { await updateDoc(doc(db, "pagos", p.id), { valor: n, confianza: "alta" }); toast("Valor corregido"); }
    catch (e) { console.error(e); toast("No se pudo corregir. Revisa el internet."); }
  }));
  acc.appendChild(boton(ICONO_BORRAR, "Quitar este comprobante", "borrar", async () => {
    if (!confirm(`¿Quitar este comprobante de ${plata(p.valor)} de la suma? Se borra en todos los celulares.`)) return;
    try { await deleteDoc(doc(db, "pagos", p.id)); toast("Comprobante quitado"); }
    catch (e) { console.error(e); toast("No se pudo quitar. Revisa el internet."); }
  }));
  return li;
}
function filaLocal(item) {
  const d = item.datos || {};
  let texto = "", etiqueta = null, clase = "";
  if (item.estado === "leyendo") { texto = "Leyendo…"; clase = "leyendo"; }
  else if (item.estado === "fallo") { texto = item.error === "PIN" ? "El PIN cambió" : "No se pudo leer"; clase = "fallo"; }
  else if (item.estado === "repetido") { texto = plata(item.valor); clase = "excluido"; etiqueta = ["repetido", "Parece que ya lo mandaste hoy · si no es así, dale a Sumar igual"]; }
  else if (item.estado === "revisar") { texto = item.valor ? plata(item.valor) : "Sin valor"; clase = "excluido"; etiqueta = ["revisar", item.motivo + " · no se suma"]; }
  const li = armarFila(clase, item.mini, item.vista, texto, infoDe(d), etiqueta);
  const acc = li.querySelector(".acciones");
  if (item.estado === "revisar" && item.motivo !== "Transferencia fallida") {
    acc.appendChild(boton(ICONO_EDITAR, "Corregir y guardar", "", async () => {
      const v = prompt("Valor de este comprobante (solo números):", item.valor || "");
      if (v === null) return;
      const n = Number(String(v).replace(/[^\d]/g, ""));
      if (!(n > 0)) return;
      item.valor = n; item.datos = { ...d, es_comprobante: true, estado: "exitoso", confianza: "alta" };
      try { await guardarEnNube(item); pintar(); toast(item.estado === "repetido" ? "Ese comprobante ya estaba guardado" : "Guardado y sumado"); }
      catch (e) { console.error(e); toast("No se pudo guardar. Revisa el internet."); }
    }));
  }
  if (item.estado === "repetido") {
    const b = document.createElement("button"); b.className = "btn btn-suave"; b.textContent = "Sumar igual";
    b.addEventListener("click", async () => {
      item.forzar = true; b.disabled = true;
      try { await guardarEnNube(item); pintar(); toast("Sumado"); }
      catch (e) { console.error(e); b.disabled = false; toast("No se pudo guardar. Revisa el internet."); }
    });
    acc.appendChild(b);
  }
  if (item.estado === "fallo" && item.vista) {
    acc.appendChild(boton(ICONO_REINTENTAR, "Intentar de nuevo", "", async () => {
      item.archivo = await (await fetch(item.vista)).blob(); item.estado = "leyendo"; cola.push(item); pintar(); procesar();
    }));
  }
  if (item.estado !== "leyendo") acc.appendChild(boton(ICONO_BORRAR, "Quitar de la lista", "borrar", () => { locales = locales.filter((x) => x !== item); pintar(); }));
  return li;
}
function verImagen(src) {
  if (!src) return;
  const v = document.createElement("div"); v.className = "visor";
  v.innerHTML = '<img alt="Comprobante" />'; v.querySelector("img").src = src;
  v.addEventListener("click", () => v.remove());
  document.body.appendChild(v);
}

$("btn-compartir").addEventListener("click", async () => {
  const t = totalesPorDia(), dias = Object.keys(t).sort().reverse().slice(0, 14);
  const texto = `Transferencias Club F10\n${dias.map((f) => `• ${etiquetaDia(f) === "hoy" ? "Hoy" : etiquetaDia(f) === "ayer" ? "Ayer" : nombreFecha(f)}: ${plata(t[f].total)} (${t[f].n})`).join("\n")}`;
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
