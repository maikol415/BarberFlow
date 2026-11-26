using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using BarberFlow.Api.Data;
using BarberFlow.Api.DTOs;
using BarberFlow.Api.Models;
using BarberFlow.Api.Services;

namespace BarberFlow.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class PublicController : ControllerBase
{
    private readonly AppDbContext _context;
    private readonly TokenService _tokens;

    public PublicController(AppDbContext context, TokenService tokens)
    {
        _context = context;
        _tokens = tokens;
    }

    private static int ConvertirHoraAMinutos(string hStr)
    {
        if (string.IsNullOrWhiteSpace(hStr)) return 0;
        var str = hStr.ToLower().Trim();
        var esPm = str.Contains("pm");
        var esAm = str.Contains("am");
        var clean = System.Text.RegularExpressions.Regex.Replace(str, @"[apm\s]", "");
        var parts = clean.Split(':');
        var hh = int.TryParse(parts[0], out var h) ? h : 0;
        var mm = parts.Length > 1 && int.TryParse(parts[1], out var m) ? m : 0;
        if (esPm && hh < 12) hh += 12;
        if (esAm && hh == 12) hh = 0;
        return hh * 60 + mm;
    }

    // Fecha de hoy en Colombia (yyyy-MM-dd), para no ofrecer citas que ya pasaron
    private static string FechaHoyColombia() => DateTime.UtcNow.AddHours(-5).ToString("yyyy-MM-dd");
    private static int MinutosAhoraColombia() { var t = DateTime.UtcNow.AddHours(-5); return t.Hour * 60 + t.Minute; }

    // Nombre y teléfono del cliente: longitud razonable y sin caracteres de HTML
    private static string? ValidarDatosCliente(string? nombre, string? telefono)
    {
        var n = (nombre ?? "").Trim();
        if (n.Length < 2 || n.Length > 60) return "Escribe tu nombre (entre 2 y 60 caracteres).";
        if (n.IndexOfAny(new[] { '<', '>', '"', '`' }) >= 0) return "El nombre contiene caracteres no permitidos.";
        var t = (telefono ?? "").Trim();
        var digitos = TelefonoHelper.SoloDigitos(t);
        if (digitos.Length < 7 || digitos.Length > 15 || t.Any(c => !(char.IsDigit(c) || c == '+' || c == ' ' || c == '-' || c == '(' || c == ')')))
            return "Número de teléfono no válido.";
        return null;
    }

    // Fecha (yyyy-MM-dd) y hora válidas, en día laboral, dentro del horario y no en el pasado
    private static string? ValidarFechaHora(Barberia barberia, string? fecha, string? hora, bool soloFormato = false)
    {
        if (string.IsNullOrWhiteSpace(fecha) || !DateTime.TryParseExact(fecha, "yyyy-MM-dd",
                System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var dia))
            return "Fecha no válida.";
        if (string.IsNullOrWhiteSpace(hora) || !System.Text.RegularExpressions.Regex.IsMatch(hora.Trim(), @"^\d{1,2}:\d{2}\s*([aApP][mM])?$"))
            return "Hora no válida.";
        if (soloFormato) return null;

        var hoy = FechaHoyColombia();
        if (string.CompareOrdinal(fecha, hoy) < 0) return "No puedes reservar en una fecha que ya pasó.";
        var maximoDias = barberia.DiasMaximoReserva > 0 ? barberia.DiasMaximoReserva : 30;
        var diasHastaCita = (dia - DateTime.ParseExact(hoy, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture)).TotalDays;
        if (diasHastaCita > maximoDias) return $"Esta barbería recibe reservas con máximo {maximoDias} días de anticipación.";

        var inicio = ConvertirHoraAMinutos(hora);
        if (fecha == hoy && inicio <= MinutosAhoraColombia())
            return "Esa hora ya pasó. Elige un horario más tarde.";
        // Anticipación mínima configurada por la barbería (5 min de tolerancia por el tiempo que tarda el cliente en confirmar)
        var anticipacion = Math.Max(0, barberia.MinutosAnticipacion);
        var minutosHastaCita = (dia - DateTime.ParseExact(hoy, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture)).TotalMinutes
                               + inicio - MinutosAhoraColombia();
        if (minutosHastaCita < anticipacion - 5)
            return anticipacion >= 60
                ? $"Esta barbería recibe reservas con al menos {anticipacion / 60} hora(s) de anticipación. Elige un horario más tarde."
                : $"Esta barbería recibe reservas con al menos {anticipacion} minutos de anticipación. Elige un horario más tarde.";
        return null;
    }

    // Las fotos se guardan como data URL en la base de datos. Para no inflar los datos de la barbería,
    // la página recibe un enlace corto (/api/public/imagen/miembro/5?v=...) y el navegador la descarga aparte
    // y la guarda en caché; "v" cambia cuando cambia la foto.
    private static string? UrlImagen(string? valor, string tipo, int id)
    {
        // Solo fotos en base64; los íconos SVG pequeños (avatar por defecto) se dejan tal cual
        if (string.IsNullOrEmpty(valor) || !System.Text.RegularExpressions.Regex.IsMatch(valor, @"^data:image/(png|jpeg|jpg|webp|gif);base64,")) return valor;
        uint hash = 2166136261;
        foreach (var c in valor) { hash ^= c; hash *= 16777619; }
        return $"/api/public/imagen/{tipo}/{id}?v={hash:x8}";
    }

    [HttpGet("imagen/{tipo}/{id:int}")]
    public async Task<IActionResult> Imagen(string tipo, int id)
    {
        string? valor = tipo switch
        {
            "logo" => await _context.Barberias.Where(b => b.Id == id).Select(b => b.LogoUrl).FirstOrDefaultAsync(),
            "portada" => await _context.Barberias.Where(b => b.Id == id).Select(b => b.PortadaUrl).FirstOrDefaultAsync(),
            "miembro" => await _context.Miembros.Where(m => m.Id == id && m.Activo).Select(m => m.FotoUrl).FirstOrDefaultAsync(),
            _ => null
        };
        if (string.IsNullOrEmpty(valor)) return NotFound();

        var m = System.Text.RegularExpressions.Regex.Match(valor, @"^data:image/(?<tipo>png|jpeg|jpg|webp|gif);base64,(?<datos>.+)$");
        if (!m.Success) return valor.StartsWith("https://") || valor.StartsWith("/") ? Redirect(valor) : NotFound();

        byte[] bytes;
        try { bytes = Convert.FromBase64String(m.Groups["datos"].Value); }
        catch (FormatException) { return NotFound(); }

        var mime = m.Groups["tipo"].Value == "jpg" ? "image/jpeg" : $"image/{m.Groups["tipo"].Value}";
        Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        return File(bytes, mime);
    }

    // ----- Reacciones a la portada y a la foto de perfil (❤️ 🔥 👏 😍) -----
    private static readonly string[] TiposReaccion = { "corazon", "fuego", "aplausos", "wow" };
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, (DateTime Desde, int Cuenta)> _limiteReacciones = new();
    public record ReaccionDto(string? Tipo, string? Anterior);

    private static Dictionary<string, int> LeerReacciones(string? json)
    {
        Dictionary<string, int>? guardadas = null;
        try { if (!string.IsNullOrWhiteSpace(json)) guardadas = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, int>>(json); }
        catch (System.Text.Json.JsonException) { }
        return TiposReaccion.ToDictionary(t => t, t => Math.Max(0, guardadas?.GetValueOrDefault(t) ?? 0));
    }

    // Una persona tiene una reacción por foto: "Anterior" se quita y "Tipo" se suma (Tipo null = quitar la suya)
    [HttpPost("barberia/{slug}/reaccion/{foto}")]
    public async Task<IActionResult> Reaccionar(string slug, string foto, [FromBody] ReaccionDto dto)
    {
        if (foto != "portada" && foto != "logo") return NotFound();
        var slugN = slug.ToLowerInvariant();
        var ip = IpVisitante();
        var ahoraUtc = DateTime.UtcNow;
        if (_limiteReacciones.Count > 5000)
            foreach (var viejo in _limiteReacciones.Where(k => ahoraUtc - k.Value.Desde > TimeSpan.FromHours(1)).Select(k => k.Key).ToList())
                _limiteReacciones.TryRemove(viejo, out _);
        var uso = _limiteReacciones.AddOrUpdate($"{ip}|{slugN}", (ahoraUtc, 1),
            (_, v) => ahoraUtc - v.Desde > TimeSpan.FromHours(1) ? (ahoraUtc, 1) : (v.Desde, v.Cuenta + 1));
        if (uso.Cuenta > 30) return StatusCode(429, new { message = "Demasiadas reacciones seguidas. Intenta más tarde." });

        var candado = _candadosReaccion.GetOrAdd(slugN, _ => new SemaphoreSlim(1, 1));
        await candado.WaitAsync();
        try
        {
        // Solo se leen los datos necesarios (no las fotos completas en base64)
        var esPortada = foto == "portada";
        var datos = await _context.Barberias.AsNoTracking()
            .Where(b => b.Slug == slugN)
            .Select(b => new
            {
                b.Id,
                TieneFoto = esPortada
                    ? b.PortadaUrl != "" && !b.PortadaUrl.StartsWith("preset:")
                    : b.LogoUrl != "" && !b.LogoUrl.StartsWith("data:image/svg"), // el avatar por defecto no cuenta
                Json = esPortada ? b.ReaccionesPortada : b.ReaccionesLogo
            })
            .FirstOrDefaultAsync();
        if (datos == null) return NotFound(new { message = "Barbería no encontrada." });
        if (!datos.TieneFoto) return NotFound(new { message = "Esta barbería no tiene esa foto." });

        var reacciones = LeerReacciones(datos.Json);
        if (dto.Anterior != null && reacciones.TryGetValue(dto.Anterior, out var antes) && antes > 0) reacciones[dto.Anterior] = antes - 1;
        if (dto.Tipo != null && reacciones.ContainsKey(dto.Tipo)) reacciones[dto.Tipo]++;
        var json = System.Text.Json.JsonSerializer.Serialize(reacciones);
        if (esPortada) await _context.Barberias.Where(b => b.Id == datos.Id).ExecuteUpdateAsync(s => s.SetProperty(b => b.ReaccionesPortada, json));
        else await _context.Barberias.Where(b => b.Id == datos.Id).ExecuteUpdateAsync(s => s.SetProperty(b => b.ReaccionesLogo, json));
        CachePublica.Invalidar(datos.Id);
        return Ok(reacciones);
        }
        finally { candado.Release(); }
    }

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, SemaphoreSlim> _candadosReaccion = new();

    [HttpGet("barberia/{slug}")]
    public async Task<IActionResult> ObtenerBarberia(string slug)
    {
        try
        {
            // Solo lo necesario para reservar: servicios y equipo activos, y bloqueos/citas de hoy en adelante
            var hoy = FechaHoyColombia();
            var slugNormal = (slug ?? "").ToLower();

            // Lo que cambia a cada rato (qué horas están libres) se consulta siempre
            async Task<IActionResult> ResponderConDisponibilidad(int barberiaId, System.Text.Json.Nodes.JsonObject datos)
            {
                var bloqueos = await _context.Bloqueos.AsNoTracking()
                    .Where(bl => bl.BarberiaId == barberiaId && string.Compare(bl.Fecha, hoy) >= 0)
                    .Select(bl => new { bl.Id, bl.Fecha, bl.Hora, bl.Motivo })
                    .ToListAsync();
                var ocupadas = await _context.Citas.AsNoTracking()
                    .Where(c => c.BarberiaId == barberiaId && c.Estado != "Cancelada" && c.Estado != "No Confirmada"
                                && string.Compare(c.Fecha, hoy) >= 0)
                    .Select(c => new
                    {
                        c.Id,
                        c.Fecha,
                        c.Hora,
                        c.MiembroEquipoId,
                        DuracionMinutos = c.Servicio != null ? c.Servicio.DuracionMinutos : 40
                    })
                    .ToListAsync();
                var opciones = new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web);
                datos["bloqueos"] = System.Text.Json.JsonSerializer.SerializeToNode(bloqueos, opciones);
                datos["citasOcupadas"] = System.Text.Json.JsonSerializer.SerializeToNode(ocupadas, opciones);
                return Content(datos.ToJsonString(), "application/json; charset=utf-8");
            }

            if (CachePublica.Obtener(slugNormal, out var idCache, out var datosCache))
                return await ResponderConDisponibilidad(idCache, datosCache);

            var barberia = await _context.Barberias
                .AsNoTracking()
                .Include(b => b.Servicios.Where(s => s.Activo))
                .Include(b => b.Miembros.Where(m => m.Activo))
                .AsSplitQuery()
                .FirstOrDefaultAsync(b => b.Slug == slugNormal);

            if (barberia == null)
            {
                return NotFound(new { message = "Barbería no encontrada." });
            }

            var botReglas = await _context.BotReglas
                .Where(r => r.BarberiaId == barberia.Id && r.Activo)
                .Select(r => new { r.Id, r.PalabrasClave, r.Respuesta })
                .ToListAsync();

            // Conteo real de agendamientos históricos en el sistema
            var totalAgendamientosReales = await _context.Citas
                .CountAsync(c => c.BarberiaId == barberia.Id);

            // Promedio y cantidad de reseñas calculados en la base de datos; solo se envían las 4 más recientes
            int totalValoraciones = 0;
            double calificacion = 5.0;
            object ultimasValoraciones = new List<object>();
            try
            {
                var resumen = await _context.Valoraciones
                    .Where(v => v.BarberiaId == barberia.Id)
                    .GroupBy(v => 1)
                    .Select(g => new { Total = g.Count(), Promedio = g.Average(v => (double)v.Estrellas) })
                    .FirstOrDefaultAsync();
                if (resumen != null)
                {
                    totalValoraciones = resumen.Total;
                    calificacion = Math.Round(resumen.Promedio, 1);
                }

                var recientes = await _context.Valoraciones
                    .Where(v => v.BarberiaId == barberia.Id)
                    .OrderByDescending(v => v.FechaUtc)
                    .Take(4)
                    .Select(v => new { v.NombreCliente, v.Estrellas, v.Comentario, v.FechaUtc })
                    .ToListAsync();
                ultimasValoraciones = recientes.Select(v => new
                {
                    v.NombreCliente,
                    v.Estrellas,
                    v.Comentario,
                    Fecha = v.FechaUtc.ToString("dd MMM yyyy")
                }).ToList();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Nota: Valoraciones no consultadas todavía: {ex.Message}");
            }

            var fija = new
            {
                barberia.Id,
                barberia.Nombre,
                barberia.Slug,
                barberia.Descripcion,
                barberia.Direccion,
                barberia.TelefonoWhatsApp,
                LogoUrl = UrlImagen(barberia.LogoUrl, "logo", barberia.Id),
                barberia.ColorPrimario,
                PortadaUrl = UrlImagen(barberia.PortadaUrl, "portada", barberia.Id),
                ReaccionesPortada = LeerReacciones(barberia.ReaccionesPortada),
                ReaccionesLogo = LeerReacciones(barberia.ReaccionesLogo),
                barberia.PortadaPosicion,
                barberia.PlantillaConfirmacion,
                barberia.PlantillaRecordatorio,
                barberia.HorarioTexto,
                barberia.HoraApertura,
                barberia.HoraCierre,
                barberia.IntervaloMinutos,
                barberia.MinutosAnticipacion,
                HorarioSemanal = HorarioSemanal.DeBarberia(barberia),
                barberia.DiasMaximoReserva,
                barberia.HorasLimiteCancelar,
                barberia.RecordatoriosActivos,
                barberia.HorasRecordatorio,
                barberia.HorasRecordatorios,
                barberia.MinutosPausaBot,
                barberia.PedirOpinionActivo,
                barberia.DiasLaborales,
                barberia.MostrarSelectorBarbero,
                barberia.DatosPago,
                barberia.NumeroNequi,
                barberia.NumeroDaviplata,
                barberia.TitularCuenta,
                barberia.BotActivo,
                barberia.MensajeBienvenidaBot,
                barberia.MensajeDerivacionHumana,
                barberia.AnuncioMatutinoActivo,
                barberia.HoraAnuncioSemana,
                barberia.HoraAnuncioSabado,
                barberia.HoraAnuncioDomingo,
                BotReglas = botReglas,
                Servicios = barberia.Servicios.Select(s => new
                {
                    s.Id,
                    s.Categoria,
                    s.Nombre,
                    s.Precio,
                    s.DuracionMinutos,
                    s.Descripcion,
                    s.Icono
                }),
                Miembros = barberia.Miembros.Select(m => new
                {
                    m.Id,
                    m.Nombre,
                    m.Rol,
                    FotoUrl = UrlImagen(m.FotoUrl, "miembro", m.Id),
                    HorarioSemanal = HorarioSemanal.DeMiembro(m)   // null = usa el de la barbería
                }),
                TotalAgendamientos = totalAgendamientosReales,
                TotalValoraciones = totalValoraciones,
                Calificacion = calificacion,
                UltimasValoraciones = ultimasValoraciones
            };
            var nodo = (System.Text.Json.Nodes.JsonObject)System.Text.Json.JsonSerializer.SerializeToNode(fija,
                new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))!;
            CachePublica.Guardar(slugNormal, barberia.Id, nodo);
            return await ResponderConDisponibilidad(barberia.Id, nodo);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Error barbería pública] {ex}");
            return StatusCode(500, new { message = "No pudimos cargar la barbería. Intenta de nuevo en un momento." });
        }
    }

    [HttpPost("citas")]
    public async Task<IActionResult> CrearCita([FromBody] CrearCitaPublicaDto dto)
    {
        // Límite anti-abuso (cada cita envía un WhatsApp): máx. 5 reservas por hora al mismo número y 150 por conexión
        var ipReserva = IpVisitante();
        if (User.Identity?.IsAuthenticated != true && ipReserva is not ("127.0.0.1" or "::1") && !RecuperacionClave.PermitirIp($"{ipReserva}|reservar", 400))
            return StatusCode(429, new { message = "Hiciste muchas reservas seguidas. Espera un rato o escríbele a la barbería por WhatsApp." });

        var barberia = await _context.Barberias
            .AsSplitQuery()
            .Include(b => b.Servicios)
            .Include(b => b.Bloqueos.Where(bl => bl.Fecha == dto.Fecha))
            .Include(b => b.Miembros.Where(m => m.Activo))
            .FirstOrDefaultAsync(b => b.Slug == dto.BarberiaSlug.ToLower());

        if (barberia == null)
        {
            return NotFound(new { message = "Barbería no encontrada." });
        }

        var errorDatos = ValidarDatosCliente(dto.NombreCliente, dto.TelefonoCliente);
        if (errorDatos != null) return BadRequest(new { message = errorDatos });

        // El barbero de esta barbería (con sesión) puede registrar clientes sin cita fuera de horario o a la hora actual
        var esBarberoDeEstaBarberia = User.FindFirst(PoliticasAuth.ClaimBarberiaId)?.Value == barberia.Id.ToString();
        var errorHorario = ValidarFechaHora(barberia, dto.Fecha, dto.Hora, soloFormato: esBarberoDeEstaBarberia);
        if (errorHorario != null) return BadRequest(new { message = errorHorario });

        if (dto.MiembroEquipoId.HasValue &&
            !await _context.Miembros.AnyAsync(m => m.Id == dto.MiembroEquipoId.Value && m.BarberiaId == barberia.Id && m.Activo))
        {
            return BadRequest(new { message = "El profesional seleccionado no es válido." });
        }

        var bloqueoDia = barberia.Bloqueos.Any(b => b.Fecha == dto.Fecha && (string.IsNullOrEmpty(b.Hora) || b.Hora == "TODO_EL_DIA"));
        if (bloqueoDia && !esBarberoDeEstaBarberia)
        {
            return BadRequest(new { message = "El profesional o la barbería no tiene horarios disponibles para este día. Intenta otro día." });
        }

        var servicio = barberia.Servicios.FirstOrDefault(s => s.Id == dto.ServicioId && s.Activo);
        if (servicio == null)
        {
            return BadRequest(new { message = "Servicio no válido." });
        }

        // Descansos y pausas: rango "14:00-15:30" o una hora suelta (dura un turno)
        if (!esBarberoDeEstaBarberia)
        {
            var inicioNuevo = ConvertirHoraAMinutos(dto.Hora);
            var finNuevo = inicioNuevo + servicio.DuracionMinutos;
            var chocaConDescanso = barberia.Bloqueos
                .Where(b => b.Fecha == dto.Fecha && !string.IsNullOrWhiteSpace(b.Hora) && b.Hora != "TODO_EL_DIA")
                .Any(b =>
                {
                    int desde, hasta;
                    if (b.Hora!.Contains('-'))
                    {
                        var partes = b.Hora.Split('-');
                        desde = ConvertirHoraAMinutos(partes[0]);
                        hasta = ConvertirHoraAMinutos(partes[1]);
                    }
                    else
                    {
                        desde = ConvertirHoraAMinutos(b.Hora);
                        hasta = desde + barberia.IntervaloMinutos;
                    }
                    return inicioNuevo < hasta && finNuevo > desde;
                });
            if (chocaConDescanso)
            {
                return BadRequest(new { message = "Ese horario coincide con un descanso de la barbería. Elige otro." });
            }
        }

        // Validación matemática de traslape con citas existentes según duración del servicio
        // Si es un reagendamiento (enlace con token), la cita original debe ser de esta barbería, del mismo teléfono y seguir vigente
        Cita? citaAnterior = null;
        if (!string.IsNullOrWhiteSpace(dto.ReagendarToken))
        {
            citaAnterior = await BuscarCitaPorToken(dto.ReagendarToken);
            if (citaAnterior == null || citaAnterior.BarberiaId != barberia.Id ||
                !TelefonoHelper.MismoTelefono(citaAnterior.TelefonoCliente, dto.TelefonoCliente))
            {
                return BadRequest(new { message = "No pudimos verificar la cita que quieres reagendar. Usa el mismo número de WhatsApp con el que reservaste." });
            }
            if (citaAnterior.Estado == "Cancelada" || citaAnterior.Estado == EstadosCitas.Completada || citaAnterior.Estado == EstadosCitas.NoConfirmada)
            {
                return BadRequest(new { message = "Esta cita ya fue cancelada o reagendada. Si quieres otro turno, reserva uno nuevo." });
            }
            var motivoReagendar = esBarberoDeEstaBarberia ? null : MotivoNoModificable(citaAnterior, barberia);
            if (motivoReagendar != null) return BadRequest(new { message = motivoReagendar });
        }

        var nuevoTurnoInicio = ConvertirHoraAMinutos(dto.Hora);
        var nuevoTurnoFin = nuevoTurnoInicio + servicio.DuracionMinutos;
        if (!esBarberoDeEstaBarberia && nuevoTurnoFin > ConvertirHoraAMinutos(barberia.HoraCierre) + 15)
        {
            return BadRequest(new { message = "Ese horario termina después del cierre de la barbería. Elige una hora más temprano." });
        }

        // Si dos personas reservan a la vez en la misma barbería, la segunda espera a que termine la primera
        // y ve su cita ya guardada (así nadie se queda con el mismo turno). En PostgreSQL con un candado por barbería;
        // en SQLite (local) las escrituras ya van una por una.
        await using var transaccion = await _context.Database.BeginTransactionAsync();
        if (_context.Database.IsNpgsql())
            await _context.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock({0})", 7_000_000 + barberia.Id);

        var citasDia = await _context.Citas
            .Include(c => c.Servicio)
            .Where(c => c.BarberiaId == barberia.Id && c.Fecha == dto.Fecha && c.Estado != "Cancelada" && c.Estado != "No Confirmada")
            .ToListAsync();

        // Horario del día: el de cada barbero si tiene uno propio, si no el de la barbería
        var diaSemana = DateTime.ParseExact(dto.Fecha, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture).DayOfWeek;
        bool AtiendeA(MiembroEquipo? m) =>
            esBarberoDeEstaBarberia || HorarioSemanal.Cabe(HorarioSemanal.RangosDelDia(barberia, m, diaSemana), nuevoTurnoInicio, nuevoTurnoFin);

        // ¿Choca con alguna cita? miembroId = null revisa todas (barbería de una sola silla).
        // Con un barbero concreto, solo chocan sus citas y las que no tienen barbero asignado.
        bool Choca(int? miembroId) => citasDia.Any(c =>
        {
            if (citaAnterior != null && c.Id == citaAnterior.Id) return false;
            if (miembroId != null && c.MiembroEquipoId != null && c.MiembroEquipoId != miembroId) return false;
            var existIni = ConvertirHoraAMinutos(c.Hora);
            var existDur = c.Servicio?.DuracionMinutos ?? barberia.IntervaloMinutos;
            var existFin = existIni + existDur;
            return nuevoTurnoInicio < existFin && nuevoTurnoFin > existIni;
        });

        var citasCorridas = new List<CorrimientoCitas.Cambio>();

        // Varios barberos: cada uno tiene su agenda. Si el cliente eligió "Cualquiera",
        // se le asigna el barbero libre a esa hora con menos citas ese día (así siempre sabe con quién va).
        var miembrosActivos = barberia.Miembros.Where(m => m.Activo).OrderBy(m => m.Id).ToList();
        var variosBarberos = barberia.MostrarSelectorBarbero && miembrosActivos.Count > 1;
        int? miembroAsignado = dto.MiembroEquipoId;
        // El cliente escoge su barbero; el barbero desde su panel sí puede dejar "Cualquiera"
        if (miembroAsignado == null && variosBarberos && !esBarberoDeEstaBarberia)
            return BadRequest(new { message = "Elige con qué barbero quieres tu cita." });
        if (miembroAsignado == null && variosBarberos)
        {
            miembroAsignado = miembrosActivos
                .Where(m => AtiendeA(m) && !Choca(m.Id))
                .OrderBy(m => citasDia.Count(c => c.MiembroEquipoId == m.Id))
                .Select(m => (int?)m.Id)
                .FirstOrDefault();
            if (miembroAsignado == null)
                return BadRequest(new { message = "Ese horario ya está ocupado con todos los barberos. Por favor elige otro horario." });
        }
        else
        {
            if (miembroAsignado == null && miembrosActivos.Count == 1) miembroAsignado = miembrosActivos[0].Id;
            var miembroElegido = variosBarberos ? miembrosActivos.FirstOrDefault(m => m.Id == miembroAsignado) : null;
            if (!AtiendeA(miembroElegido))
                return BadRequest(new { message = variosBarberos
                    ? "Ese barbero no atiende a esa hora. Elige otro horario u otro barbero."
                    : "Esa hora está fuera del horario de atención. Elige otro horario." });
            if (variosBarberos ? Choca(miembroAsignado) : Choca(null))
            {
                // El barbero, desde el local, puede correr las citas siguientes de esa agenda para hacerle espacio
                if (!(esBarberoDeEstaBarberia && dto.CorrerSiguientes))
                    return BadRequest(new { message = "Ese horario o parte de su duración ya fue reservado. Por favor elige otro horario." });

                var agenda = citasDia
                    .Where(c => citaAnterior == null || c.Id != citaAnterior.Id)
                    .Where(c => !variosBarberos || c.MiembroEquipoId == null || c.MiembroEquipoId == miembroAsignado)
                    .ToList();
                var (cambios, bloqueante) = CorrimientoCitas.Planear(agenda, nuevoTurnoInicio, nuevoTurnoFin, barberia.IntervaloMinutos);
                if (bloqueante != null)
                    return BadRequest(new { message = $"Se cruza con la cita de {bloqueante.NombreCliente} ({bloqueante.Hora}), que empieza antes y todavía no termina. Elige otra hora." });
                foreach (var cambio in cambios) cambio.Cita.Hora = cambio.HoraNueva;
                citasCorridas = cambios;
            }
        }
        var nombreBarbero = miembrosActivos.FirstOrDefault(m => m.Id == miembroAsignado)?.Nombre ?? "";

        // Máx. 5 reservas por hora al mismo número (solo cuentan las que sí se crean; cada una envía un WhatsApp)
        var digitosReserva = TelefonoHelper.SoloDigitos(dto.TelefonoCliente ?? "");
        if (!esBarberoDeEstaBarberia && !RecuperacionClave.PermitirIp($"reservar|{barberia.Id}|{digitosReserva}", 5))
            return StatusCode(429, new { message = "Ya hiciste varias reservas seguidas con este número. Espera un rato o escríbele a la barbería por WhatsApp." });

        var codigoReserva = $"#BF-{Random.Shared.Next(1000, 9999)}";

        var cita = new Cita
        {
            BarberiaId = barberia.Id,
            ServicioId = servicio.Id,
            MiembroEquipoId = miembroAsignado,
            CodigoReserva = codigoReserva,
            NombreCliente = dto.NombreCliente.Trim(),
            TelefonoCliente = dto.TelefonoCliente.Trim(),
            Fecha = dto.Fecha,
            Hora = dto.Hora,
            Total = servicio.Precio,
            Estado = "Confirmada",
            TokenPublico = Cita.NuevoTokenPublico()
        };

        // Si es un reagendamiento, cancelar automáticamente la cita anterior (ya verificada arriba)
        if (citaAnterior != null)
        {
            citaAnterior.Estado = "Cancelada";
        }

        _context.Citas.Add(cita);

        // Si estaba en la lista de espera de ese día, ya consiguió su turno
        var digitosCliente = new string(cita.TelefonoCliente.Where(char.IsDigit).ToArray());
        var enEspera = (await _context.ListaEspera
                .Where(l => l.BarberiaId == barberia.Id && l.Fecha == cita.Fecha && l.Estado != ListaEsperaAvisos.Reservo)
                .ToListAsync())
            .Where(l => digitosCliente.Length >= 7 && new string(l.TelefonoCliente.Where(char.IsDigit).ToArray()).EndsWith(digitosCliente[^7..]))
            .ToList();
        foreach (var l in enEspera) l.Estado = ListaEsperaAvisos.Reservo;

        await _context.SaveChangesAsync();
        await transaccion.CommitAsync();

        if (citaAnterior != null) ListaEsperaAvisos.TurnoLiberado(barberia.Id, citaAnterior.Fecha, citaAnterior.Hora, citaAnterior.MiembroEquipoId);

        // 🚀 NOTIFICACIÓN AUTOMÁTICA AL BOT DE WHATSAPP (segundo plano, solo la barbería del bot)
        NotificarBot("/api/notificar-cita", barberia, new
        {
            citaId = cita.Id,
            tokenPublico = cita.TokenPublico,
            codigoReserva = cita.CodigoReserva,
            barberiaSlug = barberia.Slug,
            barberiaNombre = barberia.Nombre,
            barberiaDireccion = barberia.Direccion,
            barberiaTelefono = barberia.TelefonoWhatsApp,
            nombreCliente = cita.NombreCliente,
            telefonoCliente = cita.TelefonoCliente,
            servicio = servicio.Nombre,
            duracionMinutos = servicio.DuracionMinutos,
            fecha = cita.Fecha,
            hora = cita.Hora,
            total = cita.Total,
            barbero = nombreBarbero,
            esReagendamiento = citaAnterior != null,
            creadaPorBarbero = esBarberoDeEstaBarberia   // anotada en el local: no se le pide confirmar con SI
        });

        // 🔔 Notificación al celular del barbero (si la cita no la anotó él mismo desde el panel)
        if (!esBarberoDeEstaBarberia)
        {
            var conQuien = string.IsNullOrWhiteSpace(nombreBarbero) || miembrosActivos.Count <= 1 ? "" : $" · con {nombreBarbero}";
            var cuando = $"{NotificacionesPush.TextoFecha(cita.Fecha)}, {NotificacionesPush.TextoHora(cita.Hora)}";
            if (citaAnterior != null)
                NotificacionesPush.Avisar(barberia.Id, NotificacionesPush.Nueva,
                    $"🔁 {cita.NombreCliente} cambió su cita",
                    $"Ahora: {cuando}{conQuien} (antes: {NotificacionesPush.TextoFecha(citaAnterior.Fecha)}, {NotificacionesPush.TextoHora(citaAnterior.Hora)})",
                    $"cita-{cita.Id}");
            else
                NotificacionesPush.Avisar(barberia.Id, NotificacionesPush.Nueva,
                    $"📅 Nueva cita: {cita.NombreCliente}",
                    $"{servicio.Nombre} · {cuando}{conQuien}",
                    $"cita-{cita.Id}");
        }

        // Citas que se corrieron para hacerle espacio: a cada cliente se le avisa su nueva hora
        if (citasCorridas.Count > 0)
        {
            NotificarBot("/api/notificar-cambio-hora", barberia, new
            {
                barberiaSlug = barberia.Slug,
                barberiaNombre = barberia.Nombre,
                citas = citasCorridas.Select(cm => new
                {
                    id = cm.Cita.Id,
                    nombreCliente = cm.Cita.NombreCliente,
                    telefonoCliente = cm.Cita.TelefonoCliente,
                    servicio = cm.Cita.Servicio?.Nombre ?? "",
                    fecha = cm.Cita.Fecha,
                    horaAnterior = cm.HoraAnterior,
                    horaNueva = cm.HoraNueva,
                    tokenPublico = cm.Cita.TokenPublico
                })
            });
        }

        return Ok(new
        {
            cita.Id,
            cita.CodigoReserva,
            cita.Fecha,
            cita.Hora,
            cita.Total,
            ServicioNombre = servicio.Nombre,
            BarberoNombre = nombreBarbero,
            BarberiaWhatsApp = barberia.TelefonoWhatsApp,
            BarberiaNombre = barberia.Nombre,
            AvisoPorWhatsApp = BotAtiende(barberia),
            CitasCorridas = citasCorridas.Select(cm => new { cm.Cita.NombreCliente, cm.Cita.TelefonoCliente, cm.Cita.Fecha, cm.HoraAnterior, cm.HoraNueva })
        });
    }

    // Lista de espera: el cliente se anota para un día lleno y le avisamos si se libera un turno
    [HttpPost("lista-espera")]
    public async Task<IActionResult> AnotarseListaEspera([FromBody] ListaEsperaDto dto)
    {
        var digitosEspera = TelefonoHelper.SoloDigitos(dto.TelefonoCliente ?? "");
        if (!RecuperacionClave.PermitirIp($"lista-espera|{dto.BarberiaSlug}|{digitosEspera}", 5) || !RecuperacionClave.PermitirIp($"{IpVisitante()}|lista-espera", 100))
            return StatusCode(429, new { message = "Demasiados intentos seguidos. Espera un rato e inténtalo de nuevo." });
        var barberia = await _context.Barberias
            .Include(b => b.Servicios)
            .Include(b => b.Miembros.Where(m => m.Activo))
            .FirstOrDefaultAsync(b => b.Slug == (dto.BarberiaSlug ?? "").ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        var errorDatos = ValidarDatosCliente(dto.NombreCliente, dto.TelefonoCliente);
        if (errorDatos != null) return BadRequest(new { message = errorDatos });

        var hoy = EstadosCitas.AhoraColombia().Date;
        if (!DateTime.TryParseExact(dto.Fecha, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out var dia) || dia < hoy || dia > hoy.AddDays(barberia.DiasMaximoReserva))
            return BadRequest(new { message = "Elige un día dentro de los que la barbería recibe reservas." });

        var servicio = barberia.Servicios.FirstOrDefault(s => s.Id == dto.ServicioId && s.Activo);
        if (servicio == null) return BadRequest(new { message = "Elige un servicio." });
        int? miembroId = dto.MiembroEquipoId is int m && barberia.Miembros.Any(x => x.Id == m) ? m : null;
        var franja = ListaEsperaAvisos.Franjas.Contains(dto.Franja) ? dto.Franja! : "todo";

        var telefono = dto.TelefonoCliente.Trim();
        var digitos = new string(telefono.Where(char.IsDigit).ToArray());
        var delDia = await _context.ListaEspera.Where(l => l.BarberiaId == barberia.Id && l.Fecha == dto.Fecha).ToListAsync();
        var existente = delDia.FirstOrDefault(l => new string(l.TelefonoCliente.Where(char.IsDigit).ToArray()) == digitos);
        var esNuevo = existente == null || existente.Estado == ListaEsperaAvisos.Reservo;
        if (existente == null)
        {
            if (delDia.Count(l => l.Estado != ListaEsperaAvisos.Reservo) >= 30)
                return BadRequest(new { message = "La lista de espera de ese día ya está llena. Escríbele a la barbería por WhatsApp." });
            existente = new ListaEspera { BarberiaId = barberia.Id, Fecha = dto.Fecha };
            _context.ListaEspera.Add(existente);
        }
        existente.NombreCliente = dto.NombreCliente.Trim();
        existente.TelefonoCliente = telefono;
        existente.ServicioId = servicio.Id;
        existente.MiembroEquipoId = miembroId;
        existente.Franja = franja;
        existente.Estado = ListaEsperaAvisos.Esperando;
        existente.CreadoUtc = existente.Id == 0 ? DateTime.UtcNow : existente.CreadoUtc;
        await _context.SaveChangesAsync();

        if (esNuevo) NotificacionesPush.Avisar(barberia.Id, NotificacionesPush.Nueva,
            $"📋 Lista de espera: {existente.NombreCliente}",
            $"Quiere turno {NotificacionesPush.TextoFecha(dto.Fecha)} {ListaEsperaAvisos.TextoFranja(franja)} · {servicio.Nombre}",
            $"espera-{existente.Id}");

        var conBot = BotAtiende(barberia);
        return Ok(new
        {
            message = conBot
                ? "¡Listo! Si se libera un turno ese día te avisamos por WhatsApp."
                : "¡Listo! Si se libera un turno ese día, el barbero te escribirá por WhatsApp.",
            avisoPorWhatsApp = conBot
        });
    }

    // El gestor del bot pregunta al arrancar qué barberías tienen su WhatsApp vinculado
    [RequiereBotKey]
    [HttpGet("bot/barberias")]
    public async Task<IActionResult> BarberiasConBot()
    {
        var antiguo = SlugBotAntiguo?.ToLower() ?? "";
        var slugs = await _context.Barberias
            .Where(b => b.BotWhatsApp || b.Slug == antiguo)
            .Select(b => b.Slug)
            .ToListAsync();
        return Ok(new { slugs });
    }

    [Authorize(Policy = PoliticasAuth.Cliente)]
    [HttpPost("valoraciones")]
    public async Task<IActionResult> EnviarValoracion([FromBody] ValoracionDto dto)
    {
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == dto.BarberiaSlug.ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        // Solo opinan clientes de esta barbería que ya fueron atendidos (evita reseñas falsas)
        var cliente = await ObtenerClienteAutenticado();
        if (cliente == null || cliente.BarberiaId != barberia.Id)
            return Unauthorized(new { message = "Inicia sesión con tu cuenta de esta barbería para opinar." });
        var fueAtendido = (await CitasDelCliente(cliente)).Any(c => c.Estado == EstadosCitas.Completada);
        if (!fueAtendido)
            return BadRequest(new { message = "Podrás opinar después de tu primera cita atendida en esta barbería." });
        var hace30Dias = DateTime.UtcNow.AddDays(-30);
        if (await _context.Valoraciones.AnyAsync(v => v.BarberiaId == barberia.Id && v.NombreCliente == cliente.Nombre && v.FechaUtc > hace30Dias))
            return BadRequest(new { message = "Ya dejaste tu opinión este mes. ¡Gracias!" });

        if (dto.Estrellas < 1 || dto.Estrellas > 5)
        {
            return BadRequest(new { message = "La valoración debe ser de 1 a 5 estrellas." });
        }
        if ((dto.NombreCliente ?? "").Length > 60 || (dto.Comentario ?? "").Length > 500)
        {
            return BadRequest(new { message = "El nombre o el comentario son demasiado largos." });
        }

        var val = new Valoracion
        {
            BarberiaId = barberia.Id,
            NombreCliente = cliente.Nombre,
            Estrellas = dto.Estrellas,
            Comentario = dto.Comentario?.Trim() ?? string.Empty,
            FechaUtc = DateTime.UtcNow
        };

        _context.Valoraciones.Add(val);
        await _context.SaveChangesAsync();
        CachePublica.Invalidar(val.BarberiaId);

        return Ok(new { message = "¡Gracias por tu valoración!" });
    }

    // Busca una cita por su token público (los enlaces de reseña/reagendar nunca usan el Id secuencial)
    private async Task<Cita?> BuscarCitaPorToken(string? token)
    {
        token = token?.Trim().ToLowerInvariant();
        if (token == null || token.Length != Cita.LargoTokenPublico || !token.All(Uri.IsHexDigit)) return null;
        return await _context.Citas
            .Include(c => c.Servicio)
            .FirstOrDefaultAsync(c => c.TokenPublico == token);
    }

    // La cita ya empezó (hora Colombia): solo entonces se puede reseñar
    private static bool CitaYaComenzo(Cita c)
    {
        var cmp = string.CompareOrdinal(c.Fecha, FechaHoyColombia());
        if (cmp != 0) return cmp < 0;
        return ConvertirHoraAMinutos(c.Hora) <= MinutosAhoraColombia();
    }

    private static string? MotivoNoCalificable(Cita c)
    {
        if (c.CalificadaUtc != null) return "Ya calificaste esta cita. ¡Gracias por tu opinión!";
        if (c.Estado == "Cancelada") return "Esta cita fue cancelada, por eso no se puede calificar.";
        // Solo se califica un servicio que se prestó (cita confirmada o completada)
        if (c.Estado == EstadosCitas.NoConfirmada || c.Estado == EstadosCitas.Pendiente && CitaYaComenzo(c))
            return "Esta cita no se confirmó, por eso no se puede calificar.";
        if (!CitaYaComenzo(c)) return "Podrás calificar tu servicio después de tu cita.";
        return null;
    }

    // 🌟 RESEÑA POST-CITA VERIFICADA / REAGENDAR (ENLACE CON TOKEN ENVIADO POR WHATSAPP)
    [HttpGet("cita-resena/{token}")]
    public async Task<IActionResult> ObtenerDatosResena(string token)
    {
        var cita = await BuscarCitaPorToken(token);
        if (cita == null) return NotFound(new { message = "Cita no encontrada." });

        var barberia = await _context.Barberias.FindAsync(cita.BarberiaId);
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        var motivo = MotivoNoCalificable(cita);
        return Ok(new
        {
            cita.NombreCliente,
            cita.Fecha,
            cita.Hora,
            cita.Estado,
            Servicio = cita.Servicio?.Nombre ?? "Servicio",
            cita.MiembroEquipoId,   // al reagendar, se propone el mismo barbero
            BarberiaNombre = barberia.Nombre,
            BarberiaSlug = barberia.Slug,
            YaCalificada = cita.CalificadaUtc != null,
            PuedeCalificar = motivo == null,
            MotivoNoCalificable = motivo
        });
    }

    [HttpPost("calificar-cita")]
    public async Task<IActionResult> CalificarCita([FromBody] ReseñaCitaDto dto)
    {
        var cita = await BuscarCitaPorToken(dto.Token);
        if (cita == null) return NotFound(new { message = "Cita no encontrada." });

        if (dto.Estrellas < 1 || dto.Estrellas > 5)
        {
            return BadRequest(new { message = "La calificación debe ser de 1 a 5 estrellas." });
        }
        if ((dto.Comentario ?? "").Length > 500)
        {
            return BadRequest(new { message = "El comentario es demasiado largo (máximo 500 caracteres)." });
        }

        var motivo = MotivoNoCalificable(cita);
        if (motivo != null)
        {
            return cita.CalificadaUtc != null ? Conflict(new { message = motivo }) : BadRequest(new { message = motivo });
        }

        await using var tx = await _context.Database.BeginTransactionAsync();

        // Marcar la cita como calificada de forma atómica: si llegan dos envíos a la vez, solo uno gana
        var ahora = DateTime.UtcNow;
        var marcadas = await _context.Citas
            .Where(c => c.Id == cita.Id && c.CalificadaUtc == null)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.CalificadaUtc, ahora));
        if (marcadas == 0)
        {
            return Conflict(new { message = "Ya calificaste esta cita. ¡Gracias por tu opinión!" });
        }

        _context.Valoraciones.Add(new Valoracion
        {
            BarberiaId = cita.BarberiaId,
            NombreCliente = cita.NombreCliente,
            Estrellas = dto.Estrellas,
            Comentario = dto.Comentario?.Trim() ?? string.Empty,
            FechaUtc = ahora
        });
        await _context.SaveChangesAsync();
        await tx.CommitAsync();
        CachePublica.Invalidar(cita.BarberiaId);

        return Ok(new { message = "¡Gracias por calificar tu servicio!" });
    }

    // 📱 CONSULTA Y GESTIÓN DE CITAS PARA EL BOT (CANCELAR / CITAS DEL DÍA)
    // Solo el bot puede llamar estos endpoints (encabezado X-Bot-Key) y siempre dentro de una barbería.
    [RequiereBotKey]
    [HttpGet("bot/{slug}/citas-cliente/{telefono}")]
    public async Task<IActionResult> ObtenerCitaClientePorTelefono(string slug, string telefono)
    {
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == slug.ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        await EstadosCitas.AplicarAsync(_context, barberia.Id);
        var citasActivas = await _context.Citas
            .Include(c => c.Servicio)
            .Include(c => c.MiembroEquipo)
            .Where(c => c.BarberiaId == barberia.Id && c.Estado != "Cancelada" && c.Estado != "Completada" && c.Estado != "No Confirmada")
            .ToListAsync();

        // La próxima cita pendiente (hoy o futura) de este teléfono
        var hoy = FechaHoyColombia();
        var cita = citasActivas
            .Where(c => string.CompareOrdinal(c.Fecha, hoy) >= 0)
            .Where(c => TelefonoHelper.MismoTelefono(c.TelefonoCliente, telefono))
            .OrderBy(c => c.Fecha)
            .ThenBy(c => ConvertirHoraAMinutos(c.Hora))
            .FirstOrDefault();

        if (cita == null) return NotFound(new { message = "No tienes citas activas para cancelar." });

        return Ok(new
        {
            cita.Id,
            cita.TokenPublico,
            cita.CodigoReserva,
            cita.NombreCliente,
            cita.TelefonoCliente,
            cita.Fecha,
            cita.Hora,
            cita.Total,
            cita.Estado,
            Servicio = cita.Servicio?.Nombre ?? "Servicio",
            Barbero = cita.MiembroEquipo?.Nombre ?? "Master Barber",
            MotivoNoModificable = MotivoNoModificable(cita, barberia),
            barberia.HorasLimiteCancelar
        });
    }

    // "Mis citas" del bot: las próximas citas activas de un teléfono (máximo 5), de la más cercana a la más lejana
    [RequiereBotKey]
    [HttpGet("bot/{slug}/mis-citas/{telefono}")]
    public async Task<IActionResult> MisCitasCliente(string slug, string telefono)
    {
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == slug.ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        await EstadosCitas.AplicarAsync(_context, barberia.Id);
        var hoy = FechaHoyColombia();
        var activas = await _context.Citas
            .Include(c => c.Servicio)
            .Include(c => c.MiembroEquipo)
            .Where(c => c.BarberiaId == barberia.Id && c.Estado != "Cancelada" && c.Estado != "Completada" && c.Estado != "No Confirmada")
            .Where(c => string.Compare(c.Fecha, hoy) >= 0)
            .ToListAsync();

        var citas = activas
            .Where(c => TelefonoHelper.MismoTelefono(c.TelefonoCliente, telefono))
            .OrderBy(c => c.Fecha)
            .ThenBy(c => ConvertirHoraAMinutos(c.Hora))
            .Take(5)
            .Select(c => new
            {
                c.Id,
                c.TokenPublico,
                c.CodigoReserva,
                c.NombreCliente,
                c.Fecha,
                c.Hora,
                c.Estado,
                Servicio = c.Servicio?.Nombre ?? "Servicio",
                Barbero = c.MiembroEquipo?.Nombre ?? "",
                MotivoNoModificable = MotivoNoModificable(c, barberia)
            })
            .ToList();

        return Ok(citas);
    }

    [RequiereBotKey]
    [HttpPost("bot/{slug}/cancelar-cita/{id}")]
    public async Task<IActionResult> CancelarCitaBot(string slug, int id)
    {
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == slug.ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        var cita = await _context.Citas
            .Include(c => c.Servicio)
            .FirstOrDefaultAsync(c => c.Id == id && c.BarberiaId == barberia.Id);

        if (cita == null) return NotFound(new { message = "Cita no encontrada." });
        var motivoBot = MotivoNoModificable(cita, barberia);
        if (motivoBot != null) return BadRequest(new { message = motivoBot, fueraDeLimite = true });

        cita.Estado = "Cancelada";
        await _context.SaveChangesAsync();
        AvisarCancelacion(barberia, cita, "por WhatsApp");
        ListaEsperaAvisos.TurnoLiberado(barberia.Id, cita.Fecha, cita.Hora, cita.MiembroEquipoId);

        return Ok(new
        {
            message = "Cita cancelada con éxito.",
            cita = new
            {
                cita.Id,
                cita.CodigoReserva,
                cita.NombreCliente,
                cita.Fecha,
                cita.Hora,
                Servicio = cita.Servicio?.Nombre ?? "Servicio"
            }
        });
    }

    // Estado actual de una cita (para que el bot no escriba sobre citas canceladas o reagendadas)
    [RequiereBotKey]
    [HttpGet("bot/{slug}/cita/{id}")]
    public async Task<IActionResult> ObtenerEstadoCitaBot(string slug, int id)
    {
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == slug.ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });
        // Estados al día (p. ej. Pendiente -> No Confirmada si ya pasó la hora) antes de responder al bot
        await EstadosCitas.AplicarAsync(_context, barberia.Id);
        var cita = await _context.Citas.FirstOrDefaultAsync(c => c.Id == id && c.BarberiaId == barberia.Id);
        if (cita == null) return NotFound(new { message = "Cita no encontrada." });
        return Ok(new { cita.Id, cita.Estado, cita.Fecha, cita.Hora });
    }

    public record CambioEstadoBotDto(string Estado);

    [RequiereBotKey]
    [HttpPost("bot/{slug}/cita/{id}/estado")]
    public async Task<IActionResult> CambiarEstadoCitaBot(string slug, int id, [FromBody] CambioEstadoBotDto dto)
    {
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == slug.ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });
        var cita = await _context.Citas.FirstOrDefaultAsync(c => c.Id == id && c.BarberiaId == barberia.Id);
        if (cita == null) return NotFound(new { message = "Cita no encontrada." });

        var inicio = EstadosCitas.InicioCita(cita.Fecha, cita.Hora);
        var esFutura = inicio != null && inicio.Value > EstadosCitas.AhoraColombia();

        switch (dto.Estado)
        {
            case EstadosCitas.Pendiente when cita.Estado == EstadosCitas.Confirmada && esFutura:
            case EstadosCitas.Confirmada when (cita.Estado == EstadosCitas.Pendiente || cita.Estado == EstadosCitas.NoConfirmada) && esFutura:
                cita.Estado = dto.Estado;
                await _context.SaveChangesAsync();
                return Ok(new { cita.Id, cita.Estado });
            default:
                if (cita.Estado == dto.Estado) return Ok(new { cita.Id, cita.Estado });
                return BadRequest(new { message = $"No se puede pasar de '{cita.Estado}' a '{dto.Estado}'.", cita.Estado });
        }
    }

    [RequiereBotKey]
    [HttpGet("bot/resumen-diario/{slug}")]
    public async Task<IActionResult> ObtenerResumenDiario(string slug, [FromQuery] string? fecha)
    {
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == slug.ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        await EstadosCitas.AplicarAsync(_context, barberia.Id);
        var fechaFiltro = string.IsNullOrWhiteSpace(fecha)
            ? FechaHoyColombia()
            : fecha;

        var citas = await _context.Citas
            .Include(c => c.Servicio)
            .Include(c => c.MiembroEquipo)
            .Where(c => c.BarberiaId == barberia.Id && c.Fecha == fechaFiltro && c.Estado != "Cancelada")
            .Select(c => new
            {
                c.Id,
                c.CodigoReserva,
                c.NombreCliente,
                c.TelefonoCliente,
                c.Hora,
                c.Total,
                c.Estado,
                Servicio = c.Servicio != null ? c.Servicio.Nombre : "Servicio",
                Barbero = c.MiembroEquipo != null ? c.MiembroEquipo.Nombre : "Master Barber"
            })
            .ToListAsync();
        citas = citas.OrderBy(c => EstadosCitas.HoraAMinutos(c.Hora)).ToList();

        return Ok(new
        {
            barberia.Nombre,
            barberia.TelefonoWhatsApp,
            barberia.AnuncioMatutinoActivo,
            barberia.HoraAnuncioSemana,
            barberia.HoraAnuncioSabado,
            barberia.HoraAnuncioDomingo,
            Fecha = fechaFiltro,
            TotalCitas = citas.Count,
            TotalIngresosEstimados = citas.Sum(c => c.Total),
            Citas = citas
        });
    }

    // ==============================================================
    // 👤 PORTAL Y REGISTRO DE CLIENTES INDEPENDIENTES POR BARBERÍA
    // ==============================================================
    private async Task<ClienteUsuario?> BuscarClientePorTelefono(int barberiaId, string telefono)
    {
        var clientes = await _context.Clientes.Where(c => c.BarberiaId == barberiaId).ToListAsync();
        return clientes.FirstOrDefault(c => TelefonoHelper.MismoTelefono(c.Telefono, telefono));
    }

    private object RespuestaSesionCliente(ClienteUsuario cliente, string message) => new
    {
        cliente.Id,
        cliente.Nombre,
        cliente.Telefono,
        cliente.Genero,
        Token = _tokens.GenerarTokenCliente(cliente),
        message
    };

    private async Task<ClienteUsuario?> ObtenerClienteAutenticado()
    {
        var claim = User.FindFirst(PoliticasAuth.ClaimClienteId)?.Value;
        if (!int.TryParse(claim, out var id)) return null;
        return await _context.Clientes.FindAsync(id);
    }

    [HttpPost("clientes/registro")]
    public async Task<IActionResult> RegistrarCliente([FromBody] ClienteRegisterDto dto)
    {
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == dto.BarberiaSlug.ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        var errorDatos = ValidarDatosCliente(dto.Nombre, dto.Telefono);
        if (errorDatos != null) return BadRequest(new { message = errorDatos });
        var telLimpio = TelefonoHelper.SoloDigitos(dto.Telefono);

        if (string.IsNullOrWhiteSpace(dto.Password) || dto.Password.Length < 4)
        {
            return BadRequest(new { message = "La contraseña debe tener al menos 4 caracteres." });
        }
        if (!dto.AceptaPrivacidad)
        {
            return BadRequest(new { message = "Para crear tu cuenta debes autorizar el tratamiento de tus datos (política de privacidad)." });
        }

        if (await BuscarClientePorTelefono(barberia.Id, telLimpio) != null)
        {
            return BadRequest(new { message = "Ya existe una cuenta con este número en esta barbería. Inicia sesión directamente." });
        }

        var cliente = new ClienteUsuario
        {
            BarberiaId = barberia.Id,
            Nombre = dto.Nombre.Trim(),
            Telefono = telLimpio,
            Genero = string.IsNullOrWhiteSpace(dto.Genero) ? "Hombre" : dto.Genero,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(dto.Password),
            FechaRegistro = DateTime.UtcNow,
            AceptoPrivacidadUtc = DateTime.UtcNow
        };

        _context.Clientes.Add(cliente);
        await _context.SaveChangesAsync();

        return Ok(RespuestaSesionCliente(cliente, "Cuenta creada con éxito."));
    }

    [HttpPost("clientes/login")]
    public async Task<IActionResult> LoginCliente([FromBody] ClienteLoginDto dto)
    {
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == dto.BarberiaSlug.ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });
        var digitosLogin = TelefonoHelper.SoloDigitos(dto.Telefono ?? "");
        if (!RecuperacionClave.PermitirIp($"{IpVisitante()}|login-cliente", 200) || !RecuperacionClave.PermitirIp($"login-cliente|{barberia.Id}|{digitosLogin}", 10))
            return StatusCode(429, new { message = "Demasiados intentos. Espera un rato o usa \"¿Olvidaste tu contraseña?\"." });

        var cliente = await BuscarClientePorTelefono(barberia.Id, dto.Telefono);

        if (cliente == null || !BCrypt.Net.BCrypt.Verify(dto.Password, cliente.PasswordHash))
        {
            return BadRequest(new { message = "Teléfono o contraseña incorrecta." });
        }

        return Ok(RespuestaSesionCliente(cliente, "Bienvenido de nuevo."));
    }

    // ----- Cambiar y recuperar la clave del cliente -----
    public record RecuperarClienteDto(string? BarberiaSlug, string? Telefono);
    public record ConfirmarClienteDto(string? BarberiaSlug, string? Telefono, string? Codigo, string? NuevaClave);
    public record CambiarClaveClienteDto(string? ClaveActual, string? NuevaClave);

    private string IpVisitante() => Services.IpVisitante.De(HttpContext);

    [HttpPost("clientes/recuperar/solicitar")]
    public async Task<IActionResult> SolicitarRecuperacionCliente([FromBody] RecuperarClienteDto dto)
    {
        if (!RecuperacionClave.PermitirIp($"{IpVisitante()}|recuperar-cliente", 10))
            return StatusCode(429, new { message = "Demasiados intentos. Espera un rato e inténtalo de nuevo." });
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == (dto.BarberiaSlug ?? "").ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });
        // Sin bot no hay cómo enviar el código (esto depende de la barbería, no de si existe la cuenta)
        if (!BotAtiende(barberia))
            return Ok(new { porWhatsApp = false, message = "Esta barbería todavía no envía códigos por WhatsApp. Escríbele al barbero para que te ayude a recuperar tu cuenta." });

        const string respuesta = "Si tu número tiene cuenta, te enviamos un código de 6 dígitos por WhatsApp. Vence en 10 minutos.";
        var cliente = await BuscarClientePorTelefono(barberia.Id, dto.Telefono ?? "");
        if (cliente == null || !RecuperacionClave.PuedeReenviar(cliente.CodigoRecuperacionEnviado))
            return Ok(new { porWhatsApp = true, message = respuesta });

        var codigo = RecuperacionClave.NuevoCodigo();
        cliente.CodigoRecuperacionHash = BCrypt.Net.BCrypt.HashPassword(codigo);
        cliente.CodigoRecuperacionVence = DateTime.UtcNow.AddMinutes(RecuperacionClave.MinutosVigencia);
        cliente.CodigoRecuperacionIntentos = 0;
        cliente.CodigoRecuperacionEnviado = DateTime.UtcNow;
        await _context.SaveChangesAsync();

        NotificarBot("/api/enviar-codigo", barberia, new
        {
            barberiaSlug = barberia.Slug,
            barberiaNombre = barberia.Nombre,
            telefono = cliente.Telefono,
            nombre = cliente.Nombre,
            codigo,
            para = "cliente"
        });
        return Ok(new { porWhatsApp = true, message = respuesta });
    }

    [HttpPost("clientes/recuperar/confirmar")]
    public async Task<IActionResult> ConfirmarRecuperacionCliente([FromBody] ConfirmarClienteDto dto)
    {
        if (!RecuperacionClave.PermitirIp($"{IpVisitante()}|confirmar-cliente", 30))
            return StatusCode(429, new { message = "Demasiados intentos. Espera un rato e inténtalo de nuevo." });
        if ((dto.NuevaClave ?? "").Length < 4)
            return BadRequest(new { message = "La clave nueva debe tener al menos 4 caracteres." });
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == (dto.BarberiaSlug ?? "").ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });
        var cliente = await BuscarClientePorTelefono(barberia.Id, dto.Telefono ?? "");
        if (cliente == null) return BadRequest(new { message = "El código no es correcto. Revísalo e inténtalo de nuevo." });

        var error = RecuperacionClave.Verificar(dto.Codigo, cliente.CodigoRecuperacionHash, cliente.CodigoRecuperacionVence, cliente.CodigoRecuperacionIntentos);
        if (error != null)
        {
            if (cliente.CodigoRecuperacionHash != null) { cliente.CodigoRecuperacionIntentos++; await _context.SaveChangesAsync(); }
            return BadRequest(new { message = error });
        }

        cliente.PasswordHash = BCrypt.Net.BCrypt.HashPassword(dto.NuevaClave);
        cliente.CodigoRecuperacionHash = null;
        cliente.CodigoRecuperacionVence = null;
        cliente.CodigoRecuperacionIntentos = 0;
        cliente.SesionVersion++; // cierra las sesiones abiertas con la clave anterior
        await _context.SaveChangesAsync();
        VersionesSesion.Fijar("c", cliente.Id, cliente.SesionVersion);
        return Ok(RespuestaSesionCliente(cliente, "¡Listo! Tu clave quedó cambiada."));
    }

    [Authorize(Policy = PoliticasAuth.Cliente)]
    [HttpPost("clientes/me/cambiar-clave")]
    public async Task<IActionResult> CambiarClaveCliente([FromBody] CambiarClaveClienteDto dto)
    {
        var cliente = await ObtenerClienteAutenticado();
        if (cliente == null) return Unauthorized(new { message = "Tu sesión expiró. Inicia sesión de nuevo." });
        if (!BCrypt.Net.BCrypt.Verify(dto.ClaveActual ?? "", cliente.PasswordHash))
            return BadRequest(new { message = "La clave actual no es correcta." });
        if ((dto.NuevaClave ?? "").Length < 4)
            return BadRequest(new { message = "La clave nueva debe tener al menos 4 caracteres." });
        if (dto.NuevaClave == dto.ClaveActual)
            return BadRequest(new { message = "La clave nueva debe ser diferente a la actual." });
        cliente.PasswordHash = BCrypt.Net.BCrypt.HashPassword(dto.NuevaClave);
        cliente.SesionVersion++;
        await _context.SaveChangesAsync();
        VersionesSesion.Fijar("c", cliente.Id, cliente.SesionVersion);
        return Ok(RespuestaSesionCliente(cliente, "Clave actualizada.")); // este celular sigue adentro
    }

    [Authorize(Policy = PoliticasAuth.Cliente)]
    [HttpGet("clientes/me")]
    public async Task<IActionResult> ObtenerPerfilCliente()
    {
        var cliente = await ObtenerClienteAutenticado();
        if (cliente == null) return Unauthorized(new { message = "Tu sesión expiró. Inicia sesión de nuevo." });

        var barberia = await _context.Barberias.FindAsync(cliente.BarberiaId);
        return Ok(new
        {
            cliente.Id,
            cliente.Nombre,
            cliente.Telefono,
            cliente.Genero,
            cliente.FechaRegistro,
            BarberiaSlug = barberia?.Slug,
            BarberiaNombre = barberia?.Nombre
        });
    }

    // Una cita es "próxima" si no está cancelada ni completada y su hora aún no ha pasado (hora Colombia)
    // El cliente puede cancelar o reprogramar hasta X horas antes (lo define la barbería; 0 = siempre)
    private static string? MotivoNoModificable(Cita c, Barberia b)
    {
        if (b.HorasLimiteCancelar <= 0) return null;
        var inicio = EstadosCitas.InicioCita(c.Fecha, c.Hora);
        if (inicio == null) return null;
        if ((inicio.Value - EstadosCitas.AhoraColombia()).TotalMinutes >= b.HorasLimiteCancelar * 60) return null;
        var h = b.HorasLimiteCancelar;
        return $"Faltan menos de {h} {(h == 1 ? "hora" : "horas")} para tu cita, así que ya no se puede cambiar ni cancelar por aquí. Escríbele al barbero por WhatsApp.";
    }

    private static bool EsCitaProxima(Cita c)
    {
        if (c.Estado == "Cancelada" || c.Estado == "Completada" || c.Estado == "No Confirmada") return false;
        var hoy = FechaHoyColombia();
        var cmp = string.CompareOrdinal(c.Fecha, hoy);
        if (cmp > 0) return true;
        if (cmp < 0) return false;
        return ConvertirHoraAMinutos(c.Hora) >= MinutosAhoraColombia();
    }

    private async Task<List<Cita>> CitasDelCliente(ClienteUsuario cliente)
    {
        var citasBarberia = await _context.Citas
            .Include(c => c.Servicio)
            .Include(c => c.MiembroEquipo)
            .Where(c => c.BarberiaId == cliente.BarberiaId)
            .ToListAsync();
        return citasBarberia.Where(c => TelefonoHelper.MismoTelefono(c.TelefonoCliente, cliente.Telefono)).ToList();
    }

    [Authorize(Policy = PoliticasAuth.Cliente)]
    [HttpGet("clientes/me/citas")]
    public async Task<IActionResult> ObtenerCitasCliente()
    {
        var cliente = await ObtenerClienteAutenticado();
        if (cliente == null) return Unauthorized(new { message = "Tu sesión expiró. Inicia sesión de nuevo." });

        var barberiaCliente = await _context.Barberias.AsNoTracking()
            .Where(b => b.Id == cliente.BarberiaId)
            .Select(b => new Barberia { Id = b.Id, HorasLimiteCancelar = b.HorasLimiteCancelar })
            .FirstOrDefaultAsync() ?? new Barberia();
        var citas = (await CitasDelCliente(cliente))
            .OrderByDescending(c => c.Fecha)
            .ThenByDescending(c => ConvertirHoraAMinutos(c.Hora))
            .Select(c => new
            {
                c.Id,
                c.CodigoReserva,
                c.Fecha,
                c.Hora,
                c.Total,
                c.Estado,
                c.TokenPublico, // solo para el dueño autenticado: arma el enlace de reagendar
                Proxima = EsCitaProxima(c),
                MotivoNoModificable = EsCitaProxima(c) ? MotivoNoModificable(c, barberiaCliente) : null,
                Servicio = c.Servicio?.Nombre ?? "Servicio",
                DuracionMinutos = c.Servicio?.DuracionMinutos ?? 0,
                Barbero = c.MiembroEquipo?.Nombre ?? "Master Barber"
            })
            .ToList();

        return Ok(citas);
    }

    [Authorize(Policy = PoliticasAuth.Cliente)]
    [HttpPost("clientes/me/citas/{id}/cancelar")]
    public async Task<IActionResult> CancelarCitaCliente(int id)
    {
        var cliente = await ObtenerClienteAutenticado();
        if (cliente == null) return Unauthorized(new { message = "Tu sesión expiró. Inicia sesión de nuevo." });

        var cita = (await CitasDelCliente(cliente)).FirstOrDefault(c => c.Id == id);
        if (cita == null) return NotFound(new { message = "No encontramos esa cita en tu cuenta." });
        if (!EsCitaProxima(cita)) return BadRequest(new { message = "Esta cita ya no se puede cancelar." });
        var barberia = await _context.Barberias.FindAsync(cita.BarberiaId);
        var motivoWeb = barberia == null ? null : MotivoNoModificable(cita, barberia);
        if (motivoWeb != null) return BadRequest(new { message = motivoWeb });

        cita.Estado = "Cancelada";
        await _context.SaveChangesAsync();

        // Avisar al barbero por WhatsApp (solo si el bot atiende esta barbería)
        if (barberia != null) NotificarBot("/api/notificar-cancelacion", barberia, new
        {
            citaId = cita.Id,
            barberiaSlug = barberia.Slug,
            nombreCliente = cita.NombreCliente,
            servicio = cita.Servicio?.Nombre ?? "Servicio",
            fecha = cita.Fecha,
            hora = cita.Hora
        });

        if (barberia != null)
        {
            AvisarCancelacion(barberia, cita, "desde su cuenta");
            ListaEsperaAvisos.TurnoLiberado(barberia.Id, cita.Fecha, cita.Hora, cita.MiembroEquipoId);
        }

        return Ok(new { message = "Tu cita fue cancelada." });
    }

    // 🔔 Notificación al celular del barbero: un cliente canceló y el turno quedó libre
    private static void AvisarCancelacion(Barberia barberia, Cita cita, string desde) =>
        NotificacionesPush.Avisar(barberia.Id, NotificacionesPush.Cancelacion,
            $"❌ {cita.NombreCliente} canceló su cita",
            $"{cita.Servicio?.Nombre ?? "Servicio"} · {NotificacionesPush.TextoFecha(cita.Fecha)}, {NotificacionesPush.TextoHora(cita.Hora)} — canceló {desde}. El turno quedó libre.",
            $"cita-{cita.Id}");

    // Cada barbería puede tener su propio WhatsApp vinculado al bot (BotWhatsApp).
    // BOT_BARBERIA_SLUG: la barbería que ya tenía el bot antes de que hubiera uno por barbería.
    internal static string? SlugBotAntiguo => Environment.GetEnvironmentVariable("BOT_BARBERIA_SLUG") ?? "barberia-jr";
    internal static bool BotAtiende(Barberia barberia) =>
        barberia.BotWhatsApp || string.Equals(SlugBotAntiguo, barberia.Slug, StringComparison.OrdinalIgnoreCase);

    internal static string UrlBot(string ruta, string slug) =>
        $"{(Environment.GetEnvironmentVariable("BARBERFLOW_BOT_URL") ?? "https://barberflow-bot.onrender.com").TrimEnd('/')}{ruta}?slug={Uri.EscapeDataString(slug)}";

    // Envía un aviso al bot de WhatsApp de esa barbería, en segundo plano
    internal static void NotificarBot(string ruta, Barberia barberia, object payload)
    {
        if (!BotAtiende(barberia)) return;
        var slug = barberia.Slug;

        _ = Task.Run(async () =>
        {
            try
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
                var botKey = Environment.GetEnvironmentVariable("BOT_API_KEY");
                if (!string.IsNullOrWhiteSpace(botKey)) http.DefaultRequestHeaders.Add(RequiereBotKeyAttribute.Header, botKey);
                var json = new StringContent(System.Text.Json.JsonSerializer.Serialize(payload), System.Text.Encoding.UTF8, "application/json");
                await http.PostAsync(UrlBot(ruta, slug), json);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Bot {ruta} Error]: {ex.Message}");
            }
        });
    }

    [Authorize(Policy = PoliticasAuth.Cliente)]
    [HttpDelete("clientes/me")]
    public async Task<IActionResult> EliminarCuentaCliente()
    {
        var cliente = await ObtenerClienteAutenticado();
        if (cliente == null) return Unauthorized(new { message = "Tu sesión expiró. Inicia sesión de nuevo." });

        _context.Clientes.Remove(cliente);
        await _context.SaveChangesAsync();

        return Ok(new { message = "Tu cuenta ha sido eliminada con éxito." });
    }
}

public record ValoracionDto(string BarberiaSlug, string NombreCliente, int Estrellas, string? Comentario);
