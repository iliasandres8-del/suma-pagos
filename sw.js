// Guarda la app en el celular para que abra rápido y funcione como aplicación instalada.
// Archivos propios: primero internet (para tener siempre lo último) y si no hay, lo guardado.
const CACHE = "suma-pagos-v4";
const ARCHIVOS = ["./", "index.html", "estilos.css", "app.js", "manifest.json", "iconos/icono-192.png", "iconos/icono-512.png", "iconos/favicon-32.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Firebase y fuentes van directo
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
