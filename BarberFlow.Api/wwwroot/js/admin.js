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

    // Horarios laborales base
    document.getElementById('conf-hora-apertura').value = barberiaActual.horaApertura || '09:00';
    document.getElementById('conf-hora-cierre').value = barberiaActual.horaCierre || '20:00';
    document.getElementById('conf-intervalo').value = (barberiaActual.intervaloMinutos || 40).toString();
    const selAnticipacion = document.getElementById('conf-anticipacion');
    if (selAnticipacion) selAnticipacion.value = String(barberiaActual.minutosAnticipacion ?? 30);

    // Días laborales
    const dias = (barberiaActual.diasLaborales || "1,2,3,4,5,6").split(',');
    [0, 1, 2, 3, 4, 5, 6].forEach(d => {
      const chk = document.getElementById(`dia-${d}`);
      if (chk) chk.checked = dias.includes(d.toString());
    });

    renderListaServicios(barberiaActual.servicios || []);
    renderListaMiembros(barberiaActual.miembros || []);
    renderListaBloqueos(barberiaActual.bloqueos || []);

    // Cargar datos de Bot de WhatsApp
    const chkBot = document.getElementById('conf-bot-activo');
    if (chkBot) chkBot.checked = barberiaActual.botActivo !== false;

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

// Función utilitaria para optimizar y comprimir imágenes antes de guardarlas (máx 500x500 y calidad 0.8)
function comprimirImagen(file, maxWidth = 500, maxHeight = 500, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Exportar como JPEG comprimido
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl);
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
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
  prev.style.background = fondoPortada(actual, color);
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

function hexARgbAdmin(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [37, 99, 235];
}

async function subirPortadaBarberia(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    barberiaActual.portadaUrl = await comprimirImagen(file, 1400, 600, 0.72);
    pintarPreviewPortada();
    alert('Portada lista. Haz clic en "Guardar Cambios de la Barbería" para publicarla.');
  } catch (err) {
    alert('No se pudo procesar la imagen de portada.');
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
    const base64Optimizado = await comprimirImagen(file, 600, 600, 0.82);
    document.getElementById('preview-logo-barberia').src = base64Optimizado;
    document.getElementById('conf-logo').value = base64Optimizado;
    barberiaActual.logoUrl = base64Optimizado;
    document.getElementById('admin-barberia-logo').src = base64Optimizado;
    alert('Foto optimizada y cargada. Haz clic en "Guardar Información de la Barbería" para guardarla permanentemente.');
  } catch (err) {
    alert('Error al procesar la imagen de la barbería.');
  }
}

let tempMiembroFotoUrl = '';
let tempEditMiembroFotoUrl = '';
async function subirFotoMiembro(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const base64Optimizado = await comprimirImagen(file, 400, 400, 0.8);
    document.getElementById('preview-foto-miembro').src = base64Optimizado;
    tempMiembroFotoUrl = base64Optimizado;
    alert('Foto del barbero cargada.');
  } catch (err) {
    alert('Error al cargar la foto del barbero.');
  }
}

async function subirFotoMiembroEdicion(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const base64Optimizado = await comprimirImagen(file, 400, 400, 0.8);
    document.getElementById('edit-preview-foto-miembro').src = base64Optimizado;
    tempEditMiembroFotoUrl = base64Optimizado;
  } catch (err) {
    alert('Error al cargar la foto.');
  }
}

async function cargarCitas(filtroParams = '') {
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
    alert('Por favor selecciona fecha de inicio y fecha de fin.');
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

  if (!deHoy.length) {
    detalle.textContent = 'No tienes más citas hoy.';
  } else {
    detalle.innerHTML = `${deHoy.length} cita${deHoy.length === 1 ? '' : 's'} pendiente${deHoy.length === 1 ? '' : 's'}` +
      (siguiente ? ` · próxima <strong class="text-white">${horaLegible(siguiente.hora)}</strong> con ${escapeHtml(siguiente.nombreCliente.split(' ')[0])}` : '') +
      (porConfirmar ? ` · <span class="text-amber-300">${porConfirmar} por confirmar</span>` : '');
  }
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
    alert('Error al completar cita.');
  }
}

async function eliminarOMoverNoConfirmada(id) {
  if (!confirm('¿El cliente no vino o quieres quitar esta cita de la agenda? Se moverá a "No confirmadas".')) return;
  try {
    const res = await fetch(`/api/admin/citas/${id}?marcarNoConfirmada=true`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (res.ok) cargarCitas();
  } catch (err) {
    alert('Error al actualizar cita.');
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
    alert('Error al reactivar cita.');
  }
}

async function eliminarPermanente(id) {
  if (!confirm('¿Seguro que deseas eliminar definitivamente esta cita?')) return;
  try {
    const res = await fetch(`/api/admin/citas/${id}?marcarNoConfirmada=false`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (res.ok) cargarCitas();
  } catch (err) {
    alert('Error al eliminar.');
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
    datalist.innerHTML = Array.from(cats).map(c => `<option value="${c}">`).join('');
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
          <h5 class="font-bold text-white text-sm">${s.nombre}</h5>
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
          <h5 class="font-bold text-white text-sm">${m.nombre}</h5>
          <p class="text-xs text-gray-400">${m.rol}</p>
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

function renderListaBloqueos(bloqueos) {
  const container = document.getElementById('lista-bloqueos');
  container.innerHTML = '';

  if (!bloqueos || bloqueos.length === 0) {
    container.innerHTML = `<p class="text-xs text-gray-500 italic">No tienes ningún día ni horario bloqueado actualmente.</p>`;
    return;
  }

  bloqueos.forEach(b => {
    const esDiaCompleto = !b.hora || b.hora === 'TODO_EL_DIA';
    const div = document.createElement('div');
    div.className = 'p-3 rounded-xl bg-gray-950 border border-gray-800 flex items-center justify-between';
    div.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="w-8 h-8 rounded-lg ${esDiaCompleto ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'} flex items-center justify-center text-xs font-bold">
          ${esDiaCompleto ? 'DÍA' : 'HR'}
        </span>
        <div>
          <div class="text-sm font-bold text-white">
            ${b.fecha} ${esDiaCompleto ? '• (Día completo libre)' : `• ${b.hora}`}
          </div>
          <p class="text-xs text-gray-400">${b.motivo || 'No disponible'}</p>
        </div>
      </div>
      <button onclick="eliminarBloqueo(${b.id})" class="text-red-400 hover:text-red-300 text-xs px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20">
        Habilitar Horario
      </button>
    `;
    container.appendChild(div);
  });
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
      alert('¡Información de la barbería actualizada!');
      cargarPerfil();
    }
  } catch (err) {
    alert('Error al guardar cambios.');
  }
}

async function guardarHorariosBase(e) {
  e.preventDefault();

  const diasSeleccionados = [];
  [0, 1, 2, 3, 4, 5, 6].forEach(d => {
    const chk = document.getElementById(`dia-${d}`);
    if (chk && chk.checked) diasSeleccionados.push(d);
  });

  const payload = {
    nombre: barberiaActual.nombre,
    telefonoWhatsApp: barberiaActual.telefonoWhatsApp,
    direccion: barberiaActual.direccion,
    horarioTexto: barberiaActual.horarioTexto,
    descripcion: barberiaActual.descripcion,
    logoUrl: barberiaActual.logoUrl,
    mostrarSelectorBarbero: barberiaActual.mostrarSelectorBarbero,
    horaApertura: document.getElementById('conf-hora-apertura').value,
    horaCierre: document.getElementById('conf-hora-cierre').value,
    intervaloMinutos: parseInt(document.getElementById('conf-intervalo').value),
    minutosAnticipacion: parseInt(document.getElementById('conf-anticipacion')?.value ?? '30'),
    diasLaborales: diasSeleccionados.join(',')
  };

  try {
    const res = await fetch('/api/admin/perfil', {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      alert('¡Horario laboral actualizado con éxito!');
      cargarPerfil();
    }
  } catch (err) {
    alert('Error al guardar horarios.');
  }
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
    }
  } catch (err) {
    alert('Error agregando servicio.');
  }
}

async function eliminarServicio(id) {
  if (!confirm('¿Seguro que deseas eliminar este servicio?')) return;
  try {
    await fetch(`/api/admin/servicios/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    cargarPerfil();
  } catch (err) {
    alert('Error eliminando servicio.');
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
      alert(data.message || 'Error al actualizar el servicio.');
    }
  } catch (err) {
    alert('Error al conectar con el servidor.');
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
    }
  } catch (err) {
    alert('Error agregando barbero.');
  }
}

async function eliminarMiembro(id) {
  if (!confirm('¿Seguro que deseas eliminar este barbero?')) return;
  try {
    await fetch(`/api/admin/miembros/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    cargarPerfil();
  } catch (err) {
    alert('Error eliminando barbero.');
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
      alert('No se pudo guardar la edición del miembro.');
    }
  } catch (err) {
    alert('Error al conectar con el servidor.');
  }
}

async function bloquearPausaRapida(tipo) {
  const ahora = new Date();
  const anio = ahora.getFullYear();
  const mes = String(ahora.getMonth() + 1).padStart(2, '0');
  const dia = String(ahora.getDate()).padStart(2, '0');
  const hoyIso = `${anio}-${mes}-${dia}`;

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
      await fetch('/api/admin/bloqueos', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ fecha: hoyIso, hora: h, motivo: motivo })
      });
    } catch (err) {}
  }

  alert(`¡${motivo} bloqueado para hoy con éxito!`);
  cargarPerfil();
}

function alternarCamposBloqueo() {
  const tipo = document.getElementById('bloq-tipo').value;
  const colRango = document.getElementById('col-bloq-rango');
  const colHora = document.getElementById('col-bloq-hora');

  if (tipo === 'dia') {
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

  if (tipo === 'rango') {
    const desde = document.getElementById('bloq-desde').value;
    const hasta = document.getElementById('bloq-hasta').value;
    if (!desde || !hasta) {
      alert('Por favor selecciona las horas Desde y Hasta.');
      return;
    }
    horaString = `${desde}-${hasta}`;
  } else if (tipo === 'hora') {
    const exacta = document.getElementById('bloq-hora-exacta').value;
    if (!exacta) {
      alert('Por favor selecciona la hora a bloquear.');
      return;
    }
    horaString = exacta;
  }

  const payload = {
    fecha: fecha,
    hora: horaString,
    motivo: motivo
  };

  try {
    const res = await fetch('/api/admin/bloqueos', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      document.getElementById('bloq-motivo').value = '';
      alert('¡Horario o día bloqueado con éxito!');
      cargarPerfil();
    }
  } catch (err) {
    alert('Error al registrar bloqueo.');
  }
}

async function eliminarBloqueo(id) {
  if (!confirm('¿Deseas reactivar este horario?')) return;
  try {
    await fetch(`/api/admin/bloqueos/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    cargarPerfil();
  } catch (err) {
    alert('Error al eliminar bloqueo.');
  }
}

// ----------------- AGENDAMIENTO MANUAL (TABLET / LOCAL) -----------------
function abrirModalCitaManual() {
  const modal = document.getElementById('modal-cita-manual');
  if (!modal) return;

  // Llenar selectores con servicios y barberos actuales
  const servSelect = document.getElementById('manual-servicio');
  servSelect.innerHTML = (barberiaActual?.servicios || []).map(s =>
    `<option value="${s.id}">${s.nombre} ($${Number(s.precio).toLocaleString()} - ${s.duracionMinutos}m)</option>`
  ).join('');

  const barbSelect = document.getElementById('manual-barbero');
  const miembros = barberiaActual?.miembros || [];
  barbSelect.innerHTML = miembros.map(m =>
    `<option value="${m.id}">${m.nombre} (${m.rol})</option>`
  ).join('');

  // Fecha de hoy por defecto
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes = String(hoy.getMonth() + 1).padStart(2, '0');
  const dia = String(hoy.getDate()).padStart(2, '0');
  document.getElementById('manual-fecha').value = `${anio}-${mes}-${dia}`;

  modal.classList.remove('hidden');
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
  const miembroId = parseInt(document.getElementById('manual-barbero').value);
  const fecha = document.getElementById('manual-fecha').value;
  const rawHora = document.getElementById('manual-hora').value; // ej: "14:30"

  // Convertir hora militar a formato am/pm legible (ej: 02:30pm)
  const [hhStr, mmStr] = rawHora.split(':');
  let hh = parseInt(hhStr);
  const ampm = hh >= 12 ? 'pm' : 'am';
  let hh12 = hh % 12;
  if (hh12 === 0) hh12 = 12;
  const horaFormateada = `${String(hh12).padStart(2, '0')}:${mmStr}${ampm}`;

  const payload = {
    barberiaSlug: barberiaActual.slug,
    servicioId: servicioId,
    miembroEquipoId: miembroId,
    nombreCliente: nombre,
    telefonoCliente: telefonoCompleto,
    fecha: fecha,
    hora: horaFormateada
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
      alert(`¡Cita agendada con éxito para ${nombre} a las ${horaFormateada}!`);
      cerrarModalCitaManual();
      document.getElementById('form-cita-manual').reset();
      cargarCitas();

      // Opción de enviar confirmación inmediata al WhatsApp del cliente
      const servObj = (barberiaActual.servicios || []).find(s => s.id === servicioId);
      const barbObj = (barberiaActual.miembros || []).find(m => m.id === miembroId);
      const nomBarberia = (barberiaActual.nombre || 'BARBERÍA').toUpperCase();

      const msgConfirm = encodeURIComponent(
        `💈 *${nomBarberia}* 💈\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `¡Hola ${nombre}! 👋\n` +
        `Tu cita ha sido agendada con éxito en nuestro local:\n\n` +
        `✂️ *Servicio:* ${servObj?.nombre || 'Servicio'}\n` +
        `💈 *Profesional:* ${barbObj?.nombre || 'Master Barber'}\n` +
        `📅 *Fecha:* ${fecha}\n` +
        `⏰ *Hora:* ${horaFormateada}\n` +
        `🔖 *Código:* #${data.codigoReserva}\n\n` +
        `📍 *Ubicación:* ${barberiaActual.direccion || 'En la barbería'}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `¡Te esperamos puntual! ✂️🔥`
      );

      const cleanPais = pais.replace('+', '');
      window.open(`https://wa.me/${cleanPais}${telefonoLimpio}?text=${msgConfirm}`, '_blank');
    } else {
      alert(data.message || 'No se pudo agendar la cita.');
    }
  } catch (err) {
    alert('Error conectando con el servidor.');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Confirmar y Agendar';
  }
}

async function limpiarDatosPrueba() {
  if (!confirm('⚠️ ¿Deseas limpiar todas las citas y bloqueos de prueba?\n\nTus servicios, precios y barberos permanecerán intactos, pero las estadísticas volverán a $0 para arrancar el lanzamiento oficial.')) {
    return;
  }

  try {
    const res = await fetch('/api/admin/limpiar-datos-prueba', {
      method: 'POST',
      headers: getAuthHeaders()
    });
    const data = await res.json();
    if (res.ok) {
      alert(data.message);
      cargarCitas();
      cargarPerfil();
    } else {
      alert('No se pudo limpiar los datos.');
    }
  } catch (err) {
    alert('Error al conectar con el servidor.');
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
async function guardarConfiguracionBot() {
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
      alert('¡Configuración y plantillas del Bot guardadas con éxito!');
      cargarPerfil();
    } else {
      alert('Error guardando configuración del bot.');
    }
  } catch (err) {
    alert('Error al conectar con el servidor.');
  }
}

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
            Palabras: ${r.palabrasClave}
          </span>
        </div>
        <p class="text-xs text-gray-200 mt-1 leading-relaxed">
          <strong class="text-emerald-400">Respuesta:</strong> ${r.respuesta}
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
    alert('Por favor completa las palabras clave y la respuesta.');
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
      alert('Error creando regla.');
    }
  } catch (err) {
    alert('Error al conectar con el servidor.');
  }
}

async function eliminarReglaBot(id) {
  if (!confirm('¿Deseas eliminar esta regla de respuesta?')) return;
  try {
    const res = await fetch(`/api/admin/bot/reglas/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (res.ok) cargarPerfil();
  } catch (err) {
    alert('Error eliminando regla.');
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
        if (res.status === 403 || res.status === 503) {
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
  if (!confirm('¿Desvincular el WhatsApp conectado al bot? Tendrás que escanear un QR nuevo con el celular que quieras usar.')) return;
  try {
    const res = await fetch('/api/admin/bot/reiniciar', { method: 'POST', headers: getAuthHeaders() });
    const data = await res.json().catch(() => ({}));
    alert(data.message || (res.ok ? 'Listo. Espera el QR nuevo.' : 'No se pudo desvincular.'));
    if (res.ok) abrirModalVincularWhatsApp();
  } catch (e) {
    alert('No se pudo conectar con el servidor.');
  }
}

function cerrarModalVincularWhatsApp() {
  const modal = document.getElementById('modal-vincular-whatsapp');
  if (modal) modal.classList.add('hidden');
  if (intervalPollBot) clearInterval(intervalPollBot);
}

async function eliminarBarberiaCompleta() {
  if (!confirm('⚠️ ¿Estás SEGURO de eliminar por completo tu barbería y tu cuenta?\n\nEsta acción borrará todas tus citas, servicios y configuración permanentemente.')) {
    return;
  }
  const confirmacion = prompt("Para confirmar definitivamente, escribe 'ELIMINAR':");
  if (confirmacion !== 'ELIMINAR') {
    alert('Operación cancelada. No se eliminó la barbería.');
    return;
  }

  try {
    const res = await fetch('/api/admin/eliminar-barberia', {
      method: 'DELETE',
      headers: getAuthHeaders()
    });

    if (res.ok) {
      alert('Tu barbería y cuenta han sido eliminadas correctamente.');
      localStorage.removeItem('bf_token');
      localStorage.removeItem('bf_user');
      window.location.href = '/login.html';
    } else {
      const data = await res.json();
      alert(data.message || 'Error al eliminar la barbería.');
    }
  } catch (err) {
    alert('Error al conectar con el servidor.');
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
