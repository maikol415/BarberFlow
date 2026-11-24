// Cálculo de turnos libres (mismas reglas que la página de reservas), para el panel del barbero.
//   TurnosBF.calcular(barberia, servicio, '2026-11-26', barberoId, { anticipacion: 0 }) -> [540, 580, ...] (minutos del día)
// barberia: datos de /api/public/barberia/{slug} (horario, días laborales, bloqueos, citasOcupadas, miembros)
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

  function diaCerrado(b, iso) {
    return (b.bloqueos || []).find(x => x.fecha === iso && (!x.hora || x.hora === 'TODO_EL_DIA')) || null;
  }

  function diaLaborable(b, iso) {
    const dias = String(b.diasLaborales || '1,2,3,4,5,6').split(',').map(d => Number(d.trim()));
    return dias.includes(diaSemana(iso)) && !diaCerrado(b, iso);
  }

  const variosBarberos = b => !!b.mostrarSelectorBarbero && (b.miembros || []).length > 1;

  // Turnos de una sola agenda (barberoId = null: toda la barbería)
  function turnosDe(b, servicio, iso, barberoId, anticipacion) {
    if (!servicio || !diaLaborable(b, iso)) return [];
    const ahora = ahoraBogota();
    const dif = diasEntre(ahora.iso, iso);
    if (dif < 0) return [];

    const intervalo = b.intervaloMinutos || 40;
    const duracion = servicio.duracionMinutos || intervalo;
    const apertura = aMinutos(b.horaApertura || '09:00');
    const cierre = aMinutos(b.horaCierre || '20:00');
    const minimoDelDia = ahora.minutos + anticipacion - dif * 1440;

    const ocupados = (b.citasOcupadas || [])
      .filter(c => c.fecha === iso)
      .filter(c => barberoId == null || c.miembroEquipoId == null || c.miembroEquipoId === barberoId)
      .map(c => { const ini = aMinutos(c.hora); return { ini, fin: ini + (c.duracionMinutos || intervalo) }; });
    (b.bloqueos || []).filter(x => x.fecha === iso && x.hora && x.hora !== 'TODO_EL_DIA').forEach(x => {
      if (x.hora.includes('-')) { const [d, h] = x.hora.split('-'); ocupados.push({ ini: aMinutos(d), fin: aMinutos(h) }); }
      else { const ini = aMinutos(x.hora); ocupados.push({ ini, fin: ini + intervalo }); }
    });

    const turnos = [];
    let cursor = Math.max(apertura, Math.ceil(minimoDelDia / 10) * 10);
    let vueltas = 0;
    while (cursor + duracion <= cierre + 15 && cursor < cierre && vueltas++ < 500) {
      const choque = ocupados.find(o => cursor < o.fin && cursor + duracion > o.ini);
      if (!choque) { turnos.push(cursor); cursor += intervalo; }
      else cursor = Math.max(cursor + 10, Math.ceil((choque.fin + 10) / 10) * 10);
    }
    return turnos;
  }

  function calcular(b, servicio, iso, barberoId = null, { anticipacion = b.minutosAnticipacion ?? 30 } = {}) {
    if (!variosBarberos(b)) return turnosDe(b, servicio, iso, null, anticipacion);
    if (barberoId != null) return turnosDe(b, servicio, iso, barberoId, anticipacion);
    const todos = new Set();
    b.miembros.forEach(m => turnosDe(b, servicio, iso, m.id, anticipacion).forEach(t => todos.add(t)));
    return [...todos].sort((x, y) => x - y);
  }

  window.TurnosBF = { calcular, diaLaborable, diaCerrado, ahoraBogota, sumarDias, diaSemana, aMinutos, minutosATexto, minutosAValor, variosBarberos };
})();
