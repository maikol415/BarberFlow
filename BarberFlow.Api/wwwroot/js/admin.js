// Lógica del Panel de Administración del Barbero
const token = localStorage.getItem('bf_token');
let barberiaActual = null;
let todasLasCitas = [];
let subTabActual = 'activas';
let filtroPeriodoActual = 'todos';

const DEFAULT_AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2364748B'><circle cx='12' cy='8' r='4'/><path d='M4 20c0-4 4-6 8-6s8 2 8 6'/></svg>";

if (!token) {
  window.location.href = '/login.html';
}

function getAuthHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
}

// Escapa texto antes de insertarlo como HTML (nombres, comentarios, etc. escritos por clientes)
function escapeHtml(valor) {
  return String(valor ?? "").replace(/[&<>"'`]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;", "`": "&#96;" }[ch]));
}

async function initAdmin() {
  const hoyStr = hoyBogotaIso(); // fecha de Colombia (toISOString daba el día siguiente después de las 7 p. m.)
  const inputFechaBloq = document.getElementById('bloq-fecha');
  if (inputFechaBloq) inputFechaBloq.value = hoyStr;

  await cargarPerfil();
  await cargarCitas();
  lucide.createIcons();
}

async function cargarPerfil() {
  try {
    const res = await fetch('/api/admin/perfil', { headers: getAuthHeaders() });
    if (res.status === 401) {
      cerrarSesion();
      return;
    }
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.error('Error del servidor cargando perfil:', errData);
      document.getElementById('admin-barberia-nombre').innerText = 'Error al cargar perfil';
      return;
    }
    barberiaActual = await res.json();

    document.getElementById('admin-barberia-nombre').innerText = barberiaActual.nombre;
    const linkPublico = `/index.html?b=${barberiaActual.slug}`;
    const btnVer = document.getElementById('btn-ver-publica');
    btnVer.href = linkPublico;

    const logoSrc = barberiaActual.logoUrl || DEFAULT_AVATAR;
    document.getElementById('admin-barberia-logo').src = logoSrc;
    document.getElementById('preview-logo-barberia').src = logoSrc;
    document.getElementById('conf-logo').value = barberiaActual.logoUrl || '';

    // Datos generales
    document.getElementById('conf-nombre').value = barberiaActual.nombre || '';
    document.getElementById('conf-phone').value = barberiaActual.telefonoWhatsApp || '';
    document.getElementById('conf-dir').value = barberiaActual.direccion || '';
    document.getElementById('conf-horario').value = barberiaActual.horarioTexto || '';
    document.getElementById('conf-desc').value = barberiaActual.descripcion || '';
    pintarApariencia();
    document.getElementById('conf-mostrar-barberos').checked = barberiaActual.mostrarSelectorBarbero || false;

    // Horario por día (y por barbero) y reglas de reserva
    pintarEditorHorario();
    pintarReglasReserva();

    renderListaServicios(barberiaActual.servicios || []);
    renderListaMiembros(barberiaActual.miembros || []);
    renderListaBloqueos(barberiaActual.bloqueos || []);

    // Cargar datos de Bot de WhatsApp
    const chkBot = document.getElementById('conf-bot-activo');
    if (chkBot) {
      chkBot.checked = barberiaActual.botActivo !== false;
      chkBot.onchange = () => cambiarEstadoBot(chkBot);
    }

    const txtBienvenida = document.getElementById('conf-bot-bienvenida');
    if (txtBienvenida) txtBienvenida.value = barberiaActual.mensajeBienvenidaBot || '¡Hola! 💈 Bienvenido a {barberia}. ¿En qué podemos ayudarte hoy?\n\n1️⃣ Agendar una cita\n2️⃣ Ver precios y servicios\n3️⃣ Horarios y ubicación';

    const txtDerivacion = document.getElementById('conf-bot-derivacion');
    if (txtDerivacion) txtDerivacion.value = barberiaActual.mensajeDerivacionHumana || 'He recibido tu mensaje. En este momento el barbero está en servicio con un cliente ✂️💈. Tan pronto termine su turno, te responderá personalmente por este chat. ¡Muchas gracias por tu paciencia!';

    const txtConfirmacion = document.getElementById('conf-bot-confirmacion');
    if (txtConfirmacion) txtConfirmacion.value = barberiaActual.plantillaConfirmacion ||
      `¡Hola {cliente}! 👋 Tu cita en *{barberia}* quedó agendada.\n\n` +
      `✂️ *Servicio:* {servicio}\n` +
      `📅 *Fecha:* {fecha}\n` +
      `⏰ *Hora:* {hora}\n` +
      `🔖 *Código:* {codigo}\n` +
      `📍 *Dirección:* {direccion}\n\n` +
      `👉 Responde *SI* para confirmar tu asistencia.\n` +
      `Si no puedes venir, responde *CANCELAR* o *REAGENDAR*.`;

    const txtRecordatorio = document.getElementById('conf-bot-recordatorio');
    if (txtRecordatorio) txtRecordatorio.value = barberiaActual.plantillaRecordatorio ||
      `⏰ ¡Hola {cliente}! Te recordamos tu cita de hoy en *{barberia}*:\n\n` +
      `✂️ *Servicio:* {servicio}\n` +
      `🕒 *Hora:* {hora}\n` +
      `📍 *Dirección:* {direccion}\n\n` +
      `Por favor llega 5 minutos antes. Si no puedes asistir, responde *CANCELAR* o *REAGENDAR*.`;

    // Horarios de Anuncio Matutino
    const chkRecordatorios = document.getElementById('conf-recordatorios-activos');
    if (chkRecordatorios) {
      chkRecordatorios.checked = barberiaActual.recordatoriosActivos !== false;
      const elegidas = String(barberiaActual.horasRecordatorios || barberiaActual.horasRecordatorio || '24,2').split(',');
      document.querySelectorAll('input[name="horas-recordatorio"]').forEach(c => { c.checked = elegidas.includes(c.value); });
      const alternarHoras = () => document.getElementById('fila-horas-recordatorio').classList.toggle('opacity-40', !chkRecordatorios.checked);
      chkRecordatorios.onchange = alternarHoras;
      alternarHoras();
    }
    const selPausa = document.getElementById('conf-pausa-bot');
    if (selPausa) selPausa.value = String(barberiaActual.minutosPausaBot || 120);
    const chkOpinion = document.getElementById('conf-pedir-opinion');
    if (chkOpinion) chkOpinion.checked = barberiaActual.pedirOpinionActivo !== false;
    const chkAnuncio = document.getElementById('conf-anuncio-activo');
    if (chkAnuncio) chkAnuncio.checked = barberiaActual.anuncioMatutinoActivo !== false;
    const inpSemana = document.getElementById('conf-anuncio-semana');
    if (inpSemana) inpSemana.value = barberiaActual.horaAnuncioSemana || '08:00';
    const inpSabado = document.getElementById('conf-anuncio-sabado');
    if (inpSabado) inpSabado.value = barberiaActual.horaAnuncioSabado || '08:00';
    const inpDomingo = document.getElementById('conf-anuncio-domingo');
    if (inpDomingo) inpDomingo.value = barberiaActual.horaAnuncioDomingo || '09:00';

    // Campos de Métodos de Pago
    const inputNequi = document.getElementById('conf-bot-nequi');
    if (inputNequi) inputNequi.value = barberiaActual.numeroNequi || '';
    const inputDaviplata = document.getElementById('conf-bot-daviplata');
    if (inputDaviplata) inputDaviplata.value = barberiaActual.numeroDaviplata || '';
    const inputTitular = document.getElementById('conf-bot-titular');
    if (inputTitular) inputTitular.value = barberiaActual.titularCuenta || '';
    const inputDatosPago = document.getElementById('conf-bot-datospago');
    if (inputDatosPago) inputDatosPago.value = barberiaActual.datosPago || 'Aceptamos efectivo en el local, transferencias por Nequi y Bancolombia.';

    renderListaReglasBot(barberiaActual.botReglas || []);
  } catch (err) {
    console.error('Error cargando perfil:', err);
  }
}

// Reduce una foto a un tamaño razonable conservando la nitidez.
// Se achica por pasos (mitad en mitad) con suavizado alto: evita el efecto borroso/pixelado de reducir de una sola vez.
// Los logos con transparencia se guardan en PNG para no quedar con fondo negro.
function comprimirImagen(file, maxWidth = 1000, maxHeight = 1000, quality = 0.88, { conservarTransparencia = false } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (event) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const escala = Math.min(1, maxWidth / img.width, maxHeight / img.height);
        const ancho = Math.max(1, Math.round(img.width * escala));
        const alto = Math.max(1, Math.round(img.height * escala));

        let origen = img, w = img.width, h = img.height;
        while (w / 2 >= ancho && h / 2 >= alto) {
          const paso = document.createElement('canvas');
          paso.width = Math.round(w / 2); paso.height = Math.round(h / 2);
          const c = paso.getContext('2d');
          c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
          c.drawImage(origen, 0, 0, paso.width, paso.height);
          origen = paso; w = paso.width; h = paso.height;
        }

        const canvas = document.createElement('canvas');
        canvas.width = ancho; canvas.height = alto;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(origen, 0, 0, ancho, alto);

        if (conservarTransparencia && /png|webp|gif/.test(file.type) && tieneTransparencia(ctx, ancho, alto)) {
          resolve(canvas.toDataURL('image/png'));
          return;
        }
        // JPEG: si quedara alguna zona transparente, se rellena con el gris oscuro de la app
        const fondo = document.createElement('canvas');
        fondo.width = ancho; fondo.height = alto;
        const f = fondo.getContext('2d');
        f.fillStyle = '#111827'; f.fillRect(0, 0, ancho, alto);
        f.drawImage(canvas, 0, 0);
        resolve(fondo.toDataURL('image/jpeg', quality));
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function tieneTransparencia(ctx, ancho, alto) {
  const datos = ctx.getImageData(0, 0, ancho, alto).data;
  for (let i = 3; i < datos.length; i += 16) if (datos[i] < 250) return true;
  return false;
}

// ----- Apariencia: color de marca y portada -----
const PALETA_MARCA = [
  ['#2563EB', 'Azul'], ['#D4A017', 'Dorado'], ['#DC2626', 'Rojo'], ['#059669', 'Verde'],
  ['#7C3AED', 'Morado'], ['#DB2777', 'Rosa'], ['#EA580C', 'Naranja'], ['#64748B', 'Gris']
];

function pintarApariencia() {
  const color = (barberiaActual.colorPrimario || '#2563EB').toUpperCase();
  const input = document.getElementById('conf-color');
  if (!input) return;
  input.value = color;
  input.oninput = () => { pintarPaleta(input.value.toUpperCase()); pintarPreviewPortada(); };
  pintarPaleta(color);
  pintarPreviewPortada();
}

function pintarPaleta(seleccionado) {
  const cont = document.getElementById('paleta-colores');
  cont.querySelectorAll('button').forEach(b => b.remove());
  PALETA_MARCA.forEach(([hex, nombre]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = nombre;
    b.style.background = hex;
    b.className = `w-10 h-10 rounded-lg border-2 transition ${seleccionado === hex ? 'border-white scale-110' : 'border-transparent'}`;
    b.onclick = () => { document.getElementById('conf-color').value = hex; pintarPaleta(hex); pintarPreviewPortada(); };
    cont.insertBefore(b, document.getElementById('conf-color'));
  });
}

function pintarPreviewPortada() {
  const prev = document.getElementById('preview-portada');
  if (!prev || !window.fondoPortada) return;
  const color = document.getElementById('conf-color').value;
  const actual = barberiaActual.portadaUrl || '';
  prev.style.background = fondoPortada(actual, color, barberiaActual.portadaPosicion);
  configurarEncuadrePortada(prev, !!actual && !actual.startsWith('preset:'));
  const nombre = actual.startsWith('preset:') ? (PORTADAS_BARBERIA[actual.slice(7)]?.nombre || 'Diseño')
    : actual ? 'Tu foto' : 'Degradado';
  document.getElementById('preview-portada-nombre').textContent = nombre;

  // Galería: cada diseño se pinta con el color elegido
  const galeria = document.getElementById('galeria-portadas');
  galeria.innerHTML = Object.entries(PORTADAS_BARBERIA).map(([clave, p]) => {
    const valor = clave === 'degradado' ? '' : `preset:${clave}`;
    const elegido = actual === valor;
    return `<button type="button" data-portada="${valor}" title="${p.nombre}"
      class="h-14 rounded-lg border-2 transition ${elegido ? 'border-white' : 'border-gray-800 hover:border-gray-600'}"
      style="background:${p.css(hexARgbAdmin(color))}"></button>`;
  }).join('');
  galeria.querySelectorAll('button').forEach(b => b.onclick = () => {
    barberiaActual.portadaUrl = b.dataset.portada;
    pintarPreviewPortada();
  });
}

// Encuadre de la portada: arrastrar la foto o mover las barras cambia qué parte se ve ("x y zoom", en %)
function leerPosicionPortada() {
  const e = encuadrePortada(barberiaActual.portadaPosicion);
  return [e.x, e.y, e.zoom];
}

function fijarPosicionPortada(x, y, zoom = leerPosicionPortada()[2]) {
  const lim = v => Math.max(0, Math.min(100, Math.round(v)));
  const z = Math.max(100, Math.min(300, Math.round(zoom / 5) * 5));
  // Sin zoom la foto ocupa todo el ancho: a los lados no hay nada que mover
  const px = z > 100 ? lim(x) : 50;
  barberiaActual.portadaPosicion = z > 100 ? `${px} ${lim(y)} ${z}` : `${px} ${lim(y)}`;
  const prev = document.getElementById('preview-portada');
  prev.style.backgroundPosition = `${px}% ${lim(y)}%`;
  prev.style.backgroundSize = `auto, ${tamanoPortada(z)}`; // capa 1: sombreado; capa 2: la foto
  document.getElementById('portada-pos-x').value = px;
  document.getElementById('portada-pos-y').value = lim(y);
  document.getElementById('portada-zoom').value = z;
  document.getElementById('fila-portada-pos-x').classList.toggle('hidden', z <= 100);
  document.getElementById('nota-portada-zoom').classList.toggle('hidden', z > 100);
}

function configurarEncuadrePortada(prev, esFoto) {
  document.getElementById('ajuste-portada').classList.toggle('hidden', !esFoto);
  prev.style.cursor = esFoto ? 'grab' : '';
  prev.style.touchAction = esFoto ? 'none' : '';
  if (!esFoto) return;
  const [x, y, z] = leerPosicionPortada();
  fijarPosicionPortada(x, y, z);
  if (prev.dataset.encuadreListo) return;
  prev.dataset.encuadreListo = '1';

  document.getElementById('portada-pos-x').oninput = e => { const [, y, z] = leerPosicionPortada(); fijarPosicionPortada(+e.target.value, y, z); };
  document.getElementById('portada-pos-y').oninput = e => { const [x, , z] = leerPosicionPortada(); fijarPosicionPortada(x, +e.target.value, z); };
  document.getElementById('portada-zoom').oninput = e => { const [x, y] = leerPosicionPortada(); fijarPosicionPortada(x, y, +e.target.value); };
  // Arrastrar: mover el dedo hacia abajo baja la foto (se ve más de la parte de arriba)
  let inicio = null;
  prev.addEventListener('pointerdown', e => {
    if (document.getElementById('ajuste-portada').classList.contains('hidden')) return;
    inicio = { px: e.clientX, py: e.clientY, pos: leerPosicionPortada() };
    prev.setPointerCapture(e.pointerId);
    prev.style.cursor = 'grabbing';
  });
  prev.addEventListener('pointermove', e => {
    if (!inicio) return;
    const r = prev.getBoundingClientRect();
    fijarPosicionPortada(inicio.pos[0] - (e.clientX - inicio.px) / r.width * 100, inicio.pos[1] - (e.clientY - inicio.py) / r.height * 100, inicio.pos[2]);
  });
  const soltar = () => { if (inicio) { inicio = null; prev.style.cursor = 'grab'; } };
  prev.addEventListener('pointerup', soltar);
  prev.addEventListener('pointercancel', soltar);
}

function hexARgbAdmin(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [37, 99, 235];
}

async function subirPortadaBarberia(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    barberiaActual.portadaUrl = await comprimirImagen(file, 1800, 900, 0.82);
    barberiaActual.portadaPosicion = '50 50';
    pintarPreviewPortada();
    avisar('Portada lista. Ajusta qué parte se ve y haz clic en "Guardar Cambios de la Barbería" para publicarla.');
  } catch (err) {
    avisar('No se pudo procesar la imagen de portada.');
  }
}

function quitarPortadaBarberia() {
  barberiaActual.portadaUrl = '';
  pintarPreviewPortada();
}

// Subir logo barbería
async function subirFotoBarberia(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const base64Optimizado = await comprimirImagen(file, 800, 800, 0.9, { conservarTransparencia: true });
    document.getElementById('preview-logo-barberia').src = base64Optimizado;
    document.getElementById('conf-logo').value = base64Optimizado;
    barberiaActual.logoUrl = base64Optimizado;
    document.getElementById('admin-barberia-logo').src = base64Optimizado;
    avisar('Foto optimizada y cargada. Haz clic en "Guardar Información de la Barbería" para guardarla permanentemente.');
  } catch (err) {
    avisar('Error al procesar la imagen de la barbería.');
  }
}

let tempMiembroFotoUrl = '';
let tempEditMiembroFotoUrl = '';
async function subirFotoMiembro(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const base64Optimizado = await comprimirImagen(file, 1000, 1000, 0.88);
    document.getElementById('preview-foto-miembro').src = base64Optimizado;
    tempMiembroFotoUrl = base64Optimizado;
    avisar('Foto del barbero cargada.');
  } catch (err) {
    avisar('Error al cargar la foto del barbero.');
  }
}

async function subirFotoMiembroEdicion(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const base64Optimizado = await comprimirImagen(file, 1000, 1000, 0.88);
    document.getElementById('edit-preview-foto-miembro').src = base64Optimizado;
    tempEditMiembroFotoUrl = base64Optimizado;
  } catch (err) {
    avisar('Error al cargar la foto.');
  }
}

async function cargarCitas(filtroParams = '') {
  cargarListaEspera();
  try {
    let url = '/api/admin/citas';
    if (filtroParams) {
      url += `?${filtroParams}`;
    } else if (filtroPeriodoActual !== 'todos') {
      url += `?filtro=${filtroPeriodoActual}`;
    }

    const res = await fetch(url, { headers: getAuthHeaders() });
    if (!res.ok) return;

    todasLasCitas = await res.json();
    actualizarEstadisticasYTablas();
    lucide.createIcons();
  } catch (err) {
    console.error('Error cargando citas:', err);
  }
}

function cambiarFiltroPeriodo(periodo) {
  filtroPeriodoActual = periodo;
  ['todos', 'semana', 'quincena', 'mes', 'anio'].forEach(p => {
    const btn = document.getElementById(`filter-${p}`);
    if (btn) {
      if (p === periodo) {
        btn.className = 'px-3 py-1.5 rounded-lg border border-blue-500 bg-blue-600/20 text-blue-400 font-bold';
      } else {
        btn.className = 'px-3 py-1.5 rounded-lg border border-gray-800 bg-gray-950 text-gray-300 hover:border-gray-700';
      }
    }
  });
  cargarCitas(`filtro=${periodo}`);
}

function cambiarPeriodoAgenda(valor) {
  const fila = document.getElementById('fila-rango');
  if (valor === 'rango') {
    fila.classList.remove('hidden');
    fila.classList.add('flex');
    return;
  }
  fila.classList.add('hidden');
  fila.classList.remove('flex');
  cambiarFiltroPeriodo(valor);
}

function aplicarRangoPersonalizado() {
  const start = document.getElementById('filtro-inicio').value;
  const end = document.getElementById('filtro-fin').value;
  if (!start || !end) {
    avisar('Por favor selecciona fecha de inicio y fecha de fin.');
    return;
  }
  cargarCitas(`fechaInicio=${start}&fechaFin=${end}`);
}

function cambiarSubTabCitas(subtab) {
  subTabActual = subtab;
  ['activas', 'completadas', 'noconfirmadas'].forEach(t => {
    const btn = document.getElementById(`subtab-${t}`);
    if (btn) {
      btn.className = t === subtab
        ? 'py-2 rounded-lg text-xs sm:text-sm font-bold bg-gray-800 text-white transition'
        : 'py-2 rounded-lg text-xs sm:text-sm font-semibold text-gray-400 hover:text-white transition';
    }
  });
  renderTablaCitas();
  lucide.createIcons();
}

function actualizarEstadisticasYTablas() {
  let pendientes = 0;
  let completadas = 0;
  let noConfirmadas = 0;
  let ingresosCompletados = 0;

  todasLasCitas.forEach(c => {
    if (c.estado === 'Confirmada' || c.estado === 'Pendiente') {
      pendientes++;
    } else if (c.estado === 'Completada') {
      completadas++;
      ingresosCompletados += c.total;
    } else if (c.estado === 'No Confirmada' || c.estado === 'Cancelada') {
      noConfirmadas++;
    }
  });

  document.getElementById('kpi-pendientes').innerText = pendientes;
  document.getElementById('kpi-completadas').innerText = completadas;
  document.getElementById('kpi-no-confirmadas').innerText = noConfirmadas;
  document.getElementById('kpi-ingresos-reales').innerText = `$ ${Number(ingresosCompletados).toLocaleString('es-CO')}`;
  actualizarResumenHoy();

  document.getElementById('count-activas').innerText = pendientes;
  document.getElementById('count-completadas').innerText = completadas;
  document.getElementById('count-noconfirmadas').innerText = noConfirmadas;

  renderTablaCitas();
}

// ----- Resumen de hoy -----
function actualizarResumenHoy() {
  const titulo = document.getElementById('resumen-hoy-titulo');
  const detalle = document.getElementById('resumen-hoy-detalle');
  if (!titulo) return;
  const hoy = hoyBogotaIso();
  const fechaTexto = new Date(hoy + 'T12:00:00Z').toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  titulo.textContent = `Hoy, ${fechaTexto}`;

  const ahora = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [hh, mm] = ahora.split(':').map(Number);
  const minutosAhora = (hh % 24) * 60 + mm;
  const deHoy = todasLasCitas.filter(c => c.fecha === hoy && (c.estado === 'Confirmada' || c.estado === 'Pendiente'))
    .sort((a, b) => minutosDeHora(a.hora) - minutosDeHora(b.hora));
  const siguiente = deHoy.find(c => minutosDeHora(c.hora) >= minutosAhora - 15);
  const porConfirmar = deHoy.filter(c => c.estado === 'Pendiente').length;

  // Las citas atendidas, las que no se confirmaron y las canceladas salen solas de esta lista
  const lista = document.getElementById('resumen-hoy-lista');
  if (!deHoy.length) {
    detalle.textContent = 'No tienes más citas hoy.';
    if (lista) lista.innerHTML = '';
    return;
  }
  detalle.innerHTML = `${deHoy.length} cita${deHoy.length === 1 ? '' : 's'} por atender` +
    (porConfirmar ? ` · <span class="text-amber-300">${porConfirmar} por confirmar</span>` : '');
  if (!lista) return;
  const visibles = deHoy.slice(0, 5);
  lista.innerHTML = visibles.map(c => {
    const empezo = minutosDeHora(c.hora) <= minutosAhora;
    const esSiguiente = c === siguiente;
    const etiqueta = empezo ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300">Ahora</span>'
      : c.estado === 'Pendiente' ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-300">Por confirmar</span>'
      : '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-gray-800 text-gray-300">Confirmada</span>';
    return `<div class="flex items-center gap-2.5 text-xs ${esSiguiente || empezo ? '' : 'opacity-80'}">
      <span class="w-[4.5rem] flex-shrink-0 font-bold ${esSiguiente || empezo ? 'text-white' : 'text-gray-300'}">${horaLegible(c.hora)}</span>
      <span class="min-w-0 flex-1 truncate text-gray-300">${escapeHtml(c.nombreCliente)}<span class="text-gray-500"> · ${escapeHtml(c.servicio || '')}${c.barbero ? ` · ${escapeHtml(c.barbero)}` : ''}</span></span>
      ${etiqueta}
    </div>`;
  }).join('') + (deHoy.length > visibles.length ? `<p class="text-[11px] text-gray-500">y ${deHoy.length - visibles.length} más en la agenda de abajo</p>` : '');
}

// ----- Agenda: lista agrupada por día -----
const ESTADOS_CITA = {
  'Pendiente': ['Por confirmar', 'bg-amber-500/10 text-amber-300 border-amber-500/30', 'hourglass'],
  'Confirmada': ['Confirmada', 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', 'check-check'],
  'Completada': ['Atendida', 'bg-blue-500/10 text-blue-300 border-blue-500/30', 'badge-check'],
  'No Confirmada': ['No confirmó', 'bg-gray-700/40 text-gray-300 border-gray-600/40', 'clock-alert'],
  'Cancelada': ['Cancelada', 'bg-red-500/10 text-red-300 border-red-500/30', 'x-circle']
};

function minutosDeHora(hora) {
  const t = String(hora || '').toLowerCase();
  const m = t.match(/(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  let h = Number(m[1]);
  if (t.includes('pm') && h < 12) h += 12;
  if (t.includes('am') && h === 12) h = 0;
  return h * 60 + Number(m[2]);
}

function horaLegible(hora) {
  const min = minutosDeHora(hora), h = Math.floor(min / 60);
  return `${h % 12 || 12}:${String(min % 60).padStart(2, '0')}\u00a0${h < 12 ? 'a.\u00a0m.' : 'p.\u00a0m.'}`;
}

function sumarDiasIso(iso, n) {
  return new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

// "jue 26 nov"
function fechaCorta(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '').replace(',', '');
}

function hoyBogotaIso(desplazarDias = 0) {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  return new Date(Date.parse(hoy + 'T12:00:00Z') + desplazarDias * 86400000).toISOString().slice(0, 10);
}

function tituloDia(fechaIso) {
  if (fechaIso === hoyBogotaIso()) return 'Hoy';
  if (fechaIso === hoyBogotaIso(1)) return 'Mañana';
  if (fechaIso === hoyBogotaIso(-1)) return 'Ayer';
  const t = new Date(fechaIso + 'T12:00:00Z').toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function renderTablaCitas() {
  const cont = document.getElementById('citas-tbody');

  let citasFiltradas = [];
  if (subTabActual === 'activas') {
    citasFiltradas = todasLasCitas.filter(c => c.estado === 'Confirmada' || c.estado === 'Pendiente');
  } else if (subTabActual === 'completadas') {
    citasFiltradas = todasLasCitas.filter(c => c.estado === 'Completada');
  } else if (subTabActual === 'noconfirmadas') {
    citasFiltradas = todasLasCitas.filter(c => c.estado === 'No Confirmada' || c.estado === 'Cancelada');
  }

  if (citasFiltradas.length === 0) {
    const vacio = {
      activas: ['calendar-check', 'No tienes citas próximas', 'Cuando un cliente reserve aparecerá aquí.'],
      completadas: ['badge-check', 'Aún no hay citas atendidas', 'Las citas se marcan como atendidas solas al terminar.'],
      noconfirmadas: ['circle-off', 'Nada por aquí', 'Aquí verás las citas canceladas o que el cliente no confirmó.']
    }[subTabActual];
    cont.innerHTML = `<div class="py-10 text-center"><i data-lucide="${vacio[0]}" class="w-8 h-8 text-gray-600 mx-auto"></i>
      <p class="text-sm font-bold text-gray-300 mt-3">${vacio[1]}</p><p class="text-xs text-gray-500 mt-1">${vacio[2]}</p></div>`;
    lucide.createIcons();
    return;
  }

  // Próximas: de la más cercana a la más lejana. Historial: de la más reciente a la más antigua
  const asc = subTabActual === 'activas';
  citasFiltradas.sort((a, b) => {
    const cmp = a.fecha === b.fecha ? minutosDeHora(a.hora) - minutosDeHora(b.hora) : a.fecha.localeCompare(b.fecha);
    return asc ? cmp : -cmp;
  });

  const grupos = [];
  citasFiltradas.forEach(c => {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.fecha === c.fecha) ultimo.citas.push(c);
    else grupos.push({ fecha: c.fecha, citas: [c] });
  });

  cont.innerHTML = grupos.map(g => {
    const total = g.citas.reduce((s, c) => s + Number(c.total || 0), 0);
    return `
      <div>
        <div class="flex items-baseline justify-between mb-2 px-1">
          <h4 class="font-extrabold text-white text-sm">${escapeHtml(tituloDia(g.fecha))}</h4>
          <span class="text-[11px] text-gray-500">${g.citas.length} cita${g.citas.length === 1 ? '' : 's'} · $ ${total.toLocaleString('es-CO')}</span>
        </div>
        <div class="space-y-2">${g.citas.map(tarjetaCitaAdmin).join('')}</div>
      </div>`;
  }).join('');
  lucide.createIcons();
}

function tarjetaCitaAdmin(c) {
  const phoneClean = String(c.telefonoCliente || '').replace(/[^0-9]/g, '');
  const [textoEstado, claseEstado, iconoEstado] = ESTADOS_CITA[c.estado] || [c.estado, ESTADOS_CITA.Confirmada[1], 'circle'];
  const acciones = subTabActual === 'activas'
    ? `<button onclick="eliminarOMoverNoConfirmada(${c.id})" title="No vino / quitar de la agenda" class="p-2 rounded-lg text-gray-500 hover:text-red-300 hover:bg-red-500/10 transition"><i data-lucide="x" class="w-4 h-4"></i></button>`
    : subTabActual === 'noconfirmadas'
      ? `<div class="flex flex-col sm:flex-row gap-1.5">
          <button onclick="reactivarCita(${c.id})" class="text-xs px-2.5 py-1.5 rounded-lg bg-blue-600/20 text-blue-300 border border-blue-500/30 font-semibold">Reactivar</button>
          <button onclick="eliminarPermanente(${c.id})" class="text-xs px-2.5 py-1.5 rounded-lg text-gray-400 hover:text-red-300 font-semibold">Borrar</button>
        </div>`
      : '';

  return `
    <div class="flex items-center gap-3 p-3 sm:p-4 rounded-2xl bg-gray-950/60 border border-gray-800">
      <div class="w-[4.5rem] flex-shrink-0 text-center">
        <div class="text-sm font-extrabold text-white whitespace-nowrap">${horaLegible(c.hora)}</div>
        <div class="text-[10px] text-gray-500 font-mono mt-0.5">${escapeHtml(c.codigoReserva)}</div>
      </div>
      <div class="w-px self-stretch bg-gray-800"></div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-bold text-white text-sm truncate">${escapeHtml(c.nombreCliente)}</span>
          <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-semibold whitespace-nowrap ${claseEstado}">
            <i data-lucide="${iconoEstado}" class="w-3 h-3"></i> ${escapeHtml(textoEstado)}
          </span>
        </div>
        <p class="text-xs text-gray-300 mt-0.5 truncate">${escapeHtml(c.servicio)}<span class="text-gray-500"> · ${escapeHtml(c.barbero)}</span></p>
        <div class="flex items-center gap-3 mt-1 text-[11px]">
          <a href="https://wa.me/${phoneClean}" target="_blank" rel="noopener" class="text-gray-400 hover:text-emerald-300 inline-flex items-center gap-1">
            <i data-lucide="message-circle" class="w-3 h-3 text-emerald-400"></i> ${escapeHtml(c.telefonoCliente)}
          </a>
          <span class="font-bold text-white whitespace-nowrap">$ ${Number(c.total || 0).toLocaleString('es-CO')}</span>
        </div>
      </div>
      ${acciones}
    </div>`;
}

async function marcarCompletada(id) {
  try {
    const res = await fetch(`/api/admin/citas/${id}/estado`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ estado: 'Completada' })
    });
    if (res.ok) cargarCitas();
  } catch (err) {
    avisar('Error al completar cita.');
  }
}

async function eliminarOMoverNoConfirmada(id) {
  if (!(await confirmar('¿El cliente no vino o quieres quitar esta cita de la agenda? Se moverá a "No confirmadas".'))) return;
  try {
    const res = await fetch(`/api/admin/citas/${id}?marcarNoConfirmada=true`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (res.ok) cargarCitas();
  } catch (err) {
    avisar('Error al actualizar cita.');
  }
}

async function reactivarCita(id) {
  try {
    const res = await fetch(`/api/admin/citas/${id}/estado`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ estado: 'Confirmada' })
    });
    if (res.ok) cargarCitas();
  } catch (err) {
    avisar('Error al reactivar cita.');
  }
}

async function eliminarPermanente(id) {
  if (!(await confirmar('¿Seguro que deseas eliminar definitivamente esta cita?'))) return;
  try {
    const res = await fetch(`/api/admin/citas/${id}?marcarNoConfirmada=false`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (res.ok) cargarCitas();
  } catch (err) {
    avisar('Error al eliminar.');
  }
}

function renderListaServicios(servicios) {
  const container = document.getElementById('lista-servicios');
  container.innerHTML = '';

  // Actualizar datalist de sugerencias con categorías existentes
  const datalist = document.getElementById('datalist-categorias');
  if (datalist) {
    const cats = new Set(['Cortes', 'Limpieza facial', 'Barba', 'Combos', 'Uñas', 'Peluquería']);
    (servicios || []).forEach(s => {
      if (s.categoria && s.categoria.trim()) cats.add(s.categoria.trim());
    });
    datalist.innerHTML = Array.from(cats).map(c => `<option value="${escapeHtml(c)}">`).join('');
  }

  if (!servicios || servicios.length === 0) {
    container.innerHTML = `<p class="text-xs text-gray-500 py-4 italic">No hay servicios registrados aún.</p>`;
    return;
  }

  servicios.forEach(s => {
    const div = document.createElement('div');
    div.className = 'py-3 flex items-center justify-between gap-3';
    div.innerHTML = `
      <div class="flex-1">
        <div class="flex items-center gap-2">
          <span class="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">${s.categoria || 'Cortes'}</span>
          <h5 class="font-bold text-white text-sm">${escapeHtml(s.nombre)}</h5>
        </div>
        <p class="text-xs text-gray-400 mt-0.5">$ ${Number(s.precio).toLocaleString()} • ${s.duracionMinutos} min</p>
      </div>
      <div class="flex items-center gap-1.5">
        <button onclick="abrirModalEditarServicio(${JSON.stringify(s).replace(/"/g, '&quot;')})" class="text-blue-400 hover:text-blue-300 text-xs px-2.5 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center gap-1">
          <i data-lucide="edit-2" class="w-3 h-3"></i> Editar
        </button>
        <button onclick="eliminarServicio(${s.id})" class="text-red-400 hover:text-red-300 text-xs px-2.5 py-1 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-1">
          <i data-lucide="trash-2" class="w-3 h-3"></i> Eliminar
        </button>
      </div>
    `;
    container.appendChild(div);
  });
  lucide.createIcons();
}

function renderListaMiembros(miembros) {
  const container = document.getElementById('lista-miembros');
  container.innerHTML = '';
  miembros.forEach(m => {
    const foto = m.fotoUrl || DEFAULT_AVATAR;
    const div = document.createElement('div');
    div.className = 'p-3 rounded-xl bg-gray-950 border border-gray-800 flex items-center justify-between';
    div.innerHTML = `
      <div class="flex items-center gap-3">
        <img src="${foto}" class="w-11 h-11 rounded-full object-cover border border-blue-400/30 bg-gray-900 p-0.5">
        <div>
          <h5 class="font-bold text-white text-sm">${escapeHtml(m.nombre)}</h5>
          <p class="text-xs text-gray-400">${escapeHtml(m.rol)}</p>
        </div>
      </div>
      <div class="flex items-center gap-1.5">
        <button onclick="abrirModalEditarMiembro(${JSON.stringify(m).replace(/"/g, '&quot;')})" class="text-blue-400 hover:text-blue-300 text-xs px-2.5 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center gap-1">
          <i data-lucide="edit-2" class="w-3 h-3"></i> Editar
        </button>
        <button onclick="eliminarMiembro(${m.id})" class="text-red-400 hover:text-red-300 text-xs px-2.5 py-1 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-1">
          <i data-lucide="trash-2" class="w-3 h-3"></i> Eliminar
        </button>
      </div>
    `;
    container.appendChild(div);
  });
}

// "12:00-14:30" -> "12:00 p. m. – 2:30 p. m."; "12:30pm" o "15:00" -> una hora legible
function textoHorasBloqueo(hora) {
  if (!hora || hora === 'TODO_EL_DIA') return 'Todo el día';
  if (hora.includes('-')) {
    const [desde, hasta] = hora.split('-');
    return `${horaLegible(desde)} – ${horaLegible(hasta)}`;
  }
  return horaLegible(hora);
}

function renderListaBloqueos(bloqueos) {
  const container = document.getElementById('lista-bloqueos');
  const hoy = hoyBogotaIso();
  const proximos = (bloqueos || [])
    .filter(b => b.fecha >= hoy)
    .sort((a, b) => a.fecha === b.fecha ? minutosDeHora(a.hora) - minutosDeHora(b.hora) : a.fecha.localeCompare(b.fecha));

  if (!proximos.length) {
    container.innerHTML = `<p class="text-xs text-gray-500">No tienes días ni horarios bloqueados.</p>`;
    return;
  }

  // Días completos seguidos con el mismo motivo se muestran juntos ("jue 26 nov – sáb 28 nov · 3 días")
  const grupos = [];
  proximos.forEach(b => {
    const diaCompleto = !b.hora || b.hora === 'TODO_EL_DIA';
    const ultimo = grupos[grupos.length - 1];
    if (diaCompleto && ultimo?.diaCompleto && ultimo.motivo === b.motivo && sumarDiasIso(ultimo.hasta, 1) === b.fecha) {
      ultimo.hasta = b.fecha;
      ultimo.ids.push(b.id);
    } else {
      grupos.push({ diaCompleto, motivo: b.motivo, desde: b.fecha, hasta: b.fecha, hora: b.hora, ids: [b.id] });
    }
  });

  container.innerHTML = grupos.map(g => {
    const varios = g.ids.length > 1;
    const titulo = varios ? `${fechaCorta(g.desde)} – ${fechaCorta(g.hasta)}` : tituloDia(g.desde);
    const detalle = varios ? `${g.ids.length} días` : textoHorasBloqueo(g.hora);
    return `
      <div class="p-3 rounded-2xl bg-gray-950/60 border border-gray-800 flex items-center gap-3">
        <span class="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center ${g.diaCompleto ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'}">
          <i data-lucide="${g.diaCompleto ? 'calendar-x' : 'clock'}" class="w-5 h-5"></i>
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-bold text-white">${escapeHtml(titulo)}</p>
          <p class="text-xs text-gray-400 truncate">${escapeHtml(detalle)}${g.motivo ? ` · ${escapeHtml(g.motivo)}` : ''}</p>
        </div>
        <button onclick="eliminarBloqueos([${g.ids.join(',')}])" class="text-xs px-3 py-2 rounded-xl text-gray-300 bg-gray-800 hover:bg-gray-700 font-semibold flex-shrink-0">Quitar</button>
      </div>`;
  }).join('');
  lucide.createIcons();
}

async function guardarPerfilBarberia(e) {
  e.preventDefault();
  const payload = {
    nombre: document.getElementById('conf-nombre').value.trim(),
    telefonoWhatsApp: document.getElementById('conf-phone').value.trim(),
    direccion: document.getElementById('conf-dir').value.trim(),
    horarioTexto: document.getElementById('conf-horario').value.trim(),
    descripcion: document.getElementById('conf-desc').value.trim(),
    logoUrl: document.getElementById('conf-logo').value.trim() || barberiaActual.logoUrl,
    colorPrimario: document.getElementById('conf-color').value,
    portadaUrl: barberiaActual.portadaUrl || '',
    portadaPosicion: barberiaActual.portadaPosicion || '50 50',
    mostrarSelectorBarbero: document.getElementById('conf-mostrar-barberos').checked,
    horaApertura: barberiaActual.horaApertura || '09:00',
    horaCierre: barberiaActual.horaCierre || '20:00',
    intervaloMinutos: barberiaActual.intervaloMinutos || 40,
    diasLaborales: barberiaActual.diasLaborales || "1,2,3,4,5,6"
  };

  try {
    const res = await fetch('/api/admin/perfil', {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      avisar('¡Información de la barbería actualizada!');
      cargarPerfil();
    } else {
      const data = await res.json().catch(() => ({}));
      avisar(data.message || 'No se pudieron guardar los cambios.', 'error');
    }
  } catch (err) {
    avisar('Error al guardar cambios.');
  }
}

// ================== Horario de atención por día (y por barbero) ==================
const DIAS_EDITOR = [[1, 'Lunes'], [2, 'Martes'], [3, 'Miércoles'], [4, 'Jueves'], [5, 'Viernes'], [6, 'Sábado'], [0, 'Domingo']];
let editorHorario = { quien: 'barberia', usaBarberia: false, dias: {} };

function copiarHorario(h) {
  const r = {};
  for (let d = 0; d <= 6; d++) {
    const dia = (h && h[d]) || { cerrado: true, rangos: [] };
    r[d] = { cerrado: !!dia.cerrado, rangos: (dia.rangos || []).map(x => ({ desde: x.desde, hasta: x.hasta })) };
  }
  return r;
}

function horarioMiembro(m) {
  if (!m || !m.horarioSemanal) return null;
  try { return typeof m.horarioSemanal === 'string' ? JSON.parse(m.horarioSemanal) : m.horarioSemanal; } catch (e) { return null; }
}

function pintarEditorHorario() {
  const selector = document.getElementById('horario-quien');
  const miembros = (barberiaActual?.miembros || []).filter(m => m.activo !== false);
  const conVarios = !!barberiaActual?.mostrarSelectorBarbero && miembros.length > 1;
  document.getElementById('fila-horario-quien').classList.toggle('hidden', !conVarios);
  const anterior = editorHorario.quien;
  selector.innerHTML = '<option value="barberia">Toda la barbería (horario general)</option>' +
    (conVarios ? miembros.map(m => `<option value="${m.id}">${escapeHtml(m.nombre)}</option>`).join('') : '');
  selector.value = [...selector.options].some(o => o.value === String(anterior)) ? String(anterior) : 'barberia';
  selector.onchange = () => cargarHorarioEnEditor(selector.value);
  cargarHorarioEnEditor(selector.value);
}

function cargarHorarioEnEditor(quien) {
  editorHorario.quien = quien;
  const general = TurnosBF.horarioBarberia(barberiaActual);
  if (quien === 'barberia') {
    editorHorario.usaBarberia = false;
    editorHorario.dias = copiarHorario(general);
  } else {
    const propio = horarioMiembro((barberiaActual.miembros || []).find(m => String(m.id) === String(quien)));
    editorHorario.usaBarberia = !propio;
    editorHorario.dias = copiarHorario(propio || general);
  }
  const filaUsa = document.getElementById('fila-usa-barberia');
  filaUsa.classList.toggle('hidden', quien === 'barberia');
  document.getElementById('horario-usa-barberia').checked = editorHorario.usaBarberia;
  document.getElementById('horario-usa-barberia').onchange = e => {
    editorHorario.usaBarberia = e.target.checked;
    if (editorHorario.usaBarberia) editorHorario.dias = copiarHorario(general);
    renderDiasHorario();
  };
  renderDiasHorario();
}

function renderDiasHorario() {
  const cont = document.getElementById('editor-dias-horario');
  const bloqueado = editorHorario.quien !== 'barberia' && editorHorario.usaBarberia;
  cont.classList.toggle('opacity-50', bloqueado);
  cont.classList.toggle('pointer-events-none', bloqueado);
  cont.innerHTML = DIAS_EDITOR.map(([d, nombre]) => {
    const dia = editorHorario.dias[d];
    const abierto = !dia.cerrado;
    const rangos = dia.rangos.map((r, i) => `
      <div class="flex items-center gap-2">
        <input type="time" value="${escapeHtml(r.desde)}" data-dia="${d}" data-i="${i}" data-campo="desde" class="campo !py-1.5 !px-2 text-sm flex-1 min-w-0">
        <span class="text-xs text-gray-500">a</span>
        <input type="time" value="${escapeHtml(r.hasta)}" data-dia="${d}" data-i="${i}" data-campo="hasta" class="campo !py-1.5 !px-2 text-sm flex-1 min-w-0">
        <button type="button" data-quitar="${d}" data-i="${i}" class="w-8 h-8 flex-shrink-0 rounded-lg text-gray-500 hover:text-red-300 hover:bg-gray-800" aria-label="Quitar este rango">✕</button>
      </div>`).join('');
    return `
      <div class="p-3 rounded-xl bg-gray-950 border ${abierto ? 'border-gray-800' : 'border-gray-900'}">
        <div class="flex items-center justify-between gap-3">
          <p class="text-sm font-bold ${abierto ? 'text-white' : 'text-gray-500'}">${nombre}</p>
          <label class="relative inline-flex items-center cursor-pointer gap-2">
            <span class="text-[11px] font-semibold ${abierto ? 'text-emerald-300' : 'text-gray-500'}">${abierto ? 'Abierto' : 'Cerrado'}</span>
            <input type="checkbox" data-abierto="${d}" ${abierto ? 'checked' : ''} class="sr-only peer">
            <div class="w-9 h-5 bg-gray-800 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:right-[18px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
          </label>
        </div>
        ${abierto ? `
          <div class="mt-2.5 space-y-2">${rangos}</div>
          ${dia.rangos.length < 4 ? `<button type="button" data-agregar="${d}" class="mt-2 text-[11px] font-semibold text-blue-300 hover:text-blue-200">+ Agregar otro rango (ej. después del almuerzo)</button>` : ''}`
        : `<p class="text-[11px] text-gray-600 mt-1">No se reciben citas este día.</p>`}
      </div>`;
  }).join('');

  cont.querySelectorAll('[data-abierto]').forEach(chk => chk.onchange = () => {
    const d = Number(chk.dataset.abierto);
    const dia = editorHorario.dias[d];
    dia.cerrado = !chk.checked;
    if (!dia.cerrado && !dia.rangos.length) dia.rangos = [{ desde: '09:00', hasta: '19:00' }];
    renderDiasHorario();
  });
  cont.querySelectorAll('input[type=time]').forEach(inp => inp.onchange = () => {
    editorHorario.dias[Number(inp.dataset.dia)].rangos[Number(inp.dataset.i)][inp.dataset.campo] = inp.value;
  });
  cont.querySelectorAll('[data-quitar]').forEach(b => b.onclick = () => {
    const dia = editorHorario.dias[Number(b.dataset.quitar)];
    dia.rangos.splice(Number(b.dataset.i), 1);
    if (!dia.rangos.length) dia.cerrado = true;
    renderDiasHorario();
  });
  cont.querySelectorAll('[data-agregar]').forEach(b => b.onclick = () => {
    const dia = editorHorario.dias[Number(b.dataset.agregar)];
    const ultimo = dia.rangos[dia.rangos.length - 1];
    const desde = ultimo ? ultimo.hasta : '09:00';
    const finMin = Math.min(23 * 60 + 30, TurnosBF.aMinutos(desde) + 180);
    dia.rangos.push({ desde, hasta: `${String(Math.floor(finMin / 60)).padStart(2, '0')}:${String(finMin % 60).padStart(2, '0')}` });
    renderDiasHorario();
  });
}

// El horario del lunes se copia a todos los días que estén abiertos
function copiarLunesATodos() {
  const lunes = editorHorario.dias[1];
  if (lunes.cerrado) return avisar('El lunes está cerrado: ábrelo y ponle horas primero.', 'error');
  for (let d = 0; d <= 6; d++) if (d !== 1 && !editorHorario.dias[d].cerrado) editorHorario.dias[d].rangos = lunes.rangos.map(r => ({ ...r }));
  renderDiasHorario();
  avisar('Listo: los días abiertos quedaron con el horario del lunes. Recuerda guardar.', 'info');
}

function payloadBaseBarberia() {
  return {
    nombre: barberiaActual.nombre,
    telefonoWhatsApp: barberiaActual.telefonoWhatsApp,
    direccion: barberiaActual.direccion,
    horarioTexto: barberiaActual.horarioTexto,
    descripcion: barberiaActual.descripcion,
    logoUrl: barberiaActual.logoUrl,
    mostrarSelectorBarbero: barberiaActual.mostrarSelectorBarbero,
    horaApertura: barberiaActual.horaApertura,
    horaCierre: barberiaActual.horaCierre,
    intervaloMinutos: barberiaActual.intervaloMinutos,
    diasLaborales: barberiaActual.diasLaborales
  };
}

async function guardarHorario() {
  const boton = document.getElementById('btn-guardar-horario');
  boton.disabled = true;
  try {
    let res;
    if (editorHorario.quien === 'barberia') {
      res = await fetch('/api/admin/perfil', {
        method: 'PUT', headers: getAuthHeaders(),
        body: JSON.stringify({ ...payloadBaseBarberia(), horarioSemanal: JSON.stringify(editorHorario.dias) })
      });
    } else {
      res = await fetch(`/api/admin/miembros/${editorHorario.quien}/horario`, {
        method: 'PUT', headers: getAuthHeaders(),
        body: JSON.stringify({ horarioSemanal: editorHorario.usaBarberia ? null : JSON.stringify(editorHorario.dias) })
      });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return avisar(data.message || 'No se pudo guardar el horario.', 'error');
    avisar('¡Horario guardado! Tus clientes ya ven las horas nuevas.');
    cargarPerfil();
  } catch (e) {
    avisar('Error al conectar con el servidor.', 'error');
  } finally {
    boton.disabled = false;
  }
}

// ----- Reglas de reserva -----
function pintarReglasReserva() {
  document.getElementById('conf-intervalo').value = String(barberiaActual.intervaloMinutos || 40);
  document.getElementById('conf-anticipacion').value = String(barberiaActual.minutosAnticipacion ?? 30);
  document.getElementById('conf-dias-maximo').value = String(barberiaActual.diasMaximoReserva || 30);
  document.getElementById('conf-limite-cancelar').value = String(barberiaActual.horasLimiteCancelar ?? 2);
}

async function guardarReglasReserva(e) {
  e.preventDefault();
  try {
    const res = await fetch('/api/admin/perfil', {
      method: 'PUT', headers: getAuthHeaders(),
      body: JSON.stringify({
        ...payloadBaseBarberia(),
        intervaloMinutos: parseInt(document.getElementById('conf-intervalo').value),
        minutosAnticipacion: parseInt(document.getElementById('conf-anticipacion').value),
        diasMaximoReserva: parseInt(document.getElementById('conf-dias-maximo').value),
        horasLimiteCancelar: parseInt(document.getElementById('conf-limite-cancelar').value)
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return avisar(data.message || 'No se pudieron guardar las reglas.', 'error');
    avisar('¡Reglas de reserva guardadas!');
    cargarPerfil();
  } catch (err) {
    avisar('Error al conectar con el servidor.', 'error');
  }
}

// ----- Bloquear varias horas sueltas -----
let horasSueltasElegidas = new Set();

function pintarHorasSueltas() {
  const cont = document.getElementById('bloq-horas-sueltas');
  const fecha = document.getElementById('bloq-fecha').value;
  if (!fecha) { cont.innerHTML = '<p class="col-span-full text-[11px] text-gray-500">Elige primero la fecha.</p>'; return; }
  const intervalo = barberiaActual.intervaloMinutos || 40;
  const rangos = TurnosBF.rangosDelDia(barberiaActual, fecha);
  const horas = [];
  rangos.forEach(r => { for (let t = r.ini; t + intervalo <= r.fin; t += intervalo) horas.push(t); });
  if (!horas.length) { cont.innerHTML = '<p class="col-span-full text-[11px] text-gray-500">Ese día la barbería no atiende.</p>'; return; }
  cont.innerHTML = horas.map(t => `<button type="button" data-hora="${t}"
    class="py-2 rounded-lg border text-xs font-semibold transition ${horasSueltasElegidas.has(t) ? 'bg-red-600/25 border-red-500 text-white' : 'bg-gray-900 border-gray-800 text-gray-300 hover:border-gray-600'}">${TurnosBF.minutosATexto(t)}</button>`).join('');
  cont.querySelectorAll('button[data-hora]').forEach(b => b.onclick = () => {
    const t = Number(b.dataset.hora);
    horasSueltasElegidas.has(t) ? horasSueltasElegidas.delete(t) : horasSueltasElegidas.add(t);
    pintarHorasSueltas();
  });
}

// Horas seguidas se juntan en un solo rango ("9:00, 9:40 y 10:20" -> 9:00–11:00)
function rangosDeHorasSueltas() {
  const intervalo = barberiaActual.intervaloMinutos || 40;
  const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const orden = [...horasSueltasElegidas].sort((a, b) => a - b);
  const grupos = [];
  orden.forEach(t => {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.fin === t) ultimo.fin = t + intervalo;
    else grupos.push({ ini: t, fin: t + intervalo });
  });
  return grupos.map(g => `${hhmm(g.ini)}-${hhmm(g.fin)}`);
}

async function agregarServicio(e) {
  e.preventDefault();
  const payload = {
    categoria: document.getElementById('serv-cat').value.trim() || 'Cortes',
    nombre: document.getElementById('serv-nom').value.trim(),
    precio: parseFloat(document.getElementById('serv-precio').value),
    duracionMinutos: parseInt(document.getElementById('serv-dur').value) || 30,
    descripcion: document.getElementById('serv-desc').value.trim(),
    icono: 'scissors',
    activo: true
  };

  try {
    const res = await fetch('/api/admin/servicios', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      document.getElementById('form-nuevo-servicio').reset();
      cargarPerfil();
    } else {
      const data = await res.json().catch(() => ({}));
      avisar(data.message || 'No se pudo agregar el servicio.', 'error');
    }
  } catch (err) {
    avisar('Error agregando servicio.');
  }
}

async function eliminarServicio(id) {
  if (!(await confirmar('¿Seguro que deseas eliminar este servicio?'))) return;
  try {
    const res = await fetch(`/api/admin/servicios/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (!res.ok) avisar('No se pudo eliminar el servicio.', 'error');
    cargarPerfil();
  } catch (err) {
    avisar('Error eliminando servicio.');
  }
}

function abrirModalEditarServicio(servicio) {
  document.getElementById('edit-serv-id').value = servicio.id;
  document.getElementById('edit-serv-cat').value = servicio.categoria || 'Cortes';
  document.getElementById('edit-serv-nom').value = servicio.nombre;
  document.getElementById('edit-serv-precio').value = servicio.precio;
  document.getElementById('edit-serv-dur').value = servicio.duracionMinutos;
  document.getElementById('edit-serv-desc').value = servicio.descripcion || '';

  document.getElementById('modal-editar-servicio').classList.remove('hidden');
}

function cerrarModalEditarServicio() {
  document.getElementById('modal-editar-servicio').classList.add('hidden');
}

async function guardarEdicionServicio(e) {
  e.preventDefault();
  const id = document.getElementById('edit-serv-id').value;
  const payload = {
    categoria: document.getElementById('edit-serv-cat').value.trim() || 'Cortes',
    nombre: document.getElementById('edit-serv-nom').value.trim(),
    precio: parseFloat(document.getElementById('edit-serv-precio').value),
    duracionMinutos: parseInt(document.getElementById('edit-serv-dur').value) || 30,
    descripcion: document.getElementById('edit-serv-desc').value.trim(),
    icono: 'scissors',
    activo: true
  };

  try {
    const res = await fetch(`/api/admin/servicios/${id}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      cerrarModalEditarServicio();
      cargarPerfil();
    } else {
      const data = await res.json();
      avisar(data.message || 'Error al actualizar el servicio.');
    }
  } catch (err) {
    avisar('Error al conectar con el servidor.');
  }
}

async function agregarMiembro(e) {
  e.preventDefault();
  const payload = {
    nombre: document.getElementById('miembro-nom').value.trim(),
    rol: document.getElementById('miembro-rol').value.trim(),
    fotoUrl: tempMiembroFotoUrl || DEFAULT_AVATAR,
    activo: true
  };

  try {
    const res = await fetch('/api/admin/miembros', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      document.getElementById('form-nuevo-miembro').reset();
      document.getElementById('preview-foto-miembro').src = DEFAULT_AVATAR;
      tempMiembroFotoUrl = '';
      cargarPerfil();
    } else {
      const data = await res.json().catch(() => ({}));
      avisar(data.message || 'No se pudo agregar el barbero.', 'error');
    }
  } catch (err) {
    avisar('Error agregando barbero.');
  }
}

async function eliminarMiembro(id) {
  if (!(await confirmar('¿Seguro que deseas eliminar este barbero?'))) return;
  try {
    const res = await fetch(`/api/admin/miembros/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (!res.ok) avisar('No se pudo eliminar el barbero.', 'error');
    cargarPerfil();
  } catch (err) {
    avisar('Error eliminando barbero.');
  }
}

function abrirModalEditarMiembro(m) {
  document.getElementById('edit-miembro-id').value = m.id;
  document.getElementById('edit-miembro-nom').value = m.nombre;
  document.getElementById('edit-miembro-rol').value = m.rol || '';
  tempEditMiembroFotoUrl = m.fotoUrl || '';
  document.getElementById('edit-preview-foto-miembro').src = m.fotoUrl || DEFAULT_AVATAR;
  document.getElementById('modal-editar-miembro').classList.remove('hidden');
}

function cerrarModalEditarMiembro() {
  document.getElementById('modal-editar-miembro').classList.add('hidden');
}

async function guardarEdicionMiembro(e) {
  e.preventDefault();
  const id = document.getElementById('edit-miembro-id').value;
  const payload = {
    nombre: document.getElementById('edit-miembro-nom').value.trim(),
    rol: document.getElementById('edit-miembro-rol').value.trim(),
    fotoUrl: tempEditMiembroFotoUrl || DEFAULT_AVATAR,
    activo: true
  };

  try {
    const res = await fetch(`/api/admin/miembros/${id}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      cerrarModalEditarMiembro();
      cargarPerfil();
    } else {
      avisar('No se pudo guardar la edición del miembro.');
    }
  } catch (err) {
    avisar('Error al conectar con el servidor.');
  }
}

async function bloquearPausaRapida(tipo) {
  const hoyIso = hoyBogotaIso();

  let horas = [];
  let motivo = '';

  if (tipo === 'almuerzo') {
    horas = ['12:30-14:00'];
    motivo = '🍱 Almuerzo';
  } else if (tipo === 'tarde') {
    horas = ['16:30-17:30'];
    motivo = '☕ Pausa de la Tarde';
  }

  for (const h of horas) {
    try {
      const res = await fetch('/api/admin/bloqueos', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ fecha: hoyIso, hora: h, motivo: motivo })
      });
      if (res.ok) {
        avisar(`¡${motivo} bloqueado para hoy con éxito!`);
        await ofrecerAvisarCitasAfectadas(await res.json().catch(() => ({})), motivo.replace(/^\S+\s/, ''));
      }
    } catch (err) {}
  }
  cargarPerfil();
}

// Imprevisto: cerrar desde ahora hasta la hora de cierre de hoy
async function cerrarRestoDeHoy() {
  const ahora = TurnosBF.ahoraBogota();
  const desde = Math.floor(ahora.minutos / 10) * 10;
  const rangosHoy = TurnosBF.rangosDelDia(barberiaActual, ahora.iso);
  const cierre = rangosHoy.length ? rangosHoy[rangosHoy.length - 1].fin : TurnosBF.aMinutos(barberiaActual?.horaCierre || '20:00');
  if (desde >= cierre) {
    avisar('Ya pasó la hora de cierre de hoy. Si es para otro día, usa "Bloquear otro día u horario".', 'info');
    return;
  }
  const motivo = await pedirTexto(
    `Se cerrará hoy desde las ${TurnosBF.minutosATexto(desde)} hasta las ${TurnosBF.minutosATexto(cierre)}.\n\n¿Cuál es el motivo? (tus clientes lo verán)`,
    'Ej: Calamidad, cita médica, sin luz'
  );
  if (motivo === null) return;
  const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const motivoFinal = motivo.trim() || 'Imprevisto';
  try {
    const res = await fetch('/api/admin/bloqueos', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ fecha: ahora.iso, hora: `${hhmm(desde)}-${hhmm(cierre)}`, motivo: motivoFinal })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return avisar(data.message || 'No se pudo cerrar el resto del día.', 'error');
    avisar('Listo: el resto de hoy quedó cerrado para reservas.');
    await ofrecerAvisarCitasAfectadas(data, motivoFinal);
  } catch (err) {
    avisar('Error al conectar con el servidor.', 'error');
  }
  cargarPerfil();
}

// Aviso a mano (sin bot) para las citas que se corrieron
function mostrarAvisoCambioHora(citas) {
  const enlace = c => {
    const tel = String(c.telefonoCliente || '').replace(/\D/g, '');
    const texto = `Hola ${String(c.nombreCliente || '').split(' ')[0]}, te escribimos de ${barberiaActual?.nombre || 'la barbería'}. Tuvimos un ajuste en la agenda y tu cita del ${fechaLarga(c.fecha)} pasó de las ${horaLegible(c.horaAnterior).replace(/\u00a0/g, ' ')} a las ${horaLegible(c.horaNueva).replace(/\u00a0/g, ' ')}. Si no te sirve, avísanos por aquí y buscamos otra hora. ¡Gracias por tu paciencia! 🙏`;
    return `https://wa.me/${tel}?text=${encodeURIComponent(texto)}`;
  };
  const fondo = abrirVentanaPanel(`
    <p class="text-base font-bold text-white">Avisa la nueva hora</p>
    <p class="text-xs text-gray-400 mt-1 leading-relaxed">Tu barbería no tiene el bot de WhatsApp conectado. Toca cada cliente para avisarle con el mensaje ya escrito.</p>
    <div class="mt-4 space-y-2">${citas.map(c => `
      <a href="${escapeHtml(enlace(c))}" target="_blank" rel="noopener"
        class="flex items-center justify-between gap-3 p-3 rounded-2xl bg-emerald-600/10 border border-emerald-500/30 hover:bg-emerald-600/20 transition">
        <span class="min-w-0">
          <span class="block text-sm font-bold text-white truncate">${escapeHtml(c.nombreCliente)}</span>
          <span class="block text-xs text-gray-400">${escapeHtml(horaLegible(c.horaAnterior))} → ${escapeHtml(horaLegible(c.horaNueva))}</span>
        </span>
        <span class="text-xs font-bold text-emerald-300 flex-shrink-0">Escribirle →</span>
      </a>`).join('')}
    </div>
    <button type="button" data-cerrar class="mt-5 w-full py-2.5 rounded-xl text-sm font-bold bg-gray-800 text-gray-200 hover:bg-gray-700">Listo</button>`);
  fondo.querySelector('[data-cerrar]').onclick = () => fondo.remove();
}

// ----- Citas que quedan dentro de un bloqueo (imprevisto, viaje...) -----
// Ventana simple con el estilo del panel; devuelve el elemento de fondo para cerrarla
function abrirVentanaPanel(html) {
  const fondo = document.createElement('div');
  fondo.className = 'fixed inset-0 z-[9998] bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-4';
  fondo.innerHTML = `<div class="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-3xl bg-gray-900 border border-gray-800 p-5 shadow-2xl" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(fondo);
  return fondo;
}

// "miércoles 25 de noviembre"
function fechaLarga(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
}

// El barbero elige a cuáles citas avisar (en una barbería con varios barberos, puede que solo él no atienda)
function elegirCitasParaAvisar(citas, conBot) {
  return new Promise(resolve => {
    const n = citas.length === 1 ? 'una cita' : `${citas.length} citas`;
    const fondo = abrirVentanaPanel(`
      <p class="text-base font-bold text-white">Ese horario tiene ${n}</p>
      <p class="text-xs text-gray-400 mt-1 leading-relaxed">${conBot
        ? 'Las que marques se cancelan y el bot le escribe a cada cliente con el motivo y un enlace para elegir otra hora.'
        : 'Las que marques se cancelan. El bot de WhatsApp no está conectado, así que después te damos un botón para escribirle a cada cliente.'}</p>
      <div class="mt-4 space-y-2">${citas.map(c => `
        <label class="flex items-start gap-3 p-3 rounded-2xl bg-gray-950 border border-gray-800 cursor-pointer">
          <input type="checkbox" checked value="${Number(c.id)}" class="mt-1 w-4 h-4 accent-blue-500 flex-shrink-0">
          <span class="min-w-0">
            <span class="block text-sm font-bold text-white">${escapeHtml(c.nombreCliente)}</span>
            <span class="block text-xs text-gray-400">${escapeHtml(tituloDia(c.fecha))}, ${escapeHtml(horaLegible(c.hora))}${c.servicio ? ` · ${escapeHtml(c.servicio)}` : ''}${c.barbero ? ` · con <b class="text-gray-200">${escapeHtml(c.barbero)}</b>` : ''}</span>
          </span>
        </label>`).join('')}
      </div>
      <div class="grid grid-cols-2 gap-2 mt-5">
        <button type="button" data-no class="py-2.5 rounded-xl text-sm font-bold bg-gray-800 text-gray-200 hover:bg-gray-700">No cancelar</button>
        <button type="button" data-si class="py-2.5 rounded-xl text-sm font-bold bg-red-600 text-white hover:bg-red-500"></button>
      </div>`);
    const boton = fondo.querySelector('[data-si]');
    const marcadas = () => [...fondo.querySelectorAll('input[type=checkbox]:checked')].map(i => Number(i.value));
    const actualizar = () => {
      const k = marcadas().length;
      boton.textContent = k ? `Cancelar y avisar (${k})` : 'Marca al menos una';
      boton.disabled = !k;
      boton.classList.toggle('opacity-50', !k);
    };
    fondo.querySelectorAll('input[type=checkbox]').forEach(i => i.onchange = actualizar);
    actualizar();
    const terminar = valor => { fondo.remove(); resolve(valor); };
    fondo.querySelector('[data-no]').onclick = () => terminar(null);
    boton.onclick = () => terminar(marcadas());
    fondo.onclick = e => { if (e.target === fondo) terminar(null); };
  });
}

// Mensaje listo para enviar desde el WhatsApp del barbero cuando el bot no está conectado
function linkWhatsAppImprevisto(c, motivo) {
  const tel = String(c.telefonoCliente || '').replace(/\D/g, '');
  const conMotivo = motivo && !/^(imprevisto|descanso.*|almuerzo|pausa.*)$/i.test(motivo.replace(/^[^\p{L}\p{N}]+/u, '').trim());
  const texto = `Hola ${String(c.nombreCliente || '').split(' ')[0]}, te escribimos de ${barberiaActual?.nombre || 'la barbería'}. ` +
    `Por un imprevisto${conMotivo ? ` (${motivo})` : ''} no podremos atenderte el ${fechaLarga(c.fecha)} a las ${horaLegible(c.hora).replace(/ /g, ' ')}, ` +
    `así que tu cita quedó cancelada. Disculpa las molestias 🙏 Puedes elegir otro horario aquí: ${location.origin}/index.html?b=${encodeURIComponent(barberiaActual?.slug || '')}`;
  return `https://wa.me/${tel}?text=${encodeURIComponent(texto)}`;
}

function mostrarAvisoManual(clientes, motivo) {
  const fondo = abrirVentanaPanel(`
    <p class="text-base font-bold text-white">Avísales tú por WhatsApp</p>
    <p class="text-xs text-gray-400 mt-1 leading-relaxed">El bot no está conectado en este momento y no pudo escribirles. Toca cada cliente para abrir WhatsApp con el mensaje ya escrito.</p>
    <div class="mt-4 space-y-2">${(clientes || []).map(c => `
      <a href="${escapeHtml(linkWhatsAppImprevisto(c, motivo))}" target="_blank" rel="noopener"
        class="flex items-center justify-between gap-3 p-3 rounded-2xl bg-emerald-600/10 border border-emerald-500/30 hover:bg-emerald-600/20 transition">
        <span class="min-w-0">
          <span class="block text-sm font-bold text-white truncate">${escapeHtml(c.nombreCliente)}</span>
          <span class="block text-xs text-gray-400">${escapeHtml(tituloDia(c.fecha))}, ${escapeHtml(horaLegible(c.hora))}</span>
        </span>
        <span class="text-xs font-bold text-emerald-300 flex-shrink-0">Escribirle →</span>
      </a>`).join('')}
    </div>
    <button type="button" data-cerrar class="mt-5 w-full py-2.5 rounded-xl text-sm font-bold bg-gray-800 text-gray-200 hover:bg-gray-700">Listo</button>`);
  fondo.querySelector('[data-cerrar]').onclick = () => fondo.remove();
}

async function ofrecerAvisarCitasAfectadas(data, motivo) {
  const citas = data?.citasAfectadas || [];
  if (!citas.length) return;
  const ids = await elegirCitasParaAvisar(citas, !!data.avisoPorWhatsApp);
  if (!ids || !ids.length) return;
  try {
    const res = await fetch('/api/admin/citas/avisar-imprevisto', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ citaIds: ids, motivo })
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) return avisar(r.message || 'No se pudo avisar a los clientes.', 'error');
    if (r.avisoPorWhatsApp) {
      avisar(`Listo: se cancelaron ${r.canceladas} cita(s) y el bot les está escribiendo a los clientes.`);
    } else {
      avisar(`Se cancelaron ${r.canceladas} cita(s). Ahora avísales tú por WhatsApp.`, 'info');
      if (r.clientes?.length) mostrarAvisoManual(r.clientes, motivo);
    }
    cargarCitas();
  } catch (err) {
    avisar('Error al conectar con el servidor.', 'error');
  }
}

function alternarCamposBloqueo() {
  const tipo = document.getElementById('bloq-tipo').value;
  const colRango = document.getElementById('col-bloq-rango');
  const colHora = document.getElementById('col-bloq-hora');
  document.getElementById('col-bloq-hasta').classList.toggle('hidden', tipo !== 'dias');
  document.getElementById('col-bloq-varias').classList.toggle('hidden', tipo !== 'varias');
  if (tipo === 'varias') {
    horasSueltasElegidas = new Set();
    pintarHorasSueltas();
    document.getElementById('bloq-fecha').onchange = () => { horasSueltasElegidas = new Set(); pintarHorasSueltas(); };
  }
  document.getElementById('lbl-bloq-fecha').textContent = tipo === 'dias' ? 'Desde' : 'Fecha';

  if (tipo === 'dia' || tipo === 'dias' || tipo === 'varias') {
    colRango.classList.add('hidden');
    colHora.classList.add('hidden');
  } else if (tipo === 'rango') {
    colRango.classList.remove('hidden');
    colHora.classList.add('hidden');
  } else if (tipo === 'hora') {
    colRango.classList.add('hidden');
    colHora.classList.remove('hidden');
  }
}

async function agregarBloqueo(e) {
  e.preventDefault();
  const fecha = document.getElementById('bloq-fecha').value;
  const tipo = document.getElementById('bloq-tipo').value;
  const motivo = document.getElementById('bloq-motivo').value.trim() || 'Descanso';

  let horaString = 'TODO_EL_DIA';
  let fechaHasta = null;

  if (tipo === 'varias') {
    const rangos = rangosDeHorasSueltas();
    if (!rangos.length) return avisar('Toca al menos una hora para cerrarla.', 'error');
    const afectadas = new Map();
    let aviso = null, fallos = 0;
    for (const hora of rangos) {
      try {
        const res = await fetch('/api/admin/bloqueos', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ fecha, hora, motivo }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { fallos++; continue; }
        aviso = data.avisoPorWhatsApp;
        (data.citasAfectadas || []).forEach(c => afectadas.set(c.id, c));
      } catch (err) { fallos++; }
    }
    document.getElementById('bloq-motivo').value = '';
    horasSueltasElegidas = new Set();
    avisar(fallos ? `Se cerraron ${rangos.length - fallos} de ${rangos.length} horas. Revisa e inténtalo de nuevo.` : `¡Listo! Cerraste ${rangos.length === 1 ? 'esa hora' : 'esas horas'} el ${fechaCorta(fecha)}.`, fallos ? 'error' : 'ok');
    await ofrecerAvisarCitasAfectadas({ citasAfectadas: [...afectadas.values()], avisoPorWhatsApp: aviso }, motivo);
    cargarPerfil();
    return;
  } else if (tipo === 'dias') {
    fechaHasta = document.getElementById('bloq-fecha-hasta').value;
    if (!fechaHasta || fechaHasta < fecha) {
      avisar('Elige hasta qué día quieres bloquear (igual o después del primer día).', 'error');
      return;
    }
  } else if (tipo === 'rango') {
    const desde = document.getElementById('bloq-desde').value;
    const hasta = document.getElementById('bloq-hasta').value;
    if (!desde || !hasta) {
      avisar('Por favor selecciona las horas Desde y Hasta.');
      return;
    }
    horaString = `${desde}-${hasta}`;
  } else if (tipo === 'hora') {
    const exacta = document.getElementById('bloq-hora-exacta').value;
    if (!exacta) {
      avisar('Por favor selecciona la hora a bloquear.');
      return;
    }
    horaString = exacta;
  }

  const payload = {
    fecha: fecha,
    fechaHasta: fechaHasta,
    hora: horaString,
    motivo: motivo
  };

  try {
    const res = await fetch('/api/admin/bloqueos', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      document.getElementById('bloq-motivo').value = '';
      avisar(fechaHasta ? `¡Listo! Bloqueaste del ${fechaCorta(fecha)} al ${fechaCorta(fechaHasta)}.` : '¡Horario o día bloqueado con éxito!');
      await ofrecerAvisarCitasAfectadas(data, motivo);
      cargarPerfil();
    } else {
      avisar(data.message || 'No se pudo bloquear.', 'error');
    }
  } catch (err) {
    avisar('Error al registrar bloqueo.');
  }
}

async function eliminarBloqueo(id) { return eliminarBloqueos([id]); }

async function eliminarBloqueos(ids) {
  const texto = ids.length > 1
    ? `¿Quitar este bloqueo de ${ids.length} días? Esos días vuelven a estar disponibles para reservar.`
    : '¿Quitar este bloqueo? Ese horario vuelve a estar disponible para reservar.';
  if (!(await confirmar(texto, { peligro: false, aceptar: 'Sí, quitar' }))) return;
  try {
    await Promise.all(ids.map(id => fetch(`/api/admin/bloqueos/${id}`, { method: 'DELETE', headers: getAuthHeaders() })));
    cargarPerfil();
  } catch (err) {
    avisar('Error al eliminar bloqueo.');
  }
}

// ----------------- AGENDAMIENTO MANUAL (TABLET / LOCAL) -----------------
// Datos públicos de la barbería (citas ocupadas, bloqueos, horario) para mostrar solo horas libres
let agendaManual = { datos: null, horaMin: null };

async function abrirModalCitaManual() {
  const modal = document.getElementById('modal-cita-manual');
  if (!modal) return;

  const servicios = (barberiaActual?.servicios || []).filter(s => s.activo !== false);
  const servSelect = document.getElementById('manual-servicio');
  servSelect.innerHTML = servicios.map(s =>
    `<option value="${s.id}">${escapeHtml(s.nombre)} (${Number(s.precio).toLocaleString('es-CO')} · ${s.duracionMinutos} min)</option>`
  ).join('');

  const barbSelect = document.getElementById('manual-barbero');
  const miembros = (barberiaActual?.miembros || []).filter(m => m.activo !== false);
  barbSelect.innerHTML = (miembros.length > 1 ? '<option value="">Cualquiera (el que esté libre)</option>' : '') +
    miembros.map(m => `<option value="${m.id}">${escapeHtml(m.nombre)}</option>`).join('');

  document.getElementById('manual-fecha').value = TurnosBF.ahoraBogota().iso;
  agendaManual.horaMin = null;
  cerrarOtraHoraManual();
  servSelect.onchange = barbSelect.onchange = () => { agendaManual.horaMin = null; pintarHorasManual(); if (horaManualAbierta()) revisarChoqueManual(); };

  modal.classList.remove('hidden');
  document.getElementById('manual-horas').innerHTML = '<p class="col-span-full text-xs text-gray-500 py-3">Cargando horas libres…</p>';
  try {
    const res = await fetch(`/api/public/barberia/${encodeURIComponent(barberiaActual.slug)}`);
    agendaManual.datos = res.ok ? await res.json() : null;
  } catch (e) { agendaManual.datos = null; }
  pintarDiasManual();
  pintarHorasManual();
}

function servicioManual() {
  const id = Number(document.getElementById('manual-servicio').value);
  return (agendaManual.datos?.servicios || barberiaActual?.servicios || []).find(s => s.id === id) || null;
}

function barberoManual() {
  const v = document.getElementById('manual-barbero').value;
  return v ? Number(v) : null;
}

function pintarDiasManual() {
  const cont = document.getElementById('manual-dias');
  const datos = agendaManual.datos || barberiaActual;
  const hoy = TurnosBF.ahoraBogota().iso;
  const elegido = document.getElementById('manual-fecha').value;
  const dias = Array.from({ length: 30 }, (_, i) => TurnosBF.sumarDias(hoy, i));
  cont.innerHTML = dias.map((iso, i) => {
    const abierto = TurnosBF.diaLaborable(datos, iso);
    const d = new Date(iso + 'T12:00:00Z');
    const nombre = i === 0 ? 'Hoy' : i === 1 ? 'Mañ' : d.toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'short' }).replace('.', '');
    const activo = iso === elegido;
    return `<button type="button" data-fecha="${iso}" ${abierto ? '' : 'disabled'}
      class="flex-shrink-0 w-12 py-1.5 rounded-xl border text-center transition ${activo ? 'bg-blue-600 border-blue-500 text-white' : abierto ? 'bg-gray-950 border-gray-800 text-gray-200 hover:border-gray-600' : 'bg-gray-950/40 border-gray-900 text-gray-600 cursor-not-allowed'}">
      <span class="block text-[10px] uppercase">${nombre}</span>
      <span class="block text-sm font-bold">${d.getUTCDate()}</span>
    </button>`;
  }).join('');
  cont.querySelectorAll('button[data-fecha]').forEach(b => b.onclick = () => {
    document.getElementById('manual-fecha').value = b.dataset.fecha;
    agendaManual.horaMin = null;
    pintarDiasManual();
    pintarHorasManual();
    if (horaManualAbierta()) revisarChoqueManual();
  });
  const t = new Date(elegido + 'T12:00:00Z').toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('manual-dia-texto').textContent = t.charAt(0).toUpperCase() + t.slice(1);
  cont.querySelector('.bg-blue-600')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function pintarHorasManual() {
  const cont = document.getElementById('manual-horas');
  const datos = agendaManual.datos;
  const fecha = document.getElementById('manual-fecha').value;
  if (!datos) {
    cont.innerHTML = '<p class="col-span-full text-xs text-gray-500 py-3">No se pudieron cargar las horas libres. Usa "Poner otra hora a mano".</p>';
    return;
  }
  const cerrado = TurnosBF.diaCerrado(datos, fecha);
  // El barbero puede anotar desde la hora actual (sin la anticipación que se le pide al cliente)
  const turnos = TurnosBF.calcular(datos, servicioManual(), fecha, barberoManual(), { anticipacion: 0 });
  if (!turnos.length) {
    cont.innerHTML = `<p class="col-span-full text-xs text-gray-500 py-3">${cerrado ? `Ese día está cerrado${cerrado.motivo ? ` (${escapeHtml(cerrado.motivo)})` : ''}.` : 'No quedan horas libres ese día con este servicio.'}</p>`;
    return;
  }
  cont.innerHTML = turnos.map(m => `<button type="button" data-min="${m}"
    class="py-2 rounded-lg border text-xs font-semibold transition ${agendaManual.horaMin === m ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-950 border-gray-800 text-gray-200 hover:border-gray-600'}">${TurnosBF.minutosATexto(m)}</button>`).join('');
  cont.querySelectorAll('button[data-min]').forEach(b => b.onclick = () => {
    agendaManual.horaMin = Number(b.dataset.min);
    cerrarOtraHoraManual();
    pintarHorasManual();
  });
}

// ----- Hora a mano: tres listas (hora, minutos, a. m./p. m.) en vez del reloj del navegador -----
function horaManualAbierta() {
  return !document.getElementById('manual-otra-hora').classList.contains('hidden');
}

function leerHoraManual() {
  const h12 = Number(document.getElementById('manual-hora-h').value);
  const m = Number(document.getElementById('manual-hora-m').value);
  const pm = document.getElementById('manual-hora-ap').value === 'pm';
  return (h12 % 12 + (pm ? 12 : 0)) * 60 + m;
}

function fijarHoraManual(minutos) {
  const h = Math.floor(minutos / 60) % 24, m = Math.floor((minutos % 60) / 5) * 5;
  document.getElementById('manual-hora-h').value = String(h % 12 || 12);
  document.getElementById('manual-hora-m').value = String(m).padStart(2, '0');
  document.getElementById('manual-hora-ap').value = h < 12 ? 'am' : 'pm';
  actualizarHoraManual();
}

function actualizarHoraManual() {
  const min = leerHoraManual();
  document.getElementById('manual-hora').value = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  document.getElementById('manual-hora-resumen').textContent = `La cita quedará a las ${TurnosBF.minutosATexto(min)}`;
  revisarChoqueManual();
}

// ¿La hora escrita a mano se cruza con otra cita? Se pregunta al servidor (sabe nombres y duraciones)
let temporizadorChoque = null;
function revisarChoqueManual() {
  clearTimeout(temporizadorChoque);
  agendaManual.simulacion = null;
  temporizadorChoque = setTimeout(simularChoqueManual, 250);
}

async function simularChoqueManual() {
  const caja = document.getElementById('manual-hora-choque');
  if (!horaManualAbierta()) { caja.classList.add('hidden'); return; }
  try {
    const res = await fetch('/api/admin/citas/simular-local', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        fecha: document.getElementById('manual-fecha').value,
        hora: TurnosBF.minutosAValor(leerHoraManual()),
        servicioId: Number(document.getElementById('manual-servicio').value),
        miembroEquipoId: barberoManual()
      })
    });
    if (!res.ok) throw new Error();
    agendaManual.simulacion = await res.json();
    pintarChoqueManual(agendaManual.simulacion);
  } catch (e) {
    caja.classList.add('hidden');
  }
}

function pintarChoqueManual(d) {
  const caja = document.getElementById('manual-hora-choque');
  caja.classList.remove('hidden');
  const nota = (clases, html) => { caja.innerHTML = `<div class="p-2.5 rounded-lg text-[11px] leading-relaxed ${clases}">${html}</div>`; };
  if (!d.choca) return nota('bg-emerald-500/10 border border-emerald-500/25 text-emerald-300', '✓ Esa hora está libre.');
  if (d.todosOcupados) return nota('bg-amber-500/10 border border-amber-500/25 text-amber-200',
    'A esa hora <b>todos los barberos están ocupados</b>. Elige un barbero en la lista de arriba para ver cómo correr sus citas, o escoge otra hora.');
  if (d.bloqueante) return nota('bg-red-500/10 border border-red-500/25 text-red-200',
    `⛔ Se cruza con la cita de <b>${escapeHtml(d.bloqueante.nombreCliente)}</b> a las ${escapeHtml(horaLegible(d.bloqueante.hora))}, que empieza antes y todavía no termina. Elige otra hora.`);
  const primero = (d.conQuien || [])[0];
  const cierre = TurnosBF.aMinutos(d.horaCierre || '20:00');
  const lista = (d.cambios || []).map(c => `<li>• <b>${escapeHtml(c.nombreCliente)}</b>: ${escapeHtml(horaLegible(c.horaAnterior))} → <b class="text-white">${escapeHtml(horaLegible(c.horaNueva))}</b>${TurnosBF.aMinutos(c.horaNueva) >= cierre ? ' <span class="text-red-300">(después del cierre)</span>' : ''}</li>`).join('');
  nota('bg-amber-500/10 border border-amber-500/25 text-amber-100',
    `⚠️ Se cruza con la cita de <b>${escapeHtml(primero?.nombreCliente || '')}</b> a las ${escapeHtml(horaLegible(primero?.hora || ''))}${primero?.barbero ? ` (con ${escapeHtml(primero.barbero)})` : ''}.<br>
    Si la agendas así, <b>se corren estas citas</b> y cada cliente recibe un WhatsApp con su nueva hora:
    <ul class="mt-1 space-y-0.5">${lista}</ul>`);
}

function ponerHoraManualAhora() {
  fijarHoraManual(TurnosBF.ahoraBogota().minutos);
}

function cerrarOtraHoraManual() {
  agendaManual.simulacion = null;
  document.getElementById('manual-hora-choque').classList.add('hidden');
  document.getElementById('manual-otra-hora').classList.add('hidden');
  document.getElementById('manual-otra-hora-btn').classList.remove('hidden');
  document.getElementById('manual-hora').value = '';
}

function alternarOtraHoraManual() {
  document.getElementById('manual-otra-hora').classList.remove('hidden');
  document.getElementById('manual-otra-hora-btn').classList.add('hidden');
  ['manual-hora-h', 'manual-hora-m', 'manual-hora-ap'].forEach(id => document.getElementById(id).onchange = actualizarHoraManual);
  agendaManual.horaMin = null;
  pintarHorasManual();
  // Por defecto, la hora actual (lo más común: el cliente ya está en la silla)
  ponerHoraManualAhora();
}

function cerrarModalCitaManual() {
  const modal = document.getElementById('modal-cita-manual');
  if (modal) modal.classList.add('hidden');
}

async function guardarCitaManual(e) {
  e.preventDefault();
  const nombre = document.getElementById('manual-cliente-nom').value.trim();
  const rawTel = document.getElementById('manual-cliente-tel').value.trim();
  const telefonoLimpio = rawTel.replace(/[^0-9]/g, '');
  const pais = document.getElementById('manual-cliente-pais') ? document.getElementById('manual-cliente-pais').value : '+57';
  const telefonoCompleto = `${pais}${telefonoLimpio}`;

  const servicioId = parseInt(document.getElementById('manual-servicio').value);
  const miembroId = barberoManual();
  const fecha = document.getElementById('manual-fecha').value;
  const rawHora = document.getElementById('manual-hora').value; // "14:30" si la escribió a mano

  // Hora elegida en la lista de horas libres, o escrita a mano
  let minutos = agendaManual.horaMin;
  if (horaManualAbierta() && rawHora) minutos = TurnosBF.aMinutos(rawHora);
  if (minutos == null || !fecha) {
    avisar('Elige el día y una hora libre (o pon la hora a mano).', 'error');
    return;
  }
  const horaFormateada = TurnosBF.minutosAValor(minutos);

  let correrSiguientes = false;
  if (horaManualAbierta()) {
    const sim = agendaManual.simulacion;
    if (sim?.todosOcupados) return avisar('A esa hora todos los barberos están ocupados. Elige un barbero o una hora libre.', 'error');
    if (sim?.bloqueante) return avisar(`Esa hora se cruza con la cita de ${sim.bloqueante.nombreCliente}, que empieza antes. Elige otra hora.`, 'error');
    if (sim?.cambios?.length) {
      const lista = sim.cambios.map(c => `• ${c.nombreCliente}: ${horaLegible(c.horaAnterior)} → ${horaLegible(c.horaNueva)}`).join('\n');
      const ok = await confirmar(`Para atender a ${nombre} a las ${TurnosBF.minutosATexto(minutos)} se corren estas citas:\n${lista}\n\nCada cliente recibe un WhatsApp con su nueva hora y un enlace por si prefiere otra.`,
        { aceptar: 'Correr y agendar', cancelar: 'Volver', peligro: false });
      if (!ok) return;
      correrSiguientes = true;
    }
  }

  const payload = {
    barberiaSlug: barberiaActual.slug,
    servicioId: servicioId,
    miembroEquipoId: miembroId,
    nombreCliente: nombre,
    telefonoCliente: telefonoCompleto,
    fecha: fecha,
    hora: horaFormateada,
    correrSiguientes: correrSiguientes
  };

  const btn = document.getElementById('btn-guardar-manual');
  btn.disabled = true;
  btn.innerText = 'Agendando...';

  try {
    const res = await fetch('/api/public/citas', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok) {
      const resumenCita = `${nombre}: ${tituloDia(fecha)} a las ${TurnosBF.minutosATexto(minutos)}${data.barberoNombre ? ` con ${data.barberoNombre}` : ''}` +
        (data.citasCorridas?.length ? `. Se corrieron ${data.citasCorridas.length} cita(s)` : '');
      // Sin bot: el barbero avisa a mano a quienes se les corrió la cita
      if (data.citasCorridas?.length && !data.avisoPorWhatsApp) mostrarAvisoCambioHora(data.citasCorridas);
      if (data.avisoPorWhatsApp) {
        avisar(`¡Cita agendada para ${resumenCita}! El cliente recibe la confirmación por WhatsApp.`);
      } else {
        avisar(`¡Cita agendada para ${resumenCita}!`);
        // Sin bot para esta barbería: enviarla desde el WhatsApp del barbero
        const texto = `Hola ${nombre.split(' ')[0]}, tu cita en ${barberiaActual.nombre} quedó agendada: ${fechaLarga(fecha)} a las ${TurnosBF.minutosATexto(minutos)}${data.barberoNombre ? ` con ${data.barberoNombre}` : ''}. Código: ${data.codigoReserva}. ¡Te esperamos!`;
        if (await confirmar('Tu barbería no tiene el bot de WhatsApp conectado. ¿Quieres enviarle la confirmación al cliente desde tu WhatsApp?', { aceptar: 'Abrir WhatsApp', cancelar: 'No', peligro: false })) {
          window.open(`https://wa.me/${pais.replace('+', '')}${telefonoLimpio}?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
        }
      }
      cerrarModalCitaManual();
      document.getElementById('form-cita-manual').reset();
      cargarCitas();
    } else {
      avisar(data.message || 'No se pudo agendar la cita.');
    }
  } catch (err) {
    avisar('Error conectando con el servidor.');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Confirmar y Agendar';
  }
}

// Cambiar la contraseña del panel (con la sesión abierta)
async function cambiarClaveBarbero(e) {
  e.preventDefault();
  const actual = document.getElementById('clave-actual').value;
  const nueva = document.getElementById('clave-nueva').value;
  if (nueva.length < 6) return avisar('La contraseña nueva debe tener al menos 6 caracteres.', 'error');
  if (nueva !== document.getElementById('clave-repetir').value) return avisar('Las dos contraseñas nuevas no coinciden.', 'error');
  const boton = document.getElementById('btn-cambiar-clave');
  boton.disabled = true;
  try {
    const res = await fetch('/api/auth/cambiar-clave', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ claveActual: actual, nuevaClave: nueva }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return avisar(data.message || 'No se pudo cambiar la contraseña.', 'error');
    document.getElementById('form-cambiar-clave').reset();
    avisar('¡Listo! Tu contraseña quedó cambiada.');
  } catch (err) {
    avisar('Error al conectar con el servidor.', 'error');
  } finally {
    boton.disabled = false;
  }
}

async function limpiarDatosPrueba() {
  if (!(await confirmar('⚠️ ¿Deseas limpiar todas las citas y bloqueos de prueba?\n\nTus servicios, precios y barberos permanecerán intactos, pero las estadísticas volverán a $0 para arrancar el lanzamiento oficial.'))) {
    return;
  }

  try {
    const res = await fetch('/api/admin/limpiar-datos-prueba', {
      method: 'POST',
      headers: getAuthHeaders()
    });
    const data = await res.json();
    if (res.ok) {
      avisar(data.message);
      cargarCitas();
      cargarPerfil();
    } else {
      avisar('No se pudo limpiar los datos.');
    }
  } catch (err) {
    avisar('Error al conectar con el servidor.');
  }
}

function mostrarSeccion(sec) {
  document.getElementById('sec-citas').classList.add('hidden');
  document.getElementById('sec-perfil').classList.add('hidden');
  document.getElementById('sec-horarios').classList.add('hidden');
  const secBot = document.getElementById('sec-bot');
  if (secBot) secBot.classList.add('hidden');

  const TAB_ACTIVA = 'py-2 px-2 sm:px-4 rounded-xl font-bold bg-blue-600 text-white transition flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 text-[11px] sm:text-sm';
  const TAB_INACTIVA = 'py-2 px-2 sm:px-4 rounded-xl font-semibold bg-gray-900/70 border border-gray-800 text-gray-400 hover:text-white transition flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 text-[11px] sm:text-sm';
  ['citas', 'perfil', 'horarios', 'bot'].forEach(t => {
    const b = document.getElementById(`tab-btn-${t}`);
    if (b) b.className = t === sec ? TAB_ACTIVA : TAB_INACTIVA;
  });
  const tabBot = document.getElementById('tab-btn-bot');

  if (sec === 'citas') {
    document.getElementById('sec-citas').classList.remove('hidden');

  } else if (sec === 'perfil') {
    document.getElementById('sec-perfil').classList.remove('hidden');

  } else if (sec === 'horarios') {
    document.getElementById('sec-horarios').classList.remove('hidden');

  } else if (sec === 'bot') {
    if (secBot) secBot.classList.remove('hidden');

  }
}

// FUNCIONES DEL BOT DE WHATSAPP
// El interruptor "Estado" se guarda al momento (no hace falta el botón Guardar)
async function cambiarEstadoBot(chk) {
  const activo = chk.checked;
  chk.disabled = true;
  try {
    const res = await fetch('/api/admin/bot/activo', { method: 'PUT', headers: getAuthHeaders(), body: JSON.stringify({ activo }) });
    if (!res.ok) throw new Error();
    barberiaActual.botActivo = activo;
    avisar(activo ? 'Bot encendido: vuelve a responder a tus clientes.' : 'Bot apagado: no responderá mensajes hasta que lo vuelvas a encender.', activo ? 'ok' : 'info');
  } catch (e) {
    chk.checked = !activo;
    avisar('No se pudo cambiar el estado del bot. Intenta de nuevo.', 'error');
  } finally {
    chk.disabled = false;
  }
}

async function guardarConfiguracionBot() {
  const recordar = document.getElementById('conf-recordatorios-activos');
  if (recordar?.checked && !document.querySelector('input[name="horas-recordatorio"]:checked')) {
    avisar('Elige al menos un momento para el recordatorio (por ejemplo "1 día antes"), o apaga los recordatorios.', 'error');
    return;
  }
  const payload = {
    nombre: barberiaActual.nombre,
    descripcion: barberiaActual.descripcion,
    direccion: barberiaActual.direccion,
    telefonoWhatsApp: barberiaActual.telefonoWhatsApp,
    horarioTexto: barberiaActual.horarioTexto,
    logoUrl: barberiaActual.logoUrl,
    horaApertura: barberiaActual.horaApertura,
    horaCierre: barberiaActual.horaCierre,
    intervaloMinutos: barberiaActual.intervaloMinutos,
    diasLaborales: barberiaActual.diasLaborales,
    mostrarSelectorBarbero: barberiaActual.mostrarSelectorBarbero,
    datosPago: document.getElementById('conf-bot-datospago')?.value || '',
    numeroNequi: document.getElementById('conf-bot-nequi')?.value || '',
    numeroDaviplata: document.getElementById('conf-bot-daviplata')?.value || '',
    titularCuenta: document.getElementById('conf-bot-titular')?.value || '',
    botActivo: document.getElementById('conf-bot-activo').checked,
    mensajeBienvenidaBot: document.getElementById('conf-bot-bienvenida').value,
    mensajeDerivacionHumana: document.getElementById('conf-bot-derivacion').value,
    plantillaConfirmacion: document.getElementById('conf-bot-confirmacion').value,
    plantillaRecordatorio: document.getElementById('conf-bot-recordatorio').value,
    recordatoriosActivos: document.getElementById('conf-recordatorios-activos')?.checked !== false,
    horasRecordatorios: [...document.querySelectorAll('input[name="horas-recordatorio"]:checked')].map(c => c.value).join(',') || undefined,
    pedirOpinionActivo: document.getElementById('conf-pedir-opinion')?.checked !== false,
    minutosPausaBot: parseInt(document.getElementById('conf-pausa-bot')?.value || '120'),
    anuncioMatutinoActivo: document.getElementById('conf-anuncio-activo')?.checked !== false,
    horaAnuncioSemana: document.getElementById('conf-anuncio-semana')?.value || '08:00',
    horaAnuncioSabado: document.getElementById('conf-anuncio-sabado')?.value || '08:00',
    horaAnuncioDomingo: document.getElementById('conf-anuncio-domingo')?.value || '09:00'
  };

  try {
    const res = await fetch('/api/admin/perfil', {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      avisar('¡Configuración y plantillas del Bot guardadas con éxito!');
      cargarPerfil();
    } else {
      avisar('Error guardando configuración del bot.');
    }
  } catch (err) {
    avisar('Error al conectar con el servidor.');
  }
}

// ----- Chat de prueba del bot -----
// Texto de WhatsApp a HTML seguro: *negrita*, _cursiva_, enlaces y saltos de línea
function textoWhatsAppAHtml(texto) {
  return escapeHtml(texto)
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/(^|\s)_([^_\n]+)_/g, '$1<i>$2</i>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" class="underline text-emerald-300 break-all">$1</a>');
}

function agregarBurbujaChat(texto, deCliente, tipo = '') {
  const cont = document.getElementById('chat-prueba-mensajes');
  const fila = document.createElement('div');
  fila.className = `flex ${deCliente ? 'justify-end' : 'justify-start'}`;
  const burbuja = document.createElement('div');
  burbuja.className = `max-w-[85%] px-3 py-2 rounded-2xl whitespace-pre-line break-words text-[13px] leading-snug ${
    tipo === 'nota' ? 'bg-transparent text-gray-500 italic text-xs'
    : deCliente ? 'bg-emerald-700 text-white rounded-br-md' : 'bg-gray-800 text-gray-100 rounded-bl-md'}`;
  burbuja.innerHTML = textoWhatsAppAHtml(texto);
  fila.appendChild(burbuja);
  cont.appendChild(fila);
  cont.scrollTop = cont.scrollHeight;
  return fila;
}

function pintarInicioChatPrueba() {
  const cont = document.getElementById('chat-prueba-mensajes');
  if (!cont) return;
  cont.innerHTML = '';
  agregarBurbujaChat('Escribe un mensaje o toca una sugerencia para ver cómo responde tu bot.', false, 'nota');
}

let chatPruebaReiniciar = true;
async function enviarTextoChatPrueba(texto) {
  texto = (texto || '').trim();
  if (!texto) return;
  const boton = document.getElementById('chat-prueba-enviar');
  const cont = document.getElementById('chat-prueba-mensajes');
  if (cont.querySelector('.italic') && cont.children.length === 1) cont.innerHTML = '';
  agregarBurbujaChat(texto, true);
  const escribiendo = agregarBurbujaChat('escribiendo…', false, 'nota');
  boton.disabled = true;
  try {
    const res = await fetch('/api/admin/bot/probar', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ texto, reiniciar: chatPruebaReiniciar })
    });
    const data = await res.json().catch(() => ({}));
    escribiendo.remove();
    if (!res.ok) {
      agregarBurbujaChat(data.message || 'No se pudo probar el bot en este momento.', false, 'nota');
      return;
    }
    chatPruebaReiniciar = false;
    if (data.botActivo === false) agregarBurbujaChat('El bot está apagado (interruptor "Estado" arriba): a los clientes no les respondería nada.', false, 'nota');
    else if (!data.respuestas?.length) agregarBurbujaChat('(El bot no respondería a este mensaje: lo toma como una reacción como "ok" o "gracias", o ya avisó que el barbero contestará.)', false, 'nota');
    (data.respuestas || []).forEach(r => agregarBurbujaChat(r, false));
  } catch (err) {
    escribiendo.remove();
    agregarBurbujaChat('No se pudo conectar con el servidor.', false, 'nota');
  } finally {
    boton.disabled = false;
  }
}

function enviarChatPrueba(e) {
  e.preventDefault();
  const input = document.getElementById('chat-prueba-texto');
  const texto = input.value;
  input.value = '';
  enviarTextoChatPrueba(texto);
  input.focus();
}

function reiniciarChatPrueba() {
  chatPruebaReiniciar = true;
  pintarInicioChatPrueba();
}

document.addEventListener('DOMContentLoaded', () => {
  pintarInicioChatPrueba();
  document.querySelectorAll('#chat-prueba-sugerencias button').forEach(b => b.onclick = () => enviarTextoChatPrueba(b.dataset.texto));
});

function renderListaReglasBot(reglas) {
  const container = document.getElementById('lista-reglas-bot');
  if (!container) return;
  container.innerHTML = '';

  if (!reglas || reglas.length === 0) {
    container.innerHTML = `<p class="text-xs text-gray-500 italic py-2">No has agregado respuestas personalizadas aún. ¡Crea la primera arriba para parqueadero, pagos, etc.!</p>`;
    return;
  }

  reglas.forEach(r => {
    const div = document.createElement('div');
    div.className = 'p-3 bg-gray-950 border border-gray-800 rounded-xl flex items-start justify-between gap-3';
    div.innerHTML = `
      <div class="flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
            Palabras: ${escapeHtml(r.palabrasClave)}
          </span>
        </div>
        <p class="text-xs text-gray-200 mt-1 leading-relaxed">
          <strong class="text-emerald-400">Respuesta:</strong> ${escapeHtml(r.respuesta)}
        </p>
      </div>
      <button onclick="eliminarReglaBot(${r.id})" class="text-xs px-2.5 py-1.5 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 flex items-center gap-1 transition">
        <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
      </button>
    `;
    container.appendChild(div);
  });
  lucide.createIcons();
}

async function crearReglaBot(e) {
  e.preventDefault();
  const claves = document.getElementById('regla-claves').value.trim();
  const respuesta = document.getElementById('regla-respuesta').value.trim();

  if (!claves || !respuesta) {
    avisar('Por favor completa las palabras clave y la respuesta.');
    return;
  }

  try {
    const res = await fetch('/api/admin/bot/reglas', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ palabrasClave: claves, respuesta: respuesta })
    });

    if (res.ok) {
      document.getElementById('regla-claves').value = '';
      document.getElementById('regla-respuesta').value = '';
      cargarPerfil();
    } else {
      avisar('Error creando regla.');
    }
  } catch (err) {
    avisar('Error al conectar con el servidor.');
  }
}

async function eliminarReglaBot(id) {
  if (!(await confirmar('¿Deseas eliminar esta regla de respuesta?'))) return;
  try {
    const res = await fetch(`/api/admin/bot/reglas/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (res.ok) cargarPerfil();
  } catch (err) {
    avisar('Error eliminando regla.');
  }
}

let intervalPollBot = null;

async function abrirModalVincularWhatsApp() {
  const modal = document.getElementById('modal-vincular-whatsapp');
  if (!modal) return;

  const contenedorQr = modal.querySelector('.bg-white');
  contenedorQr.innerHTML = `
    <div id="box-qr-dinamico" class="flex flex-col items-center justify-center p-4">
      <div class="text-xs text-gray-500 font-semibold mb-2" id="txt-estado-qr">Cargando código QR...</div>
      <img id="img-qr-live" class="w-[220px] h-[220px] rounded-lg hidden" alt="QR WhatsApp">
      <div id="loader-qr" class="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin my-8"></div>
    </div>
  `;

  modal.classList.remove('hidden');

  async function consultarEstadoBot() {
    try {
      // El estado y el QR se piden a la API (autenticada); el navegador nunca habla directo con el bot
      const res = await fetch('/api/admin/bot/estado', { headers: getAuthHeaders() });
      if (!res.ok) {
        const txtErr = document.getElementById('txt-estado-qr');
        const loaderErr = document.getElementById('loader-qr');
        let msg = 'Conectando con el servicio de WhatsApp...';
        try { msg = (await res.json()).message || msg; } catch (e) {}
        if (txtErr) txtErr.innerText = msg;
        if (res.status === 403 || res.status === 409 || res.status === 503) {
          if (loaderErr) loaderErr.classList.add('hidden');
          clearInterval(intervalPollBot);
        }
        return;
      }
      const data = await res.json();

      const txt = document.getElementById('txt-estado-qr');
      const img = document.getElementById('img-qr-live');
      const loader = document.getElementById('loader-qr');

      if (data.conectado) {
        if (txt) txt.innerHTML = `<span class="text-emerald-600 font-bold text-sm">✅ ¡WhatsApp Vinculado Exitosamente!</span>`;
        if (img) img.classList.add('hidden');
        if (loader) loader.classList.add('hidden');
        clearInterval(intervalPollBot);
        return;
      }

      if (data.qr && data.qr.startsWith('data:image')) {
        if (img) {
          img.src = data.qr;
          img.classList.remove('hidden');
        }
        if (loader) loader.classList.add('hidden');
        if (txt) txt.innerText = data.estado || 'Apunta con la cámara de WhatsApp';
      }
    } catch (err) {
      const txt = document.getElementById('txt-estado-qr');
      if (txt) txt.innerText = 'Conectando con el servicio de WhatsApp...';
    }
  }

  consultarEstadoBot();
  if (intervalPollBot) clearInterval(intervalPollBot);
  intervalPollBot = setInterval(consultarEstadoBot, 3000);
}

async function desvincularWhatsApp() {
  if (!(await confirmar('¿Desvincular el WhatsApp conectado al bot? Tendrás que escanear un QR nuevo con el celular que quieras usar.'))) return;
  try {
    const res = await fetch('/api/admin/bot/reiniciar', { method: 'POST', headers: getAuthHeaders() });
    const data = await res.json().catch(() => ({}));
    avisar(data.message || (res.ok ? 'Listo. Espera el QR nuevo.' : 'No se pudo desvincular.'));
    if (res.ok) abrirModalVincularWhatsApp();
  } catch (e) {
    avisar('No se pudo conectar con el servidor.');
  }
}

// ================== Lista de espera ==================
let listaEsperaDatos = [];

async function cargarListaEspera() {
  try {
    const res = await fetch('/api/admin/lista-espera', { headers: getAuthHeaders() });
    if (!res.ok) return;
    listaEsperaDatos = await res.json();
    pintarListaEspera();
  } catch (e) { /* sin conexión: se intenta en la próxima recarga */ }
}

function pintarListaEspera() {
  const tarjeta = document.getElementById('tarjeta-espera');
  if (!tarjeta) return;
  tarjeta.classList.toggle('hidden', !listaEsperaDatos.length);
  document.getElementById('espera-total').textContent = listaEsperaDatos.length;
  document.getElementById('lista-espera').innerHTML = listaEsperaDatos.map(l => {
    const tel = String(l.telefonoCliente || '').replace(/\D/g, '');
    const texto = encodeURIComponent(`¡Hola ${String(l.nombreCliente).split(' ')[0]}! Te escribimos de ${barberiaActual?.nombre || 'la barbería'}: se liberó un turno el ${fechaCorta(l.fecha)}. ¿Lo quieres?`);
    return `<div class="p-3 rounded-xl bg-gray-950/60 border border-gray-800 flex items-center gap-2.5">
      <div class="min-w-0 flex-1">
        <p class="text-sm font-bold text-white truncate">${escapeHtml(l.nombreCliente)}</p>
        <p class="text-[11px] text-gray-400">${escapeHtml(fechaCorta(l.fecha))} · ${escapeHtml(l.franjaTexto)} · ${escapeHtml(l.servicio)}${l.barbero ? ' · con ' + escapeHtml(l.barbero) : ''}</p>
        ${l.estado === 'Avisado' ? '<p class="text-[11px] text-emerald-300 mt-0.5">✓ Ya le avisamos que se liberó un turno</p>' : ''}
      </div>
      <a href="https://wa.me/${tel}?text=${texto}" target="_blank" rel="noopener" class="h-9 px-3 rounded-xl text-xs font-bold bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 flex items-center flex-shrink-0">WhatsApp</a>
      <button type="button" onclick="quitarDeListaEspera(${l.id})" title="Quitar de la lista" class="h-9 w-9 rounded-xl text-gray-500 hover:text-red-300 hover:bg-red-500/10 flex items-center justify-center flex-shrink-0"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>`;
  }).join('');
  lucide.createIcons();
}

function alternarListaEspera() {
  const lista = document.getElementById('lista-espera');
  lista.classList.toggle('hidden');
  document.getElementById('btn-ver-espera').textContent = lista.classList.contains('hidden') ? 'Ver' : 'Ocultar';
}

async function quitarDeListaEspera(id) {
  if (!(await confirmar('¿Quitar a esta persona de la lista de espera?'))) return;
  try {
    const res = await fetch(`/api/admin/lista-espera/${id}`, { method: 'DELETE', headers: getAuthHeaders() });
    const data = await res.json().catch(() => ({}));
    avisar(data.message || (res.ok ? 'Quitado.' : 'No se pudo quitar.'), res.ok ? 'ok' : 'error');
  } catch (e) {
    avisar('No se pudo conectar con el servidor.', 'error');
  }
  cargarListaEspera();
}

function cerrarModalVincularWhatsApp() {
  const modal = document.getElementById('modal-vincular-whatsapp');
  if (modal) modal.classList.add('hidden');
  if (intervalPollBot) clearInterval(intervalPollBot);
}

async function eliminarBarberiaCompleta() {
  if (!(await confirmar('⚠️ ¿Estás SEGURO de eliminar por completo tu barbería y tu cuenta?\n\nEsta acción borrará todas tus citas, servicios y configuración permanentemente.'))) {
    return;
  }
  const confirmacion = await pedirTexto("Para confirmar definitivamente, escribe ELIMINAR:", "ELIMINAR");
  if (confirmacion !== 'ELIMINAR') {
    avisar('Operación cancelada. No se eliminó la barbería.');
    return;
  }

  try {
    const res = await fetch('/api/admin/eliminar-barberia', {
      method: 'DELETE',
      headers: getAuthHeaders()
    });

    if (res.ok) {
      avisar('Tu barbería y cuenta han sido eliminadas correctamente.');
      localStorage.removeItem('bf_token');
      localStorage.removeItem('bf_user');
      window.location.href = '/login.html';
    } else {
      const data = await res.json();
      avisar(data.message || 'Error al eliminar la barbería.');
    }
  } catch (err) {
    avisar('Error al conectar con el servidor.');
  }
}

// ----- Instalar el panel como app (PWA) -----
let promptInstalarApp = null;

function esAppInstalada() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function esIPhone() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
function esCelular() { return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent); }

function mostrarTarjetaInstalar() {
  let oculta = false;
  try { oculta = localStorage.getItem('bf_ocultar_instalar') === '1'; } catch (e) {}
  const tarjeta = document.getElementById('tarjeta-instalar');
  if (!tarjeta || esAppInstalada() || oculta || !esCelular()) return;
  tarjeta.classList.remove('hidden');
  tarjeta.classList.add('flex');
}

function ocultarTarjetaInstalar() {
  try { localStorage.setItem('bf_ocultar_instalar', '1'); } catch (e) {}
  const tarjeta = document.getElementById('tarjeta-instalar');
  if (tarjeta) { tarjeta.classList.add('hidden'); tarjeta.classList.remove('flex'); }
}

async function instalarApp() {
  if (promptInstalarApp) {
    promptInstalarApp.prompt();
    const { outcome } = await promptInstalarApp.userChoice;
    promptInstalarApp = null;
    if (outcome === 'accepted') ocultarTarjetaInstalar();
    return;
  }
  // Sin instalación automática (iPhone, o el navegador no la ofreció): guía paso a paso
  const pasos = esIPhone()
    ? ['Abre esta página en <b>Safari</b>.', 'Toca el botón <b>Compartir</b> <span class="inline-block px-1.5 rounded bg-gray-800">⬆️</span> (abajo en la pantalla).', 'Elige <b>"Agregar a inicio"</b> y toca <b>Agregar</b>.', 'Listo: verás el ícono <b>Mi Barbería</b> en tu pantalla.']
    : ['Abre esta página en <b>Google Chrome</b>.', 'Toca el menú <span class="inline-block px-1.5 rounded bg-gray-800">⋮</span> (arriba a la derecha).', 'Elige <b>"Instalar aplicación"</b> o <b>"Agregar a la pantalla principal"</b>.', 'Listo: verás el ícono <b>Mi Barbería</b> en tu pantalla.'];
  document.getElementById('pasos-instalar').innerHTML = pasos.map((p, i) =>
    `<li class="flex gap-3"><span class="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">${i + 1}</span><span>${p}</span></li>`).join('');
  document.getElementById('modal-instalar').classList.remove('hidden');
}

function cerrarGuiaInstalar() { document.getElementById('modal-instalar').classList.add('hidden'); }

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  promptInstalarApp = e;
  mostrarTarjetaInstalar();
});
window.addEventListener('appinstalled', ocultarTarjetaInstalar);
window.addEventListener('DOMContentLoaded', mostrarTarjetaInstalar);

function cerrarSesion() {
  localStorage.removeItem('bf_token');
  localStorage.removeItem('bf_user');
  window.location.href = '/login.html';
}

window.addEventListener('DOMContentLoaded', initAdmin);
