// BarberFlow Pro - Client Logic (Categorías Dinámicas, Modal Imagen, Calendario Dual, Horarios y Reservas)
let barberia = null;
let todosLosServicios = [];
let categoriaActiva = '';
let textoBusqueda = '';
let modoCalendario = 'dias'; // 'dias' (tarjetas) o 'mes' (matriz mensual)
let mesOffset = 0; // Para navegar entre meses

let reservaActual = {
  servicioId: null,
  barberoId: null,
  fechaSeleccionada: null,
  horaSeleccionada: null,
  total: 0
};

const DEFAULT_AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2364748B'><circle cx='12' cy='8' r='4'/><path d='M4 20c0-4 4-6 8-6s8 2 8 6'/></svg>";

function obtenerFechaLocalIso(fechaObj = new Date()) {
  const anio = fechaObj.getFullYear();
  const mes = String(fechaObj.getMonth() + 1).padStart(2, '0');
  const dia = String(fechaObj.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
}

// Convierte un string de hora (ej: "04:30pm" o "09:00am") a minutos desde medianoche
function convertirHoraAMinutos(horaStr) {
  if (!horaStr) return 0;
  const str = horaStr.toLowerCase().trim();
  const esPm = str.includes('pm');
  const esAm = str.includes('am');
  const clean = str.replace(/[apm\s]/g, '');
  const [hStr, mStr] = clean.split(':');
  let hh = parseInt(hStr) || 0;
  const mm = parseInt(mStr) || 0;

  if (esPm && hh < 12) hh += 12;
  if (esAm && hh === 12) hh = 0;

  return hh * 60 + mm;
}

async function initClient() {
  const urlParams = new URLSearchParams(window.location.search);
  const slug = urlParams.get('b') || 'barberia-jr';

  try {
    const res = await fetch(`/api/public/barberia/${slug}`);
    if (!res.ok) {
      document.getElementById('barber-name').innerText = 'Barbería no encontrada';
      return;
    }
    barberia = await res.json();
    todosLosServicios = barberia.servicios || [];

    renderEncabezado();
    renderCategoriasYServicios();
    configurarSelectorBarbero();
    renderCalendario();
    lucide.createIcons();
  } catch (err) {
    console.error('Error cargando datos de la barbería:', err);
  }
}

// 1. Encabezado e Imagen Ampliable (Estilo Instagram)
function renderEncabezado() {
  document.getElementById('barber-name').innerText = barberia.nombre;
  document.getElementById('barber-address').innerText = barberia.direccion || 'Calle 45 # 12-34';
  document.getElementById('barber-desc').innerText = barberia.descripcion || 'Barbería & Cuidado personal';
  
  // Agendamientos y estrellas reales calculados desde la base de datos
  const totalAgendamientos = barberia.totalAgendamientos || 0;
  const totalCompletadas = barberia.totalCompletadas || 0;
  const totalValoraciones = barberia.totalValoraciones || 0;
  const calif = barberia.calificacion ? Number(barberia.calificacion).toFixed(1) : '5.0';

  const starsEl = document.getElementById('barber-stars');
  if (starsEl) starsEl.innerText = `★ ${calif}`;

  const reviewsEl = document.getElementById('barber-reviews');
  if (reviewsEl) reviewsEl.innerText = `(${totalValoraciones} valoraciones)`;

  const apptsEl = document.getElementById('barber-appointments');
  if (apptsEl) apptsEl.innerText = `${totalAgendamientos} agendamiento${totalAgendamientos === 1 ? '' : 's'}`;

  const logo = barberia.logoUrl || DEFAULT_AVATAR;
  const imgLogoEl = document.getElementById('barber-logo');
  if (imgLogoEl) {
    imgLogoEl.src = logo;
    imgLogoEl.onerror = () => { imgLogoEl.src = DEFAULT_AVATAR; };
  }

  if (barberia.telefonoWhatsApp) {
    const cleanPhone = barberia.telefonoWhatsApp.replace(/[^0-9]/g, '');
    document.getElementById('link-whatsapp-direct').href = `https://wa.me/${cleanPhone}`;
  }
}

function abrirModalImagenGrande(src, titulo) {
  const modal = document.getElementById('modal-foto-grande');
  const img = document.getElementById('img-grande-src');
  const tit = document.getElementById('img-grande-titulo');
  if (modal && img) {
    img.src = src;
    if (tit) tit.innerText = titulo || 'Barbería';
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
}

function cerrarModalFotoGrande() {
  const modal = document.getElementById('modal-foto-grande');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = 'auto';
  }
}

// Cerrar con Escape
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    cerrarModalFotoGrande();
    const successModal = document.getElementById('success-modal');
    if (successModal && !successModal.classList.contains('hidden')) {
      cerrarModal();
    }
  }
});

// 2. Categorías Dinámicas SIN opción genérica "Todos"
function obtenerIconoCategoria(nombreCat) {
  const cat = (nombreCat || '').toLowerCase();
  if (cat.includes('uña') || cat.includes('manic') || cat.includes('pedic')) return '💅';
  if (cat.includes('facial') || cat.includes('limpieza') || cat.includes('piel') || cat.includes('exfolia')) return '✨';
  if (cat.includes('barba') || cat.includes('afeitado')) return '🧔';
  if (cat.includes('combo') || cat.includes('pack') || cat.includes('promo')) return '👑';
  if (cat.includes('ceja')) return '👁️';
  if (cat.includes('masaje') || cat.includes('spa')) return '💆';
  if (cat.includes('pelo') || cat.includes('corte') || cat.includes('cabello') || cat.includes('fade')) return '✂️';
  return '💈';
}

function renderCategoriasYServicios() {
  // Extraer únicamente las categorías reales existentes en los servicios
  const catsSet = new Set();
  todosLosServicios.forEach(s => {
    if (s.categoria && s.categoria.trim()) {
      catsSet.add(s.categoria.trim());
    } else {
      catsSet.add('Cortes');
    }
  });

  const categorias = Array.from(catsSet);
  if (categorias.length === 0) {
    categorias.push('Cortes');
  }

  // Si la categoría activa ya no existe o está vacía, seleccionar la primera
  if (!categoriaActiva || !categorias.includes(categoriaActiva)) {
    categoriaActiva = categorias[0];
  }

  const catContainer = document.getElementById('categorias-container');
  catContainer.innerHTML = '';

  categorias.forEach(cat => {
    const esActiva = cat === categoriaActiva;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.onclick = () => cambiarCategoria(cat);

    const icono = obtenerIconoCategoria(cat);

    btn.className = 'flex flex-col items-center gap-1.5 focus:outline-none flex-shrink-0 transition-transform active:scale-95';
    btn.innerHTML = `
      <div class="w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center text-xl sm:text-2xl transition-all shadow-md ${
        esActiva 
          ? 'bg-blue-600 text-white shadow-blue-500/30 ring-4 ring-blue-500/30 scale-105' 
          : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
      }">
        ${icono}
      </div>
      <span class="text-xs sm:text-sm font-semibold ${esActiva ? 'text-blue-400 font-extrabold' : 'text-gray-400'}">${cat}</span>
    `;
    catContainer.appendChild(btn);
  });

  const tituloEl = document.getElementById('titulo-categoria-activa');
  if (tituloEl) tituloEl.innerText = categoriaActiva;

  filtrarYRenderizarTarjetas();
}

function cambiarCategoria(cat) {
  categoriaActiva = cat;
  renderCategoriasYServicios();
}

function filtrarServiciosPorTexto(texto) {
  textoBusqueda = texto.toLowerCase().trim();
  filtrarYRenderizarTarjetas();
}

function filtrarYRenderizarTarjetas() {
  const container = document.getElementById('services-cards-grid');
  container.innerHTML = '';

  let filtrados = [];
  const tituloEl = document.getElementById('titulo-categoria-activa');

  if (textoBusqueda) {
    // Si el usuario escribe algo en el buscador, buscar en TODOS los servicios sin importar categoría
    filtrados = todosLosServicios.filter(s => {
      const nomMatch = s.nombre.toLowerCase().includes(textoBusqueda);
      const descMatch = s.descripcion && s.descripcion.toLowerCase().includes(textoBusqueda);
      const catMatch = s.categoria && s.categoria.toLowerCase().includes(textoBusqueda);
      return nomMatch || descMatch || catMatch;
    });

    if (tituloEl) {
      tituloEl.innerText = `Resultados de búsqueda: "${textoBusqueda}" (${filtrados.length})`;
    }
  } else {
    // Si no hay texto de búsqueda, mostrar la categoría activa
    filtrados = todosLosServicios.filter(s => {
      const catServicio = (s.categoria && s.categoria.trim()) ? s.categoria.trim() : 'Cortes';
      return catServicio === categoriaActiva;
    });

    if (tituloEl) {
      tituloEl.innerText = categoriaActiva;
    }
  }

  if (filtrados.length === 0) {
    container.innerHTML = `<div class="col-span-full py-8 text-center text-xs text-gray-500">No se encontraron servicios con el término "${textoBusqueda}".</div>`;
    return;
  }

  filtrados.forEach((s) => {
    const esSeleccionado = reservaActual.servicioId === s.id;

    const card = document.createElement('div');
    card.id = `card-serv-${s.id}`;
    card.className = `p-4 sm:p-5 rounded-2xl cursor-pointer transition border flex flex-col justify-between ${
      esSeleccionado 
        ? 'bg-blue-900/30 border-blue-500 shadow-lg shadow-blue-500/10 ring-1 ring-blue-500' 
        : 'bg-[#131B2E] border-gray-800 hover:border-gray-700'
    }`;
    card.onclick = () => seleccionarServicio(s);

    let duracionTexto = `${s.duracionMinutos} minutos`;
    if (s.duracionMinutos >= 60) {
      const horas = Math.floor(s.duracionMinutos / 60);
      const mins = s.duracionMinutos % 60;
      duracionTexto = mins > 0 ? `${horas}h ${mins}min` : `alrededor de ${horas} hora${horas > 1 ? 's' : ''}`;
    }

    const badgeCategoria = textoBusqueda && s.categoria 
      ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 mr-1.5 font-medium">${s.categoria}</span>`
      : '';

    card.innerHTML = `
      <div>
        <div class="flex items-start justify-between gap-2">
          <div>
            ${badgeCategoria}
            <h4 class="font-extrabold text-white text-sm sm:text-base inline">${s.nombre}</h4>
          </div>
          <span class="text-xs px-2.5 py-0.5 rounded-full font-semibold flex-shrink-0 ${esSeleccionado ? 'bg-blue-500 text-white' : 'bg-gray-800 text-gray-400'}">
            ${esSeleccionado ? '✓ Elegido' : 'Elegir'}
          </span>
        </div>
        <p class="text-xs text-gray-400 mt-1 line-clamp-2">${s.descripcion || 'Servicio profesional de máxima calidad.'}</p>
      </div>

      <div class="flex items-center justify-between pt-3 mt-3 border-t border-gray-800/60 text-xs">
        <span class="text-blue-400 flex items-center gap-1 font-medium">
          <i data-lucide="clock" class="w-3.5 h-3.5"></i> ${duracionTexto}
        </span>
        <span class="text-white font-extrabold text-sm sm:text-base">$ ${Number(s.precio).toLocaleString()}</span>
      </div>
    `;
    container.appendChild(card);
  });

  lucide.createIcons();
}

function seleccionarServicio(s) {
  reservaActual.servicioId = s.id;
  reservaActual.total = s.precio;

  document.getElementById('resumen-servicio').innerText = s.nombre;
  document.getElementById('resumen-duracion').innerText = `${s.duracionMinutos} minutos`;
  document.getElementById('resumen-precio').innerText = `$ ${Number(s.precio).toLocaleString()}`;

  // Actualizar estilos de tarjetas
  document.querySelectorAll('#services-cards-grid > div').forEach(el => {
    el.className = 'p-4 sm:p-5 rounded-2xl cursor-pointer transition border flex flex-col justify-between bg-[#131B2E] border-gray-800 hover:border-gray-700';
    const badge = el.querySelector('span.rounded-full');
    if (badge) {
      badge.className = 'text-xs px-2.5 py-0.5 rounded-full font-semibold bg-gray-800 text-gray-400';
      badge.innerText = 'Elegir';
    }
  });

  const card = document.getElementById(`card-serv-${s.id}`);
  if (card) {
    card.className = 'p-4 sm:p-5 rounded-2xl cursor-pointer transition border flex flex-col justify-between bg-blue-900/30 border-blue-500 shadow-lg shadow-blue-500/10 ring-1 ring-blue-500';
    const badge = card.querySelector('span.rounded-full');
    if (badge) {
      badge.className = 'text-xs px-2.5 py-0.5 rounded-full font-semibold bg-blue-500 text-white';
      badge.innerText = '✓ Elegido';
    }
  }
}

// 3. Selector de Barbero (Solo si son múltiples barberos y está activado)
function configurarSelectorBarbero() {
  const miembros = barberia.miembros || [];
  const secBarbero = document.getElementById('seccion-selector-barbero');
  const resumenBoxBarbero = document.getElementById('resumen-box-barbero');

  // Si la barbería desactivó la opción o solo tiene 1 barbero, OCULTAR el selector
  if (!barberia.mostrarSelectorBarbero || miembros.length <= 1) {
    if (secBarbero) secBarbero.classList.add('hidden');
    if (resumenBoxBarbero) resumenBoxBarbero.classList.add('hidden');
    reservaActual.barberoId = miembros.length > 0 ? miembros[0].id : null;
    return;
  }

  if (secBarbero) secBarbero.classList.remove('hidden');
  if (resumenBoxBarbero) resumenBoxBarbero.classList.remove('hidden');

  const container = document.getElementById('barbers-container');
  container.innerHTML = '';

  const lista = [{ id: null, nombre: 'Cualquiera', rol: 'Asignación rápida', fotoUrl: DEFAULT_AVATAR }, ...miembros];

  lista.forEach((b, idx) => {
    const esPrimero = idx === 0;
    const card = document.createElement('div');
    card.id = `barber-${b.id || 'any'}`;
    card.className = `p-3 rounded-2xl border text-center cursor-pointer transition ${
      esPrimero ? 'border-blue-500 bg-blue-900/30 ring-1 ring-blue-500' : 'border-gray-800 bg-gray-950 hover:border-gray-700'
    }`;
    card.onclick = () => seleccionarBarbero(b);

    const foto = b.fotoUrl || DEFAULT_AVATAR;
    card.innerHTML = `
      <div class="relative group/avatar inline-block" onclick="event.stopPropagation(); abrirModalImagenGrande('${foto}', '${b.nombre}')">
        <img src="${foto}" onerror="this.src='${DEFAULT_AVATAR}'" class="w-12 h-12 rounded-full mx-auto object-cover border border-blue-400/30 mb-1.5 bg-gray-900 p-0.5 hover:scale-105 transition shadow">
      </div>
      <div class="font-bold text-xs text-white truncate">${b.nombre}</div>
      <div class="text-[10px] text-gray-400 truncate">${b.rol}</div>
    `;
    container.appendChild(card);
  });
}

function seleccionarBarbero(b) {
  reservaActual.barberoId = b.id;
  document.querySelectorAll('#barbers-container > div').forEach(el => {
    el.className = 'p-3 rounded-2xl border text-center cursor-pointer transition border-gray-800 bg-gray-950 hover:border-gray-700';
  });
  const act = document.getElementById(`barber-${b.id || 'any'}`);
  if (act) act.className = 'p-3 rounded-2xl border text-center cursor-pointer transition border-blue-500 bg-blue-900/30 ring-1 ring-blue-500';

  // Actualizar nombre del barbero en el resumen
  const resumenBarberoEl = document.getElementById('resumen-barbero');
  if (resumenBarberoEl) {
    resumenBarberoEl.innerText = b.nombre;
  }

  renderHorariosDisponibles();
}

// 4. Calendario Dual (Por Días como Tarjetas / Completo Mes) y Navegación
function alternarModoCalendario() {
  modoCalendario = modoCalendario === 'dias' ? 'mes' : 'dias';
  
  const label = document.getElementById('label-modo-cal');
  if (label) {
    label.innerText = modoCalendario === 'dias' ? 'Ver calendario completo' : 'Ver calendario por días';
  }
  
  renderCalendario();
}

function cambiarMesRelativo(offset) {
  mesOffset += offset;
  renderCalendario();
}

function renderCalendario() {
  const container = document.getElementById('grid-calendario-mes');
  container.innerHTML = '';

  const hoy = new Date();
  const fechaBase = new Date(hoy.getFullYear(), hoy.getMonth() + mesOffset, 1);
  const anio = fechaBase.getFullYear();
  const mes = fechaBase.getMonth();

  const mesesNombres = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  document.getElementById('mes-anio-label').innerText = `${mesesNombres[mes]} ${anio}`;

  const diasLaboralesArr = (barberia.diasLaborales || "1,2,3,4,5,6").split(',').map(Number);
  const bloqueos = barberia.bloqueos || [];
  const diasSemanaNombres = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  if (modoCalendario === 'dias') {
    // VISTA POR DÍAS (Estilo scroll horizontal o cuadrícula ordenada de 7 columnas)
    container.className = 'grid grid-cols-7 gap-1.5 sm:gap-2 text-center';

    let diasMostrados = 0;
    let diaIndex = 0;
    let primerDiaValido = null;

    // Generar próximos 21 días a partir de hoy local
    const fechaInicio = (mesOffset === 0) ? new Date() : new Date(anio, mes, 1);

    while (diasMostrados < 21 && diaIndex < 40) {
      const fecha = new Date(fechaInicio);
      fecha.setDate(fechaInicio.getDate() + diaIndex);
      diaIndex++;

      const anioF = fecha.getFullYear();
      const mesF = String(fecha.getMonth() + 1).padStart(2, '0');
      const diaF = String(fecha.getDate()).padStart(2, '0');
      const isoStr = `${anioF}-${mesF}-${diaF}`;

      const diaNum = fecha.getDate();
      const dayOfWeek = fecha.getDay();
      const nombreDiaSemana = diasSemanaNombres[dayOfWeek];

      const esDiaLaboral = diasLaboralesArr.includes(dayOfWeek);
      const estaBloqueado = bloqueos.some(b => b.fecha === isoStr && (!b.hora || b.hora === 'TODO_EL_DIA'));
      const noDisponible = !esDiaLaboral || estaBloqueado;

      if (!noDisponible && !primerDiaValido) {
        primerDiaValido = isoStr;
        if (!reservaActual.fechaSeleccionada) {
          reservaActual.fechaSeleccionada = isoStr;
        }
      }

      const esSeleccionado = reservaActual.fechaSeleccionada === isoStr;

      const card = document.createElement('button');
      card.type = 'button';
      card.id = `cal-day-${isoStr}`;

      if (noDisponible) {
        card.disabled = true;
        card.className = 'p-2 rounded-xl border border-gray-800/40 bg-gray-950/40 text-gray-600 text-xs cursor-not-allowed opacity-40 flex flex-col items-center justify-center';
        card.innerHTML = `
          <span class="text-[10px] uppercase font-semibold text-gray-600">${nombreDiaSemana}</span>
          <span class="text-sm font-bold line-through mt-0.5">${diaNum}</span>
        `;
      } else {
        card.className = `p-2 rounded-xl border text-xs font-bold transition flex flex-col items-center justify-center ${
          esSeleccionado 
            ? 'bg-blue-600 border-blue-500 text-white shadow-md shadow-blue-500/30 ring-2 ring-blue-400' 
            : 'bg-gray-950 border-gray-800 text-gray-200 hover:border-blue-400 hover:bg-gray-900'
        }`;
        card.onclick = () => seleccionarDiaCalendario(isoStr);
        card.innerHTML = `
          <span class="text-[10px] uppercase font-semibold ${esSeleccionado ? 'text-blue-100' : 'text-gray-400'}">${nombreDiaSemana}</span>
          <span class="text-base font-extrabold mt-0.5">${diaNum}</span>
        `;
      }

      container.appendChild(card);
      diasMostrados++;
    }

  } else {
    // VISTA MATRIZ DE MES COMPLETA
    container.className = 'grid grid-cols-7 gap-1.5 sm:gap-2 text-center';

    const headers = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    headers.forEach(h => {
      const sp = document.createElement('span');
      sp.className = 'text-[10px] font-bold text-gray-400 uppercase py-1';
      sp.innerText = h;
      container.appendChild(sp);
    });

    const primerDiaMes = new Date(anio, mes, 1);
    const ultimoDiaMes = new Date(anio, mes + 1, 0);
    const totalDias = ultimoDiaMes.getDate();

    // Convertir domingo = 7 para calendario de lunes a domingo
    let primerDiaSemana = primerDiaMes.getDay();
    if (primerDiaSemana === 0) primerDiaSemana = 7;

    // Celdas vacías al inicio del mes
    for (let c = 1; c < primerDiaSemana; c++) {
      const vacio = document.createElement('div');
      vacio.className = 'py-2';
      container.appendChild(vacio);
    }

    const hoyIso = hoy.toISOString().split('T')[0];

    for (let d = 1; d <= totalDias; d++) {
      const fecha = new Date(anio, mes, d);
      const anioF = fecha.getFullYear();
      const mesF = String(fecha.getMonth() + 1).padStart(2, '0');
      const diaF = String(fecha.getDate()).padStart(2, '0');
      const isoStr = `${anioF}-${mesF}-${diaF}`;

      const dayOfWeek = fecha.getDay();
      const esDiaLaboral = diasLaboralesArr.includes(dayOfWeek);
      const estaBloqueado = bloqueos.some(b => b.fecha === isoStr && (!b.hora || b.hora === 'TODO_EL_DIA'));
      const esPasado = isoStr < hoyIso;

      const noDisponible = !esDiaLaboral || estaBloqueado || esPasado;

      if (!noDisponible && !reservaActual.fechaSeleccionada) {
        reservaActual.fechaSeleccionada = isoStr;
      }

      const esSeleccionado = reservaActual.fechaSeleccionada === isoStr;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = `cal-day-${isoStr}`;

      if (noDisponible) {
        btn.disabled = true;
        btn.className = 'py-2 px-1 rounded-xl border border-gray-800/40 bg-gray-950/40 text-gray-600 text-xs cursor-not-allowed opacity-35';
        btn.innerHTML = `<span class="line-through">${d}</span>`;
      } else {
        btn.className = `py-2 px-1 rounded-xl border text-xs font-bold transition ${
          esSeleccionado 
            ? 'bg-blue-600 border-blue-500 text-white shadow-md shadow-blue-500/30' 
            : 'bg-gray-950 border-gray-800 text-gray-300 hover:border-blue-400'
        }`;
        btn.onclick = () => seleccionarDiaCalendario(isoStr);
        btn.innerHTML = `<span>${d}</span>`;
      }

      container.appendChild(btn);
    }
  }

  renderHorariosDisponibles();
}

function seleccionarDiaCalendario(isoStr) {
  reservaActual.fechaSeleccionada = isoStr;

  document.querySelectorAll('#grid-calendario-mes > button').forEach(b => {
    if (!b.disabled) {
      if (modoCalendario === 'dias') {
        b.className = 'p-2 rounded-xl border text-xs font-bold transition flex flex-col items-center justify-center bg-gray-950 border-gray-800 text-gray-200 hover:border-blue-400 hover:bg-gray-900';
        const spanSub = b.querySelector('span:first-child');
        if (spanSub) spanSub.className = 'text-[10px] uppercase font-semibold text-gray-400';
      } else {
        b.className = 'py-2 px-1 rounded-xl border text-xs font-bold transition bg-gray-950 border-gray-800 text-gray-300 hover:border-blue-400';
      }
    }
  });

  const activo = document.getElementById(`cal-day-${isoStr}`);
  if (activo) {
    if (modoCalendario === 'dias') {
      activo.className = 'p-2 rounded-xl border text-xs font-bold transition flex flex-col items-center justify-center bg-blue-600 border-blue-500 text-white shadow-md shadow-blue-500/30 ring-2 ring-blue-400';
      const spanSub = activo.querySelector('span:first-child');
      if (spanSub) spanSub.className = 'text-[10px] uppercase font-semibold text-blue-100';
    } else {
      activo.className = 'py-2 px-1 rounded-xl border text-xs font-bold transition bg-blue-600 border-blue-500 text-white shadow-md shadow-blue-500/30';
    }
  }

  renderHorariosDisponibles();
}

// 5. Horarios Disponibles con Scroll Limpio (Sin Cortar Abajo)
function renderHorariosDisponibles() {
  const container = document.getElementById('lista-horas-container');
  container.innerHTML = '';

  if (!reservaActual.fechaSeleccionada) {
    container.innerHTML = `<p class="col-span-full text-xs text-gray-400 py-6 text-center">Selecciona un día en el calendario.</p>`;
    return;
  }

  const horaApertura = barberia.horaApertura || "09:00";
  const horaCierre = barberia.horaCierre || "20:00";
  const intervalo = barberia.intervaloMinutos || 40;

  const [hIni, mIni] = horaApertura.split(':').map(Number);
  const [hFin, mFin] = horaCierre.split(':').map(Number);

  let inicioMin = hIni * 60 + mIni;
  const finMin = hFin * 60 + mFin;

  const horariosGenerados = [];
  while (inicioMin + intervalo <= finMin) {
    const hh = Math.floor(inicioMin / 60);
    const mm = inicioMin % 60;
    
    const ampm = hh >= 12 ? 'pm' : 'am';
    let hh12 = hh % 12;
    if (hh12 === 0) hh12 = 12;
    const hhStr = hh12 < 10 ? `0${hh12}` : `${hh12}`;
    const mmStr = mm < 10 ? `0${mm}` : `${mm}`;
    horariosGenerados.push(`${hhStr}:${mmStr}${ampm}`);

    inicioMin += intervalo;
  }

  const bloqueos = barberia.bloqueos || [];
  const citasOcupadas = barberia.citasOcupadas || [];

  let horasLibres = [];

  const ahora = new Date();
  const hoyIso = obtenerFechaLocalIso(ahora);
  const esHoy = reservaActual.fechaSeleccionada === hoyIso;
  // Margen de reacción para el mismo día: mínimo 2 horas hacia adelante (120 min)
  const ahoraEnMinutos = ahora.getHours() * 60 + ahora.getMinutes() + 120;

  // Duración del servicio seleccionado en minutos (por defecto 40)
  const servActual = todosLosServicios.find(s => s.id === reservaActual.servicioId);
  const duracionServicioMin = servActual ? (servActual.duracionMinutos || 40) : 40;

  horariosGenerados.forEach(h => {
    const turnoInicioMin = convertirHoraAMinutos(h);
    const turnoFinMin = turnoInicioMin + duracionServicioMin;

    // Si la reserva es para hoy, no permitir horas antes del margen de 2 horas
    if (esHoy && turnoInicioMin < ahoraEnMinutos) {
      return;
    }

    // Validación Matemática de Bloqueos (Cero traslapes con descansos)
    const estaBloqueada = bloqueos.some(b => {
      if (b.fecha !== reservaActual.fechaSeleccionada) return false;
      if (!b.hora || b.hora === 'TODO_EL_DIA') return true;

      const bloqueoInicioMin = convertirHoraAMinutos(b.hora);
      // El bloqueo cubre mínimo 40 minutos o el intervalo configurado
      const bloqueoFinMin = bloqueoInicioMin + (barberia.intervaloMinutos || 40);

      // Hay traslape si el turno empieza antes de que termine el bloqueo Y termina después de que empieza el bloqueo
      const hayTraslape = turnoInicioMin < bloqueoFinMin && turnoFinMin > bloqueoInicioMin;
      return hayTraslape;
    });

    // Validación de Citas ya ocupadas
    const estaOcupada = citasOcupadas.some(c => {
      if (c.fecha !== reservaActual.fechaSeleccionada) return false;
      const citaInicioMin = convertirHoraAMinutos(c.hora);
      const citaFinMin = citaInicioMin + (barberia.intervaloMinutos || 40);

      const mismoBarbero = (reservaActual.barberoId == null || c.miembroEquipoId == null || c.miembroEquipoId === reservaActual.barberoId);
      const hayTraslape = turnoInicioMin < citaFinMin && turnoFinMin > citaInicioMin;
      return mismoBarbero && hayTraslape;
    });

    if (!estaBloqueada && !estaOcupada) {
      horasLibres.push(h);
    }
  });

  if (horasLibres.length === 0) {
    container.innerHTML = `
      <div class="col-span-full text-center py-8">
        <p class="text-xs sm:text-sm text-gray-400 mb-3">
          El profesional o la barbería no tiene horarios disponibles para este día. Intenta otro día.
        </p>
        <div class="w-12 h-12 rounded-full border border-gray-700 flex items-center justify-center mx-auto text-gray-500">
          <i data-lucide="clock-3" class="w-6 h-6"></i>
        </div>
      </div>
    `;
    reservaActual.horaSeleccionada = null;
    document.getElementById('resumen-fecha-hora').innerText = 'No disponible este día';
    lucide.createIcons();
    return;
  }

  // Pre-seleccionar la primera hora libre
  if (!reservaActual.horaSeleccionada || !horasLibres.includes(reservaActual.horaSeleccionada)) {
    reservaActual.horaSeleccionada = horasLibres[0];
  }

  horasLibres.forEach(h => {
    const esActiva = reservaActual.horaSeleccionada === h;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `hora-btn-${h}`;
    btn.className = `py-2.5 px-3 rounded-xl border text-xs sm:text-sm font-bold text-center transition ${
      esActiva 
        ? 'border-blue-500 bg-blue-600 text-white shadow-md shadow-blue-500/20 ring-2 ring-blue-400' 
        : 'border-blue-500/40 bg-gray-950 text-blue-400 hover:bg-blue-950/40 hover:border-blue-400'
    }`;
    btn.onclick = () => seleccionarHora(h);
    btn.innerText = h;
    container.appendChild(btn);
  });

  actualizarResumenHorario();
  lucide.createIcons();
}

function seleccionarHora(h) {
  reservaActual.horaSeleccionada = h;

  document.querySelectorAll('#lista-horas-container > button').forEach(b => {
    b.className = 'py-2.5 px-3 rounded-xl border text-xs sm:text-sm font-bold text-center transition border-blue-500/40 bg-gray-950 text-blue-400 hover:bg-blue-950/40 hover:border-blue-400';
  });

  const act = document.getElementById(`hora-btn-${h}`);
  if (act) {
    act.className = 'py-2.5 px-3 rounded-xl border text-xs sm:text-sm font-bold text-center transition border-blue-500 bg-blue-600 text-white shadow-md shadow-blue-500/20 ring-2 ring-blue-400';
  }

  actualizarResumenHorario();
}

function actualizarResumenHorario() {
  if (reservaActual.fechaSeleccionada && reservaActual.horaSeleccionada) {
    document.getElementById('resumen-fecha-hora').innerText = `${reservaActual.fechaSeleccionada} • ${reservaActual.horaSeleccionada}`;
  } else {
    document.getElementById('resumen-fecha-hora').innerText = 'Elige día y hora';
  }
}

// 6. Confirmación de Cita
async function confirmarReservaFinal(e) {
  e.preventDefault();
  const nombre = document.getElementById('cliente-nombre').value.trim();
  const rawTelefono = document.getElementById('cliente-telefono').value.trim();
  const pais = document.getElementById('cliente-pais') ? document.getElementById('cliente-pais').value : '+57';
  const telefonoLimpio = rawTelefono.replace(/[^0-9]/g, '');
  const telefonoCompleto = `${pais}${telefonoLimpio}`;

  if (!nombre || !rawTelefono) {
    alert('Por favor completa tu nombre y teléfono.');
    return;
  }

  if (!reservaActual.servicioId) {
    alert('⚠️ Por favor elige primero el servicio que deseas reservar arriba.');
    return;
  }

  if (!reservaActual.fechaSeleccionada || !reservaActual.horaSeleccionada) {
    alert('Por favor selecciona una fecha y horario disponible.');
    return;
  }

  const payload = {
    barberiaSlug: barberia.slug,
    servicioId: reservaActual.servicioId,
    miembroEquipoId: reservaActual.barberoId,
    nombreCliente: nombre,
    telefonoCliente: telefonoCompleto,
    fecha: reservaActual.fechaSeleccionada,
    hora: reservaActual.horaSeleccionada
  };

  const btn = document.getElementById('btn-confirmar-final');
  btn.disabled = true;
  btn.innerText = 'Agendando tu cita...';

  try {
    const res = await fetch('/api/public/citas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || 'Horario no disponible. Intenta de nuevo.');
      btn.disabled = false;
      btn.innerText = 'Confirmar Cita Ahora';
      return;
    }

    // Modal de confirmación exitosa
    document.getElementById('modal-codigo').innerText = data.codigoReserva;
    document.getElementById('modal-servicio').innerText = data.servicioNombre;
    document.getElementById('modal-horario').innerText = `${data.fecha} - ${data.hora}`;

    const msgWhatsApp = encodeURIComponent(
      `¡Hola ${data.barberiaNombre}! 👋 Acabo de agendar una cita:\n\n` +
      `👤 Cliente: ${nombre}\n` +
      `✂️ Servicio: ${data.servicioNombre}\n` +
      `📅 Fecha: ${data.fecha}\n` +
      `⏰ Hora: ${data.hora}\n` +
      `🔖 Código: ${data.codigoReserva}\n\n` +
      `¡Quedo atento a su confirmación!`
    );

    const cleanPhone = (data.barberiaWhatsApp || '').replace(/[^0-9]/g, '');
    document.getElementById('modal-btn-whatsapp').href = `https://wa.me/${cleanPhone}?text=${msgWhatsApp}`;
    document.getElementById('success-modal').classList.remove('hidden');

    confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 } });
  } catch (err) {
    alert('No se pudo conectar con el servidor.');
    btn.disabled = false;
    btn.innerText = 'Confirmar Cita Ahora';
  }
}

function cerrarModal() {
  document.getElementById('success-modal').classList.add('hidden');
  window.location.reload();
}

// 6. Sistema de Valoración por Estrellas (Clientes)
let estrellasSeleccionadas = 5;

function abrirModalValoracion() {
  document.getElementById('modal-valoracion').classList.remove('hidden');
  seleccionarEstrella(5);
}

function cerrarModalValoracion() {
  document.getElementById('modal-valoracion').classList.add('hidden');
}

function seleccionarEstrella(num) {
  estrellasSeleccionadas = num;
  document.getElementById('val-estrellas').value = num;

  const descripciones = {
    1: 'Mala (1 de 5)',
    2: 'Regular (2 de 5)',
    3: 'Buena (3 de 5)',
    4: 'Muy Buena (4 de 5)',
    5: 'Excelente (5 de 5)'
  };
  const descEl = document.getElementById('label-estrellas-desc');
  if (descEl) descEl.innerText = descripciones[num] || `${num} de 5`;

  const buttons = document.querySelectorAll('.star-rating-btn');
  buttons.forEach((btn, idx) => {
    if (idx < num) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

async function enviarValoracionCliente(e) {
  e.preventDefault();
  const nombre = document.getElementById('val-nombre').value.trim();
  const comentario = document.getElementById('val-comentario').value.trim();
  const estrellas = parseInt(document.getElementById('val-estrellas').value) || 5;

  const btn = document.getElementById('btn-enviar-valoracion');
  btn.disabled = true;
  btn.innerText = 'Enviando...';

  try {
    const res = await fetch('/api/public/valoraciones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        barberiaSlug: barberia.slug,
        nombreCliente: nombre,
        estrellas: estrellas,
        comentario: comentario
      })
    });

    if (res.ok) {
      alert('¡Muchas gracias por calificar a ' + barberia.nombre + '! ⭐');
      cerrarModalValoracion();
      // Recargar datos para refrescar promedio y contador
      const ref = await fetch(`/api/public/barberia/${barberia.slug}`);
      if (ref.ok) {
        barberia = await ref.json();
        renderEncabezado();
      }
    } else {
      alert('No se pudo enviar la calificación.');
    }
  } catch (err) {
    alert('Error al conectar con el servidor.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="send" class="w-4 h-4"></i> Publicar Calificación';
    lucide.createIcons();
  }
}

window.addEventListener('DOMContentLoaded', initClient);
