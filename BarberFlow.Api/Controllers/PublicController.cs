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
        if (dia > DateTime.UtcNow.AddDays(120)) return "Solo puedes reservar con máximo 4 meses de anticipación.";

        var diasLaborales = (barberia.DiasLaborales ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (diasLaborales.Length > 0 && !diasLaborales.Contains(((int)dia.DayOfWeek).ToString()))
            return "La barbería no atiende ese día. Elige otro día.";

        var inicio = ConvertirHoraAMinutos(hora);
        if (inicio < ConvertirHoraAMinutos(barberia.HoraApertura) || inicio >= ConvertirHoraAMinutos(barberia.HoraCierre))
            return "Esa hora está fuera del horario de atención.";
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

    [HttpGet("barberia/{slug}")]
    public async Task<IActionResult> ObtenerBarberia(string slug)
    {
        try
        {
            // Solo lo necesario para reservar: servicios y equipo activos, y bloqueos/citas de hoy en adelante
            var hoy = FechaHoyColombia();
            var barberia = await _context.Barberias
                .AsNoTracking()
                .Include(b => b.Servicios.Where(s => s.Activo))
                .Include(b => b.Miembros.Where(m => m.Activo))
                .Include(b => b.Bloqueos.Where(bl => string.Compare(bl.Fecha, hoy) >= 0))
                .AsSplitQuery()
                .FirstOrDefaultAsync(b => b.Slug == slug.ToLower());

            if (barberia == null)
            {
                return NotFound(new { message = "Barbería no encontrada." });
            }

            var botReglas = await _context.BotReglas
                .Where(r => r.BarberiaId == barberia.Id && r.Activo)
                .Select(r => new { r.Id, r.PalabrasClave, r.Respuesta })
                .ToListAsync();

            // Turnos ya tomados (de hoy en adelante) para no permitir sobreposiciones, con la duración real del servicio
            var citasOcupadas = await _context.Citas
                .Where(c => c.BarberiaId == barberia.Id && c.Estado != "Cancelada" && c.Estado != "No Confirmada"
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

            return Ok(new
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
                barberia.PlantillaConfirmacion,
                barberia.PlantillaRecordatorio,
                barberia.HorarioTexto,
                barberia.HoraApertura,
                barberia.HoraCierre,
                barberia.IntervaloMinutos,
                barberia.MinutosAnticipacion,
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
                    FotoUrl = UrlImagen(m.FotoUrl, "miembro", m.Id)
                }),
                Bloqueos = barberia.Bloqueos.Select(bl => new
                {
                    bl.Id,
                    bl.Fecha,
                    bl.Hora,
                    bl.Motivo
                }),
                CitasOcupadas = citasOcupadas,
                TotalAgendamientos = totalAgendamientosReales,
                TotalValoraciones = totalValoraciones,
                Calificacion = calificacion,
                UltimasValoraciones = ultimasValoraciones
            });
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
        var barberia = await _context.Barberias
            .Include(b => b.Servicios)
            .Include(b => b.Bloqueos)
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
            if (citaAnterior.Estado == "Cancelada")
            {
                return BadRequest(new { message = "Esta cita ya fue cancelada o reagendada. Si quieres otro turno, reserva uno nuevo." });
            }
        }

        var nuevoTurnoInicio = ConvertirHoraAMinutos(dto.Hora);
        var nuevoTurnoFin = nuevoTurnoInicio + servicio.DuracionMinutos;
        if (nuevoTurnoFin > ConvertirHoraAMinutos(barberia.HoraCierre) + 15)
        {
            return BadRequest(new { message = "Ese horario termina después del cierre de la barbería. Elige una hora más temprano." });
        }

        var citasDia = await _context.Citas
            .Include(c => c.Servicio)
            .Where(c => c.BarberiaId == barberia.Id && c.Fecha == dto.Fecha && c.Estado != "Cancelada" && c.Estado != "No Confirmada")
            .Where(c => dto.MiembroEquipoId == null || c.MiembroEquipoId == null || c.MiembroEquipoId == dto.MiembroEquipoId)
            .ToListAsync();

        var hayTraslapeCita = citasDia.Any(c =>
        {
            if (citaAnterior != null && c.Id == citaAnterior.Id) return false;
            var existIni = ConvertirHoraAMinutos(c.Hora);
            var existDur = c.Servicio?.DuracionMinutos ?? barberia.IntervaloMinutos;
            var existFin = existIni + existDur;
            return nuevoTurnoInicio < existFin && nuevoTurnoFin > existIni;
        });

        if (hayTraslapeCita)
        {
            return BadRequest(new { message = "Ese horario o parte de su duración ya fue reservado. Por favor elige otro horario." });
        }

        var codigoReserva = $"#BF-{Random.Shared.Next(1000, 9999)}";

        var cita = new Cita
        {
            BarberiaId = barberia.Id,
            ServicioId = servicio.Id,
            MiembroEquipoId = dto.MiembroEquipoId,
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
        await _context.SaveChangesAsync();

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
            esReagendamiento = citaAnterior != null
        });

        return Ok(new
        {
            cita.Id,
            cita.CodigoReserva,
            cita.Fecha,
            cita.Hora,
            cita.Total,
            ServicioNombre = servicio.Nombre,
            BarberiaWhatsApp = barberia.TelefonoWhatsApp,
            BarberiaNombre = barberia.Nombre
        });
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
            Barbero = cita.MiembroEquipo?.Nombre ?? "Master Barber"
        });
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

        cita.Estado = "Cancelada";
        await _context.SaveChangesAsync();

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
            .OrderBy(c => c.Hora)
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
            FechaRegistro = DateTime.UtcNow
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

        var cliente = await BuscarClientePorTelefono(barberia.Id, dto.Telefono);

        if (cliente == null || !BCrypt.Net.BCrypt.Verify(dto.Password, cliente.PasswordHash))
        {
            return BadRequest(new { message = "Teléfono o contraseña incorrecta." });
        }

        return Ok(RespuestaSesionCliente(cliente, "Bienvenido de nuevo."));
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

        cita.Estado = "Cancelada";
        await _context.SaveChangesAsync();

        // Avisar al barbero por WhatsApp (solo si el bot atiende esta barbería)
        var barberia = await _context.Barberias.FindAsync(cita.BarberiaId);
        if (barberia != null) NotificarBot("/api/notificar-cancelacion", barberia, new
        {
            citaId = cita.Id,
            barberiaSlug = barberia.Slug,
            nombreCliente = cita.NombreCliente,
            servicio = cita.Servicio?.Nombre ?? "Servicio",
            fecha = cita.Fecha,
            hora = cita.Hora
        });

        return Ok(new { message = "Tu cita fue cancelada." });
    }

    // Envía un aviso al bot de WhatsApp en segundo plano, solo para la barbería que atiende el bot
    private static void NotificarBot(string ruta, Barberia barberia, object payload)
    {
        var slugBot = Environment.GetEnvironmentVariable("BOT_BARBERIA_SLUG") ?? "barberia-jr";
        if (!string.Equals(slugBot, barberia.Slug, StringComparison.OrdinalIgnoreCase)) return;

        _ = Task.Run(async () =>
        {
            try
            {
                var botUrl = Environment.GetEnvironmentVariable("BARBERFLOW_BOT_URL") ?? "https://barberflow-bot.onrender.com";
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
                var botKey = Environment.GetEnvironmentVariable("BOT_API_KEY");
                if (!string.IsNullOrWhiteSpace(botKey)) http.DefaultRequestHeaders.Add(RequiereBotKeyAttribute.Header, botKey);
                var json = new StringContent(System.Text.Json.JsonSerializer.Serialize(payload), System.Text.Encoding.UTF8, "application/json");
                await http.PostAsync($"{botUrl.TrimEnd('/')}{ruta}", json);
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
