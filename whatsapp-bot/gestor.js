// Gestor del bot de WhatsApp para VARIAS barberías.
//
// Cada barbería tiene su propia copia del bot (un proceso aparte con su propio WhatsApp, su propia
// sesión guardada y su propia memoria). Si una se cae, las demás siguen funcionando.
// La API habla solo con este gestor; el gestor reenvía cada petición a la copia de esa barbería.
//
//   GET  /api/status?slug=x        estado y QR de esa barbería
//   POST /api/vincular?slug=x      arranca su bot (para mostrar el QR)
//   POST /api/reset?slug=x         desvincula su WhatsApp y genera un QR nuevo
//   POST /api/desvincular?slug=x   desvincula y apaga su bot
//   POST /api/notificar-*, /api/enviar-codigo, /api/probar   (slug en ?slug= o en el cuerpo)
//
// Variables: BOT_API_KEY, BARBERFLOW_API_URL, DATABASE_URL (las mismas del bot),
// BOT_MAX_SESIONES (por defecto 3), BARBERIA_SLUG (barbería que siempre arranca, opcional).
import http from 'http';
import crypto from 'crypto';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUERTO = Number(process.env.BOT_PORT || process.env.PORT || 3001);
const PUERTO_BASE_HIJOS = Number(process.env.BOT_PUERTO_HIJOS || 3101);
const MAX_SESIONES = Math.max(1, Number(process.env.BOT_MAX_SESIONES || 3));
const API_BASE_URL = process.env.BARBERFLOW_API_URL || 'https://barberflow-aos9.onrender.com/api/public';
const BOT_API_KEY = process.env.BOT_API_KEY || '';
const MEMORIA_HIJO_MB = Number(process.env.BOT_MEMORIA_HIJO_MB || 160);
// Un bot que muestra QR y nadie lo mira ni lo escanea se apaga para no gastar memoria
const MINUTOS_QR_SIN_USO = 6;

const SLUG_VALIDO = /^[a-z0-9][a-z0-9-]{0,79}$/;
const hijos = new Map(); // slug -> { proceso, puerto, inicio, ultimaConsulta, detenido, caidas: [] }
const puertosEnUso = new Set(); // puertos de procesos que todavía no han salido

function log(...a) { console.log('[Gestor]', ...a); }

function puertoLibre() {
  const usados = new Set([...hijos.values()].map(h => h.puerto).concat([...puertosEnUso]));
  for (let p = PUERTO_BASE_HIJOS; p < PUERTO_BASE_HIJOS + 200; p++) if (!usados.has(p)) return p;
  throw new Error('Sin puertos libres');
}

function arrancarHijo(slug, puerto = puertoLibre()) {
  const proceso = fork(path.join(DIR, 'bot.js'), [], {
    cwd: DIR,
    execArgv: [`--max-old-space-size=${MEMORIA_HIJO_MB}`],
    env: { ...process.env, BOT_HIJO: '1', BARBERIA_SLUG: slug, PORT: String(puerto), BOT_PORT: String(puerto) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  puertosEnUso.add(puerto);
  const anterior = hijos.get(slug);
  const hijo = { proceso, puerto, inicio: Date.now(), ultimaConsulta: Date.now(), detenido: false, caidas: anterior?.caidas || [] };
  hijos.set(slug, hijo);
  const prefijo = `[${slug}]`;
  proceso.stdout.on('data', d => process.stdout.write(String(d).split('\n').filter(Boolean).map(l => `${prefijo} ${l}`).join('\n') + '\n'));
  proceso.stderr.on('data', d => process.stderr.write(String(d).split('\n').filter(Boolean).map(l => `${prefijo} ${l}`).join('\n') + '\n'));
  proceso.on('exit', (codigo, senal) => {
    puertosEnUso.delete(puerto);
    if (hijos.get(slug) !== hijo) return;
    if (hijo.detenido) { hijos.delete(slug); return; }
    // Se cayó solo: se vuelve a encender (más despacio si se cae seguido)
    const ahora = Date.now();
    hijo.caidas = hijo.caidas.filter(t => ahora - t < 10 * 60 * 1000).concat(ahora);
    const espera = hijo.caidas.length > 5 ? 60000 : 5000;
    log(`El bot de ${slug} se detuvo (código ${codigo ?? senal}). Se reinicia en ${espera / 1000} s.`);
    setTimeout(() => { if (hijos.get(slug) === hijo && !hijo.detenido) arrancarHijo(slug, puerto); }, espera);
  });
  log(`Bot de ${slug} encendido en el puerto interno ${puerto}.`);
  return hijo;
}

function detenerHijo(slug) {
  const h = hijos.get(slug);
  if (!h) return;
  h.detenido = true;
  try { h.proceso.kill('SIGTERM'); } catch (e) { /* ya estaba detenido */ }
  setTimeout(() => { try { h.proceso.kill('SIGKILL'); } catch (e) { /* ok */ } }, 5000);
  hijos.delete(slug);
  log(`Bot de ${slug} apagado.`);
}

// Espera a que la copia del bot responda (tarda unos segundos en cargar)
async function esperarListo(h, ms = 20000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    try {
      const r = await fetch(`http://127.0.0.1:${h.puerto}/`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch (e) { /* todavía cargando */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function asegurarHijo(slug) {
  let h = hijos.get(slug);
  if (!h) {
    if (hijos.size >= MAX_SESIONES) return { error: 'lleno' };
    h = arrancarHijo(slug);
  }
  h.ultimaConsulta = Date.now();
  return (await esperarListo(h)) ? { hijo: h } : { error: 'no-responde' };
}

async function reenviar(h, metodo, ruta, cuerpo) {
  const r = await fetch(`http://127.0.0.1:${h.puerto}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'X-Bot-Key': BOT_API_KEY },
    body: metodo === 'GET' ? undefined : (cuerpo || '{}'),
    signal: AbortSignal.timeout(25000)
  });
  return { status: r.status, texto: await r.text() };
}

// ---------- Servidor HTTP ----------

function autorizado(req) {
  if (!BOT_API_KEY) return false;
  const recibida = Buffer.from(String(req.headers['x-bot-key'] || ''));
  const esperada = Buffer.from(BOT_API_KEY);
  return recibida.length === esperada.length && crypto.timingSafeEqual(recibida, esperada);
}

function responder(res, status, datos) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(datos));
}

const leerCuerpo = req => new Promise(resolve => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => resolve(b));
});

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://gestor');
  const ruta = url.pathname;

  if (!ruta.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`BarberFlow bot activo. Barberías con bot encendido: ${hijos.size}.`);
    return;
  }
  if (!autorizado(req)) return responder(res, 401, { error: 'No autorizado' });

  try {
    const cuerpo = req.method === 'POST' ? await leerCuerpo(req) : '';
    let datos = {};
    try { datos = cuerpo ? JSON.parse(cuerpo) : {}; } catch (e) { /* cuerpo vacío o inválido */ }
    const slug = String(url.searchParams.get('slug') || datos.barberiaSlug || datos.slug || '').toLowerCase().trim();
    if (!SLUG_VALIDO.test(slug)) return responder(res, 400, { error: 'Falta la barbería (slug).' });

    // Estado / QR
    if (ruta === '/api/status') {
      const h = hijos.get(slug);
      if (!h) return responder(res, 200, { barberiaSlug: slug, conectado: false, estado: 'Sin vincular', qr: '', sinSesion: true });
      h.ultimaConsulta = Date.now();
      try {
        const r = await reenviar(h, 'GET', '/api/status');
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        return res.end(r.texto);
      } catch (e) {
        return responder(res, 200, { barberiaSlug: slug, conectado: false, estado: 'Encendiendo el bot...', qr: '' });
      }
    }

    if (ruta === '/api/vincular') {
      const r = await asegurarHijo(slug);
      if (r.error === 'lleno') return responder(res, 409, { error: `El servicio de WhatsApp ya atiende el máximo de ${MAX_SESIONES} barberías.` });
      return responder(res, 200, { ok: true, estado: r.error ? 'Encendiendo el bot...' : 'Preparando el código QR...' });
    }

    if (ruta === '/api/desvincular') {
      const h = hijos.get(slug) || (await asegurarHijo(slug)).hijo;
      const ok = h ? await reenviar(h, 'POST', '/api/reset').then(r => r.status < 300).catch(() => false) : false;
      detenerHijo(slug);
      return ok ? responder(res, 200, { ok: true }) : responder(res, 503, { error: 'No se pudo desvincular ahora. Intenta en un minuto.' });
    }

    if (ruta === '/api/reset' || ruta === '/api/probar') {
      const r = await asegurarHijo(slug);
      if (r.error === 'lleno') return responder(res, 409, { error: `El servicio de WhatsApp ya atiende el máximo de ${MAX_SESIONES} barberías.` });
      if (r.error) return responder(res, 503, { error: 'El bot de esa barbería está encendiendo. Intenta en unos segundos.' });
      const fw = await reenviar(r.hijo, 'POST', ruta, cuerpo);
      res.writeHead(fw.status, { 'Content-Type': 'application/json' });
      return res.end(fw.texto);
    }

    // Avisos (cita nueva, cancelación, imprevisto, cambio de hora, código): solo si esa barbería tiene su bot encendido
    if (req.method === 'POST' && (ruta.startsWith('/api/notificar-') || ruta === '/api/enviar-codigo')) {
      const h = hijos.get(slug);
      if (!h) return responder(res, 200, { enviado: false, razon: 'Esa barbería no tiene el bot de WhatsApp vinculado' });
      try {
        const fw = await reenviar(h, 'POST', ruta, cuerpo);
        res.writeHead(fw.status, { 'Content-Type': 'application/json' });
        return res.end(fw.texto);
      } catch (e) {
        return responder(res, 200, { enviado: false, razon: 'El bot de esa barbería se está reiniciando' });
      }
    }

    return responder(res, 404, { error: 'Ruta desconocida' });
  } catch (err) {
    console.error('[Gestor] Error:', err.message);
    return responder(res, 500, { error: err.message });
  }
});

// ---------- Al arrancar: encender los bots de las barberías que ya lo tienen vinculado ----------

async function cargarBarberiasConBot() {
  const slugs = new Set();
  if (process.env.BARBERIA_SLUG) slugs.add(process.env.BARBERIA_SLUG.toLowerCase());
  for (let intento = 1; intento <= 20; intento++) {
    try {
      const r = await fetch(`${API_BASE_URL}/bot/barberias`, { headers: { 'X-Bot-Key': BOT_API_KEY }, signal: AbortSignal.timeout(60000) });
      if (r.ok) {
        ((await r.json()).slugs || []).forEach(s => slugs.add(String(s).toLowerCase()));
        break;
      }
      log(`La API respondió ${r.status} al pedir las barberías con bot.`);
    } catch (e) {
      log(`No se pudo consultar la API (intento ${intento}): ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 30000));
  }
  for (const slug of slugs) {
    if (!SLUG_VALIDO.test(slug) || hijos.has(slug)) continue;
    if (hijos.size >= MAX_SESIONES) { log(`Máximo de ${MAX_SESIONES} bots: ${slug} no se enciende.`); continue; }
    arrancarHijo(slug);
  }
}

// Apaga los bots que llevan rato mostrando un QR que nadie mira (nunca se vincularon)
setInterval(async () => {
  for (const [slug, h] of hijos) {
    if (Date.now() - h.ultimaConsulta < MINUTOS_QR_SIN_USO * 60000 || Date.now() - h.inicio < MINUTOS_QR_SIN_USO * 60000) continue;
    try {
      const estado = JSON.parse((await reenviar(h, 'GET', '/api/status')).texto);
      if (!estado.conectado && estado.qr) {
        log(`El bot de ${slug} no se vinculó; se apaga hasta que lo vuelvan a abrir.`);
        detenerHijo(slug);
      }
    } catch (e) { /* si no responde, el reinicio automático se encarga */ }
  }
}, 60000);

for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => {
    for (const slug of [...hijos.keys()]) detenerHijo(slug);
    setTimeout(() => process.exit(0), 500);
  });
}

if (!BOT_API_KEY) log('⚠️ Falta BOT_API_KEY: ninguna petición será aceptada.');
// BOT_HOST=127.0.0.1 cuando corre dentro del servicio de la página: así Render no lo confunde con la página
servidor.listen(PUERTO, process.env.BOT_HOST || '0.0.0.0', () => {
  log(`Gestor de bots activo en el puerto ${PUERTO} (máximo ${MAX_SESIONES} barberías).`);
  cargarBarberiasConBot();
});
