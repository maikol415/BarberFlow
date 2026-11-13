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

async function initAdmin() {
  const hoyStr = new Date().toISOString().split('T')[0];
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
    document.getElementById('conf-mostrar-barberos').checked = barberiaActual.mostrarSelectorBarbero || false;

    // Horarios laborales base
    document.getElementById('conf-hora-apertura').value = barberiaActual.horaApertura || '09:00';
    document.getElementById('conf-hora-cierre').value = barberiaActual.horaCierre || '20:00';
    document.getElementById('conf-intervalo').value = (barberiaActual.intervaloMinutos || 40).toString();

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
      `💈 *{barberia}* 💈\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `¡Hola {cliente}! 👋\n` +
      `Tu cita ha sido *CONFIRMADA* con éxito 🎉\n\n` +
      `📋 *Detalles de tu turno:*\n` +
      `✂️ *Servicio:* {servicio}\n` +
      `💈 *Profesional:* {barbero}\n` +
      `📅 *Fecha:* {fecha}\n` +
      `⏰ *Hora:* {hora}\n` +
      `🔖 *Código:* {codigo}\n` +
      `📍 *Ubicación:* {direccion}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `¿Necesitas gestionar tu turno?\n` +
      `• Responde *SI* para reconfirmar asistencia ✅\n` +
      `• Responde *CANCELAR* si se te presentó un imprevisto ❌\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `¡Te esperamos con la mejor energía! ✂️🔥`;

    const txtRecordatorio = document.getElementById('conf-bot-recordatorio');
    if (txtRecordatorio) txtRecordatorio.value = barberiaActual.plantillaRecordatorio || 
      `💈 *{barberia}* 💈\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `¡Hola {cliente}! ⏳\n` +
      `Te recordamos que tienes una cita programada:\n\n` +
      `✂️ *Servicio:* {servicio}\n` +
      `💈 *Profesional:* {barbero}\n` +
      `📅 *Fecha:* {fecha}\n` +
      `⏰ *Hora:* {hora}\n` +
      `📍 *Dirección:* {direccion}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Por favor procura llegar 5 minutos antes ⏰\n` +
      `¿Confirmas tu asistencia para tener tu silla lista? Responde *CONFIRMO* ✅\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `¡Nos vemos pronto! 💈✂️`;

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
      if (t === subtab) {
        btn.className = 'px-3 py-1.5 rounded-lg font-bold bg-blue-600 text-white transition';
      } else {
        btn.className = 'px-3 py-1.5 rounded-lg font-medium text-gray-400 hover:text-white transition';
      }
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
    if (c.estado === 'Confirmada') {
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
  document.getElementById('kpi-ingresos-reales').innerText = `$ ${Number(ingresosCompletados).toLocaleString()}`;

  document.getElementById('count-activas').innerText = pendientes;
  document.getElementById('count-completadas').innerText = completadas;
  document.getElementById('count-noconfirmadas').innerText = noConfirmadas;

  renderTablaCitas();
}

function renderTablaCitas() {
  const tbody = document.getElementById('citas-tbody');
  tbody.innerHTML = '';

  let citasFiltradas = [];
  if (subTabActual === 'activas') {
    citasFiltradas = todasLasCitas.filter(c => c.estado === 'Confirmada');
  } else if (subTabActual === 'completadas') {
    citasFiltradas = todasLasCitas.filter(c => c.estado === 'Completada');
  } else if (subTabActual === 'noconfirmadas') {
    citasFiltradas = todasLasCitas.filter(c => c.estado === 'No Confirmada' || c.estado === 'Cancelada');
  }

  if (citasFiltradas.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-gray-500">No hay citas en este apartado.</td></tr>`;
    return;
  }

  citasFiltradas.forEach(c => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-white/[0.02] transition';

    const phoneClean = c.telefonoCliente.replace(/[^0-9]/g, '');
    const nomBarberia = (barberiaActual?.nombre || 'BARBERÍA').toUpperCase();
    const dirBarberia = barberiaActual?.direccion || 'En nuestro local';
    
    const msgConfirmada = encodeURIComponent(
      `💈 *${nomBarberia}* 💈\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `¡Hola ${c.nombreCliente}! 👋\n` +
      `Tu cita ha sido *CONFIRMADA* con éxito.\n\n` +
      `📋 *Detalles de tu turno:*\n` +
      `✂️ *Servicio:* ${c.servicio}\n` +
      `💈 *Profesional:* ${c.barbero || 'Master Barber'}\n` +
      `📅 *Fecha:* ${c.fecha}\n` +
      `⏰ *Hora:* ${c.hora}\n` +
      `🔖 *Código:* #${c.codigoReserva}\n\n` +
      `📍 *Ubicación:* ${dirBarberia}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `¡Te esperamos puntual para darte la mejor atención! ✂️🔥`
    );

    const msgRecordatorio = encodeURIComponent(
      `💈 *${nomBarberia}* 💈\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `¡Hola ${c.nombreCliente}! ⏳\n` +
      `Te recordamos que tienes una cita programada:\n\n` +
      `✂️ *Servicio:* ${c.servicio}\n` +
      `💈 *Profesional:* ${c.barbero || 'Master Barber'}\n` +
      `📅 *Fecha:* ${c.fecha}\n` +
      `⏰ *Hora:* ${c.hora}\n` +
      `📍 *Dirección:* ${dirBarberia}\n\n` +
      `Por favor procura llegar 5 minutos antes.\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `¡Tu silla ya está lista! ✂️🚀`
    );

    const enlaceWhatsAppConfirm = `https://wa.me/${phoneClean}?text=${msgConfirmada}`;
    const enlaceWhatsAppRecordatorio = `https://wa.me/${phoneClean}?text=${msgRecordatorio}`;

    tr.innerHTML = `
      <td class="px-3 sm:px-4 py-3 font-mono font-bold text-blue-400 text-xs">${c.codigoReserva}</td>
      <td class="px-3 sm:px-4 py-3">
        <div class="font-bold text-white text-xs sm:text-sm">${c.nombreCliente}</div>
        <a href="https://wa.me/${phoneClean}" target="_blank" class="text-[11px] text-gray-400 hover:text-emerald-400 flex items-center gap-1 mt-0.5">
          <i data-lucide="phone" class="w-3 h-3 text-emerald-400"></i> ${c.telefonoCliente}
        </a>
      </td>
      <td class="px-3 sm:px-4 py-3">
        <div class="text-white text-xs">${c.servicio}</div>
        <div class="text-[11px] text-gray-400">${c.barbero}</div>
      </td>
      <td class="px-3 sm:px-4 py-3 text-xs text-blue-300 whitespace-nowrap font-semibold">
        ${c.fecha}<br><span class="text-gray-400 font-normal">${c.hora}</span>
      </td>
      <td class="px-3 sm:px-4 py-3 font-bold text-white text-xs sm:text-sm">$ ${Number(c.total).toLocaleString()}</td>
      <td class="px-3 sm:px-4 py-3">
        <div class="flex items-center gap-1.5 flex-wrap">
          <a href="${enlaceWhatsAppConfirm}" target="_blank" title="Avisar confirmación al cliente" class="px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[11px] font-semibold flex items-center gap-1 hover:bg-emerald-500/20 transition">
            <i data-lucide="check-check" class="w-3 h-3"></i> Confirmar
          </a>
          <a href="${enlaceWhatsAppRecordatorio}" target="_blank" title="Enviar recordatorio al cliente" class="px-2 py-1 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[11px] font-semibold flex items-center gap-1 hover:bg-amber-500/20 transition">
            <i data-lucide="bell" class="w-3 h-3"></i> Recordar
          </a>
        </div>
      </td>
      <td class="px-3 sm:px-4 py-3 text-right">
        ${
          subTabActual === 'activas' ? `
            <div class="flex items-center justify-end gap-1.5">
              <button onclick="marcarCompletada(${c.id})" title="Marcar como atendida" class="py-1 px-2.5 rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 transition text-xs flex items-center gap-1 font-semibold">
                <i data-lucide="check" class="w-3.5 h-3.5"></i> Completar
              </button>
              <button onclick="eliminarOMoverNoConfirmada(${c.id})" title="Mover a no confirmadas" class="p-1.5 rounded-lg bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition text-xs">
                <i data-lucide="x" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          ` : subTabActual === 'noconfirmadas' ? `
            <div class="flex items-center justify-end gap-1.5">
              <button onclick="reactivarCita(${c.id})" title="Reactivar cita" class="text-xs px-2.5 py-1 rounded-lg bg-blue-500/20 text-blue-400 border border-blue-500/30 font-semibold">
                Reactivar
              </button>
              <button onclick="eliminarPermanente(${c.id})" title="Borrar del sistema" class="text-xs px-2.5 py-1 rounded-lg bg-red-500/20 text-red-300 font-semibold">
                Borrar
              </button>
            </div>
          ` : `
            <span class="text-xs text-emerald-400 font-semibold flex items-center justify-end gap-1">
              <i data-lucide="badge-check" class="w-4 h-4"></i> Atendida
            </span>
          `
        }
      </td>
    `;
    tbody.appendChild(tr);
  });
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
  if (!confirm('¿Mover esta cita a "No Confirmadas" para que no estorbe en la agenda?')) return;
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
    horas = ['12:30pm', '01:00pm', '01:30pm'];
    motivo = '🍱 Almuerzo';
  } else if (tipo === 'tarde') {
    horas = ['04:30pm', '05:00pm', '05:30pm'];
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
      headers: { 'Content-Type': 'application/json' },
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

  document.getElementById('tab-btn-citas').className = 'px-4 py-2 rounded-xl font-medium text-gray-400 hover:text-white whitespace-nowrap transition';
  document.getElementById('tab-btn-perfil').className = 'px-4 py-2 rounded-xl font-medium text-gray-400 hover:text-white whitespace-nowrap transition';
  document.getElementById('tab-btn-horarios').className = 'px-4 py-2 rounded-xl font-medium text-gray-400 hover:text-white whitespace-nowrap transition';
  const tabBot = document.getElementById('tab-btn-bot');
  if (tabBot) tabBot.className = 'px-4 py-2 rounded-xl font-medium text-gray-400 hover:text-white whitespace-nowrap transition flex items-center gap-1.5';

  if (sec === 'citas') {
    document.getElementById('sec-citas').classList.remove('hidden');
    document.getElementById('tab-btn-citas').className = 'px-4 py-2 rounded-xl font-bold bg-blue-600 text-white whitespace-nowrap transition';
  } else if (sec === 'perfil') {
    document.getElementById('sec-perfil').classList.remove('hidden');
    document.getElementById('tab-btn-perfil').className = 'px-4 py-2 rounded-xl font-bold bg-blue-600 text-white whitespace-nowrap transition';
  } else if (sec === 'horarios') {
    document.getElementById('sec-horarios').classList.remove('hidden');
    document.getElementById('tab-btn-horarios').className = 'px-4 py-2 rounded-xl font-bold bg-blue-600 text-white whitespace-nowrap transition';
  } else if (sec === 'bot') {
    if (secBot) secBot.classList.remove('hidden');
    if (tabBot) tabBot.className = 'px-4 py-2 rounded-xl font-bold bg-blue-600 text-white whitespace-nowrap transition flex items-center gap-1.5';
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
    botActivo: document.getElementById('conf-bot-activo').checked,
    mensajeBienvenidaBot: document.getElementById('conf-bot-bienvenida').value,
    mensajeDerivacionHumana: document.getElementById('conf-bot-derivacion').value,
    plantillaConfirmacion: document.getElementById('conf-bot-confirmacion').value,
    plantillaRecordatorio: document.getElementById('conf-bot-recordatorio').value
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
      // Consultar directamente el bot en la nube (Render) o fallback local
      let res;
      try {
        res = await fetch('https://barberflow-bot.onrender.com/api/status');
      } catch (e) {
        res = await fetch('http://localhost:3001/api/status');
      }
      if (!res.ok) return;
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

function cerrarSesion() {
  localStorage.removeItem('bf_token');
  localStorage.removeItem('bf_user');
  window.location.href = '/login.html';
}

window.addEventListener('DOMContentLoaded', initAdmin);
