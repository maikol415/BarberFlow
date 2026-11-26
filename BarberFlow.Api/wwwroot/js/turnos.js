// Cálculo de turnos libres, compartido por la página de reservas y el panel del barbero.
//   TurnosBF.calcular(barberia, servicio, '2026-11-26', barberoId, { anticipacion: 0 }) -> [540, 580, ...] (minutos del día)
// barberia: datos de /api/public/barberia/{slug} (horarioSemanal, bloqueos, citasOcupadas, miembros con su horario)
// El horario de cada día puede tener varios rangos (ej. 9:00–12:00 y 14:00–20:00); cada barbero puede tener el suyo.
(function () {
  const isoAUtc = iso => { const [a, m, d] = iso.split('-').map(Number); return Date.UTC(a, m - 1, d, 12); };
  const diaSemana = iso => new Date(isoAUtc(iso)).getUTCDay();
  const sumarDias = (iso, n) => new Date(isoAUtc(iso) + n * 86400000).toISOString().slice(0, 10);
  const diasEntre = (desde, hasta) => Math.round((isoAUtc(hasta) - isoAUtc(desde)) / 86400000);

  // "04:30pm", "4:30 PM" o "16:30" -> minutos desde medianoche
  function aMinutos(hora) {
    const t = String(hora || '').toLowerCase().trim();
    const m = t.match(/(\d{1,2}):(\d{2})/);
    if (!m) return 0;
    let h = Number(m[1]);
    if (t.includes('pm') && h < 12) h += 12;
    if (t.includes('am') && h === 12) h = 0;
    return h * 60 + Number(m[2]);
  }
  const minutosATexto = min => { const h = Math.floor(min / 60), m = min % 60; return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`; };
  // Formato con el que se guarda la cita: "06:50pm"
  const minutosAValor = min => { const h = Math.floor(min / 60), m = min % 60; return `${String(h % 12 || 12).padStart(2, '0')}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`; };

  function ahoraBogota() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date()).map(x => [x.type, x.value]));
    return { iso: `${p.year}-${p.month}-${p.day}`, minutos: (Number(p.hour) % 24) * 60 + Number(p.minute) };
  }

  const variosBarberos = b => !!b.mostrarSelectorBarbero && (b.miembros || []).length > 1;

  // Horario de la barbería (o el armado con apertura/cierre/días de antes, si la barbería aún no lo configuró)
  function horarioBarberia(b) {
    if (b.horarioSemanal && Object.keys(b.horarioSemanal).length) return b.horarioSemanal;
    const dias = String(b.diasLaborales || '1,2,3,4,5,6').split(',').map(d => d.trim());
    const h = {};
    for (let d = 0; d <= 6; d++) {
      const abierto = dias.includes(String(d));
      h[d] = { cerrado: !abierto, rangos: abierto ? [{ desde: b.horaApertura || '09:00', hasta: b.horaCierre || '20:00' }] : [] };
    }
    return h;
  }

  // Horario que aplica: el propio del barbero (si tiene y hay varios barberos), si no el de la barbería
  function horarioDe(b, barberoId) {
    if (barberoId != null && variosBarberos(b)) {
      const m = (b.miembros || []).find(x => x.id === barberoId);
      if (m && m.horarioSemanal) return m.horarioSemanal;
    }
    return horarioBarberia(b);
  }

  // [{ ini, fin }] en minutos del día
  function rangosDelDia(b, iso, barberoId = null) {
    const d = horarioDe(b, barberoId)[String(diaSemana(iso))];
    if (!d || d.cerrado) return [];
    return (d.rangos || []).map(r => ({ ini: aMinutos(r.desde), fin: aMinutos(r.hasta) }))
      .filter(r => r.fin > r.ini).sort((x, y) => x.ini - y.ini);
  }

  function diaCerrado(b, iso) {
    return (b.bloqueos || []).find(x => x.fecha === iso && (!x.hora || x.hora === 'TODO_EL_DIA')) || null;
  }

  // ¿Se atiende ese día? Con varios barberos y sin barbero elegido: si al menos uno trabaja
  function diaLaborable(b, iso, barberoId = null) {
    if (diaCerrado(b, iso)) return false;
    if (variosBarberos(b) && barberoId == null) return b.miembros.some(m => rangosDelDia(b, iso, m.id).length > 0);
    return rangosDelDia(b, iso, barberoId).length > 0;
  }

  // Turnos de una sola agenda (barberoId = null: toda la barbería con su horario general)
  function turnosDe(b, servicio, iso, barberoId, anticipacion, excluir) {
    if (!servicio || diaCerrado(b, iso)) return [];
    const rangos = rangosDelDia(b, iso, barberoId);
    if (!rangos.length) return [];
    const ahora = ahoraBogota();
    const dif = diasEntre(ahora.iso, iso);
    if (dif < 0) return [];

    const intervalo = b.intervaloMinutos || 40;
    const duracion = servicio.duracionMinutos || intervalo;
    const minimoDelDia = ahora.minutos + anticipacion - dif * 1440;

    const ocupados = (b.citasOcupadas || [])
      .filter(c => c.fecha === iso)
      .filter(c => barberoId == null || c.miembroEquipoId == null || c.miembroEquipoId === barberoId)
      // Al reagendar, el turno de la cita que se está cambiando cuenta como libre
      .filter(c => !(excluir && c.fecha === excluir.fecha && aMinutos(c.hora) === aMinutos(excluir.hora)))
      .map(c => { const ini = aMinutos(c.hora); return { ini, fin: ini + (c.duracionMinutos || intervalo) }; });
    (b.bloqueos || []).filter(x => x.fecha === iso && x.hora && x.hora !== 'TODO_EL_DIA').forEach(x => {
      if (x.hora.includes('-')) { const [d, h] = x.hora.split('-'); ocupados.push({ ini: aMinutos(d), fin: aMinutos(h) }); }
      else { const ini = aMinutos(x.hora); ocupados.push({ ini, fin: ini + intervalo }); }
    });

    const turnos = [];
    for (const r of rangos) {
      // Cada rango empieza en su hora (o en "ahora + anticipación", redondeado a 10 min)
      let cursor = Math.max(r.ini, Math.ceil(minimoDelDia / 10) * 10);
      let vueltas = 0;
      while (cursor + duracion <= r.fin + 15 && cursor < r.fin && vueltas++ < 500) {
        const choque = ocupados.find(o => cursor < o.fin && cursor + duracion > o.ini);
        if (!choque) { turnos.push(cursor); cursor += intervalo; }
        else cursor = Math.max(cursor + 10, Math.ceil((choque.fin + 10) / 10) * 10);
      }
    }
    return turnos;
  }

  function calcular(b, servicio, iso, barberoId = null, { anticipacion = b.minutosAnticipacion ?? 30, excluir = null } = {}) {
    if (!variosBarberos(b)) return turnosDe(b, servicio, iso, null, anticipacion, excluir);
    if (barberoId != null) return turnosDe(b, servicio, iso, barberoId, anticipacion, excluir);
    const todos = new Set();
    b.miembros.forEach(m => turnosDe(b, servicio, iso, m.id, anticipacion, excluir).forEach(t => todos.add(t)));
    return [...todos].sort((x, y) => x - y);
  }

  window.TurnosBF = {
    calcular, diaLaborable, diaCerrado, rangosDelDia, horarioBarberia, horarioDe, ahoraBogota,
    sumarDias, diaSemana, aMinutos, minutosATexto, minutosAValor, variosBarberos
  };
})();
