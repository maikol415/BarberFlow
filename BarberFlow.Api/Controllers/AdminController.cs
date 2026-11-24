using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using BarberFlow.Api.Data;
using BarberFlow.Api.DTOs;
using BarberFlow.Api.Models;
using BarberFlow.Api.Services;

namespace BarberFlow.Api.Controllers;

[Authorize(Policy = PoliticasAuth.Barbero)]
[ApiController]
[Route("api/[controller]")]
public class AdminController : ControllerBase
{
    private readonly AppDbContext _context;

    public AdminController(AppDbContext context)
    {
        _context = context;
    }

    private int ObtenerBarberiaId()
    {
        var claim = User.FindFirst("BarberiaId");
        if (claim != null && int.TryParse(claim.Value, out int id))
        {
            return id;
        }
        throw new UnauthorizedAccessException("Sesión inválida.");
    }

    [HttpGet("perfil")]
    public async Task<IActionResult> ObtenerPerfil()
    {
        try
        {
            var barberiaId = ObtenerBarberiaId();
            var barberia = await _context.Barberias
                .Include(b => b.Servicios.Where(s => s.Activo))
                .Include(b => b.Miembros.Where(m => m.Activo))
                .Include(b => b.Bloqueos)
                .FirstOrDefaultAsync(b => b.Id == barberiaId);

            if (barberia == null) return NotFound();

            List<BotReglaRespuesta> reglas = new();
            try
            {
                reglas = await _context.BotReglas.Where(r => r.BarberiaId == barberiaId).ToListAsync();
            }
            catch {}

            return Ok(new
            {
                barberia.Id,
                barberia.Nombre,
                barberia.Slug,
                barberia.Descripcion,
                barberia.Direccion,
                barberia.TelefonoWhatsApp,
                barberia.LogoUrl,
                barberia.ColorPrimario,
                barberia.PortadaUrl,
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
                barberia.PlantillaConfirmacion,
                barberia.PlantillaRecordatorio,
                barberia.AnuncioMatutinoActivo,
                barberia.HoraAnuncioSemana,
                barberia.HoraAnuncioSabado,
                barberia.HoraAnuncioDomingo,
                Servicios = barberia.Servicios,
                Miembros = barberia.Miembros,
                Bloqueos = barberia.Bloqueos,
                BotReglas = reglas
            });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { message = "Error cargando perfil", error = ex.Message });
        }
    }

    [HttpPut("perfil")]
    public async Task<IActionResult> ActualizarPerfil([FromBody] UpdateBarberiaDto dto)
    {
        var barberiaId = ObtenerBarberiaId();
        var barberia = await _context.Barberias.FindAsync(barberiaId);
        if (barberia == null) return NotFound();

        barberia.Nombre = dto.Nombre.Trim();
        barberia.Descripcion = dto.Descripcion.Trim();
        barberia.Direccion = dto.Direccion.Trim();
        barberia.TelefonoWhatsApp = dto.TelefonoWhatsApp.Trim();
        barberia.HorarioTexto = dto.HorarioTexto.Trim();
        if (!string.IsNullOrWhiteSpace(dto.LogoUrl))
        {
            barberia.LogoUrl = dto.LogoUrl.Trim();
        }

        if (!string.IsNullOrWhiteSpace(dto.HoraApertura)) barberia.HoraApertura = dto.HoraApertura;
        if (!string.IsNullOrWhiteSpace(dto.HoraCierre)) barberia.HoraCierre = dto.HoraCierre;
        if (dto.IntervaloMinutos >= 15) barberia.IntervaloMinutos = dto.IntervaloMinutos;
        if (dto.MinutosAnticipacion is >= 0 and <= 2880) barberia.MinutosAnticipacion = dto.MinutosAnticipacion.Value;
        if (dto.ColorPrimario != null && System.Text.RegularExpressions.Regex.IsMatch(dto.ColorPrimario, "^#[0-9a-fA-F]{6}$"))
            barberia.ColorPrimario = dto.ColorPrimario.ToUpperInvariant();
        if (dto.PortadaUrl != null)
        {
            var portada = dto.PortadaUrl.Trim();
            var valida = portada == "" || portada.Length <= 900_000 &&
                (portada.StartsWith("data:image/jpeg;base64,") || portada.StartsWith("data:image/png;base64,") ||
                 portada.StartsWith("data:image/webp;base64,") || portada.StartsWith("https://") || portada.StartsWith("/uploads/"));
            if (!valida) return BadRequest(new { message = "La imagen de portada no es válida o es demasiado grande." });
            barberia.PortadaUrl = portada;
        }
        if (!string.IsNullOrWhiteSpace(dto.DiasLaborales)) barberia.DiasLaborales = dto.DiasLaborales;
        barberia.MostrarSelectorBarbero = dto.MostrarSelectorBarbero;

        if (dto.DatosPago != null) barberia.DatosPago = dto.DatosPago.Trim();
        if (dto.NumeroNequi != null) barberia.NumeroNequi = dto.NumeroNequi.Trim();
        if (dto.NumeroDaviplata != null) barberia.NumeroDaviplata = dto.NumeroDaviplata.Trim();
        if (dto.TitularCuenta != null) barberia.TitularCuenta = dto.TitularCuenta.Trim();

        if (dto.BotActivo.HasValue) barberia.BotActivo = dto.BotActivo.Value;
        if (dto.MensajeBienvenidaBot != null) barberia.MensajeBienvenidaBot = dto.MensajeBienvenidaBot.Trim();
        if (dto.MensajeDerivacionHumana != null) barberia.MensajeDerivacionHumana = dto.MensajeDerivacionHumana.Trim();
        if (dto.PlantillaConfirmacion != null) barberia.PlantillaConfirmacion = dto.PlantillaConfirmacion.Trim();
        if (dto.PlantillaRecordatorio != null) barberia.PlantillaRecordatorio = dto.PlantillaRecordatorio.Trim();
        if (dto.AnuncioMatutinoActivo.HasValue) barberia.AnuncioMatutinoActivo = dto.AnuncioMatutinoActivo.Value;
        if (!string.IsNullOrWhiteSpace(dto.HoraAnuncioSemana)) barberia.HoraAnuncioSemana = dto.HoraAnuncioSemana.Trim();
        if (!string.IsNullOrWhiteSpace(dto.HoraAnuncioSabado)) barberia.HoraAnuncioSabado = dto.HoraAnuncioSabado.Trim();
        if (!string.IsNullOrWhiteSpace(dto.HoraAnuncioDomingo)) barberia.HoraAnuncioDomingo = dto.HoraAnuncioDomingo.Trim();

        await _context.SaveChangesAsync();
        return Ok(new { message = "Configuración actualizada con éxito.", barberia });
    }

    // REINICIAR DATOS DE PRUEBA (MODO LANZAMIENTO)
    [HttpPost("limpiar-datos-prueba")]
    public async Task<IActionResult> LimpiarDatosPrueba()
    {
        var barberiaId = ObtenerBarberiaId();
        
        // 1. Eliminar todas las citas de prueba de esta barbería
        var citas = await _context.Citas.Where(c => c.BarberiaId == barberiaId).ToListAsync();
        _context.Citas.RemoveRange(citas);

        // 2. Eliminar bloqueos de horarios de prueba
        var bloqueos = await _context.Bloqueos.Where(b => b.BarberiaId == barberiaId).ToListAsync();
        _context.Bloqueos.RemoveRange(bloqueos);

        // 3. Eliminar valoraciones y reseñas de prueba
        var valoraciones = await _context.Valoraciones.Where(v => v.BarberiaId == barberiaId).ToListAsync();
        _context.Valoraciones.RemoveRange(valoraciones);

        await _context.SaveChangesAsync();
        return Ok(new { message = "Todos los datos de prueba (citas, bloqueos y valoraciones) han sido limpiados con éxito. ¡Listo para iniciar operaciones!" });
    }

    // ELIMINAR BARBERÍA Y CUENTA POR COMPLETO
    [HttpDelete("eliminar-barberia")]
    public async Task<IActionResult> EliminarBarberia()
    {
        var barberiaId = ObtenerBarberiaId();
        var barberia = await _context.Barberias
            .Include(b => b.BarberoUser)
            .FirstOrDefaultAsync(b => b.Id == barberiaId);

        if (barberia == null) return NotFound();

        var user = barberia.BarberoUser;
        _context.Barberias.Remove(barberia);
        if (user != null)
        {
            _context.Barberos.Remove(user);
        }

        await _context.SaveChangesAsync();
        return Ok(new { message = "Barbería eliminada correctamente." });
    }

    [HttpPost("upload-image")]
    public async Task<IActionResult> UploadImage([FromBody] UploadImageDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.ImageData))
        {
            return BadRequest(new { message = "No se proporcionó imagen válida." });
        }

        try
        {
            var match = System.Text.RegularExpressions.Regex.Match(dto.ImageData, @"^data:image/(?<type>png|jpeg|jpg|webp|gif);base64,(?<data>[A-Za-z0-9+/=]+)$");
            if (!match.Success)
            {
                return BadRequest(new { message = "Formato de imagen inválido. Usa PNG, JPG, WEBP o GIF." });
            }

            var base64Data = match.Groups["data"].Value;
            if (base64Data.Length > 7_000_000)
            {
                return BadRequest(new { message = "La imagen es demasiado grande (máximo 5 MB)." });
            }
            var bytes = Convert.FromBase64String(base64Data);

            // La extensión se decide por el contenido real del archivo, no por lo que diga el navegador
            string? extension =
                bytes.Length > 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47 ? "png" :
                bytes.Length > 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF ? "jpg" :
                bytes.Length > 6 && bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46 ? "gif" :
                bytes.Length > 12 && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46 &&
                    bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50 ? "webp" : null;
            if (extension == null)
            {
                return BadRequest(new { message = "El archivo no es una imagen válida." });
            }

            var uploadsDir = Path.Combine(Directory.GetCurrentDirectory(), "wwwroot", "uploads");
            if (!Directory.Exists(uploadsDir))
            {
                Directory.CreateDirectory(uploadsDir);
            }

            var fileName = $"{Guid.NewGuid():N}.{extension}";
            var filePath = Path.Combine(uploadsDir, fileName);
            await System.IO.File.WriteAllBytesAsync(filePath, bytes);

            var fileUrl = $"/uploads/{fileName}";
            return Ok(new { url = fileUrl });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { message = "Error al procesar imagen: " + ex.Message });
        }
    }

    [HttpGet("citas")]
    public async Task<IActionResult> ObtenerCitas([FromQuery] string? filtro, [FromQuery] string? fechaInicio, [FromQuery] string? fechaFin)
    {
        var barberiaId = ObtenerBarberiaId();
        await EstadosCitas.AplicarAsync(_context, barberiaId);
        var query = _context.Citas
            .Include(c => c.Servicio)
            .Include(c => c.MiembroEquipo)
            .Where(c => c.BarberiaId == barberiaId);

        var hoy = DateTime.UtcNow.Date;
        if (filtro == "semana")
        {
            var lunes = hoy.AddDays(-(int)hoy.DayOfWeek + (int)DayOfWeek.Monday);
            var domingo = lunes.AddDays(6);
            var startIso = lunes.ToString("yyyy-MM-dd");
            var endIso = domingo.ToString("yyyy-MM-dd");
            query = query.Where(c => string.Compare(c.Fecha, startIso) >= 0 && string.Compare(c.Fecha, endIso) <= 0);
        }
        else if (filtro == "quincena")
        {
            var hace15 = hoy.AddDays(-15).ToString("yyyy-MM-dd");
            var dentro15 = hoy.AddDays(15).ToString("yyyy-MM-dd");
            query = query.Where(c => string.Compare(c.Fecha, hace15) >= 0 && string.Compare(c.Fecha, dentro15) <= 0);
        }
        else if (filtro == "mes")
        {
            var inicioMes = new DateTime(hoy.Year, hoy.Month, 1).ToString("yyyy-MM-dd");
            var finMes = new DateTime(hoy.Year, hoy.Month, DateTime.DaysInMonth(hoy.Year, hoy.Month)).ToString("yyyy-MM-dd");
            query = query.Where(c => string.Compare(c.Fecha, inicioMes) >= 0 && string.Compare(c.Fecha, finMes) <= 0);
        }
        else if (filtro == "anio")
        {
            var inicioAnio = new DateTime(hoy.Year, 1, 1).ToString("yyyy-MM-dd");
            var finAnio = new DateTime(hoy.Year, 12, 31).ToString("yyyy-MM-dd");
            query = query.Where(c => string.Compare(c.Fecha, inicioAnio) >= 0 && string.Compare(c.Fecha, finAnio) <= 0);
        }
        else if (!string.IsNullOrEmpty(fechaInicio) && !string.IsNullOrEmpty(fechaFin))
        {
            query = query.Where(c => string.Compare(c.Fecha, fechaInicio) >= 0 && string.Compare(c.Fecha, fechaFin) <= 0);
        }

        var citas = await query
            .OrderByDescending(c => c.Fecha)
            .ThenByDescending(c => c.Hora)
            .Select(c => new
            {
                c.Id,
                c.CodigoReserva,
                c.NombreCliente,
                c.TelefonoCliente,
                c.Fecha,
                c.Hora,
                c.Total,
                c.Estado,
                Servicio = c.Servicio != null ? c.Servicio.Nombre : "Servicio",
                Barbero = c.MiembroEquipo != null ? c.MiembroEquipo.Nombre : "Cualquiera"
            })
            .ToListAsync();

        return Ok(citas);
    }

    [HttpPatch("citas/{id}/estado")]
    public async Task<IActionResult> CambiarEstadoCita(int id, [FromBody] CambiarEstadoCitaDto dto)
    {
        var barberiaId = ObtenerBarberiaId();
        var cita = await _context.Citas
            .Include(c => c.Servicio)
            .Include(c => c.MiembroEquipo)
            .FirstOrDefaultAsync(c => c.Id == id && c.BarberiaId == barberiaId);

        if (cita == null) return NotFound(new { message = "Cita no encontrada." });

        cita.Estado = dto.Estado;
        await _context.SaveChangesAsync();

        var barberia = await _context.Barberias.FindAsync(barberiaId);

        return Ok(new 
        { 
            message = "Estado actualizado.",
            cita = new {
                cita.Id,
                cita.CodigoReserva,
                cita.NombreCliente,
                cita.TelefonoCliente,
                cita.Fecha,
                cita.Hora,
                cita.Total,
                cita.Estado,
                Servicio = cita.Servicio?.Nombre ?? "Servicio",
                Barbero = cita.MiembroEquipo?.Nombre ?? "Master Barber"
            },
            BarberiaNombre = barberia?.Nombre ?? "Barbería",
            BarberiaWhatsApp = barberia?.TelefonoWhatsApp ?? ""
        });
    }

    [HttpDelete("citas/{id}")]
    public async Task<IActionResult> EliminarCita(int id, [FromQuery] bool marcarNoConfirmada = true)
    {
        var barberiaId = ObtenerBarberiaId();
        var cita = await _context.Citas.FirstOrDefaultAsync(c => c.Id == id && c.BarberiaId == barberiaId);
        if (cita == null) return NotFound();

        if (marcarNoConfirmada)
        {
            cita.Estado = "No Confirmada";
            await _context.SaveChangesAsync();
            return Ok(new { message = "Cita movida al apartado de No Confirmadas." });
        }
        else
        {
            _context.Citas.Remove(cita);
            await _context.SaveChangesAsync();
            return Ok(new { message = "Cita eliminada permanentemente." });
        }
    }

    [HttpPost("servicios")]
    public async Task<IActionResult> CrearServicio([FromBody] ServicioDto dto)
    {
        var barberiaId = ObtenerBarberiaId();
        var servicio = new Servicio
        {
            BarberiaId = barberiaId,
            Categoria = string.IsNullOrWhiteSpace(dto.Categoria) ? "Cortes" : dto.Categoria.Trim(),
            Nombre = dto.Nombre.Trim(),
            Precio = dto.Precio,
            DuracionMinutos = dto.DuracionMinutos > 0 ? dto.DuracionMinutos : 30,
            Descripcion = dto.Descripcion ?? "",
            Icono = string.IsNullOrWhiteSpace(dto.Icono) ? "scissors" : dto.Icono,
            Activo = true
        };
        _context.Servicios.Add(servicio);
        await _context.SaveChangesAsync();
        return Ok(servicio);
    }

    [HttpPut("servicios/{id}")]
    public async Task<IActionResult> ActualizarServicio(int id, [FromBody] ServicioDto dto)
    {
        var barberiaId = ObtenerBarberiaId();
        var servicio = await _context.Servicios.FirstOrDefaultAsync(s => s.Id == id && s.BarberiaId == barberiaId);
        if (servicio == null) return NotFound(new { message = "Servicio no encontrado." });

        servicio.Categoria = string.IsNullOrWhiteSpace(dto.Categoria) ? "Cortes" : dto.Categoria.Trim();
        servicio.Nombre = dto.Nombre.Trim();
        servicio.Precio = dto.Precio;
        servicio.DuracionMinutos = dto.DuracionMinutos > 0 ? dto.DuracionMinutos : 30;
        servicio.Descripcion = dto.Descripcion ?? "";

        await _context.SaveChangesAsync();
        return Ok(servicio);
    }

    [HttpDelete("servicios/{id}")]
    public async Task<IActionResult> EliminarServicio(int id)
    {
        var barberiaId = ObtenerBarberiaId();
        var servicio = await _context.Servicios.FirstOrDefaultAsync(s => s.Id == id && s.BarberiaId == barberiaId);
        if (servicio == null) return NotFound();

        if (await _context.Citas.AnyAsync(c => c.ServicioId == servicio.Id))
        {
            // Tiene citas en el historial: se oculta del catálogo para no romper esas citas
            servicio.Activo = false;
        }
        else
        {
            _context.Servicios.Remove(servicio);
        }
        await _context.SaveChangesAsync();
        return Ok(new { message = "Servicio eliminado." });
    }

    [HttpPost("miembros")]
    public async Task<IActionResult> CrearMiembro([FromBody] MiembroDto dto)
    {
        var barberiaId = ObtenerBarberiaId();
        var defaultAvatar = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2364748B'><circle cx='12' cy='8' r='4'/><path d='M4 20c0-4 4-6 8-6s8 2 8 6'/></svg>";

        var miembro = new MiembroEquipo
        {
            BarberiaId = barberiaId,
            Nombre = dto.Nombre,
            Rol = dto.Rol,
            FotoUrl = string.IsNullOrWhiteSpace(dto.FotoUrl) ? defaultAvatar : dto.FotoUrl,
            Activo = true
        };
        _context.Miembros.Add(miembro);
        await _context.SaveChangesAsync();
        return Ok(miembro);
    }

    [HttpPut("miembros/{id}")]
    public async Task<IActionResult> ActualizarMiembro(int id, [FromBody] MiembroDto dto)
    {
        var barberiaId = ObtenerBarberiaId();
        var miembro = await _context.Miembros.FirstOrDefaultAsync(m => m.Id == id && m.BarberiaId == barberiaId);
        if (miembro == null) return NotFound(new { message = "Miembro no encontrado." });

        miembro.Nombre = dto.Nombre.Trim();
        miembro.Rol = dto.Rol.Trim();
        if (!string.IsNullOrWhiteSpace(dto.FotoUrl))
        {
            miembro.FotoUrl = dto.FotoUrl;
        }

        await _context.SaveChangesAsync();
        return Ok(miembro);
    }

    [HttpDelete("miembros/{id}")]
    public async Task<IActionResult> EliminarMiembro(int id)
    {
        var barberiaId = ObtenerBarberiaId();
        var miembro = await _context.Miembros.FirstOrDefaultAsync(m => m.Id == id && m.BarberiaId == barberiaId);
        if (miembro == null) return NotFound();

        if (await _context.Citas.AnyAsync(c => c.MiembroEquipoId == miembro.Id))
        {
            // Tiene citas en el historial: se oculta del equipo para no romper esas citas
            miembro.Activo = false;
        }
        else
        {
            _context.Miembros.Remove(miembro);
        }
        await _context.SaveChangesAsync();
        return Ok(new { message = "Miembro eliminado." });
    }

    [HttpPost("bloqueos")]
    public async Task<IActionResult> CrearBloqueo([FromBody] BloqueoDto dto)
    {
        var barberiaId = ObtenerBarberiaId();
        var bloqueo = new HorarioBloqueo
        {
            BarberiaId = barberiaId,
            Fecha = dto.Fecha,
            Hora = string.IsNullOrWhiteSpace(dto.Hora) ? "TODO_EL_DIA" : dto.Hora,
            Motivo = string.IsNullOrWhiteSpace(dto.Motivo) ? "Descanso / No disponible" : dto.Motivo
        };

        _context.Bloqueos.Add(bloqueo);
        await _context.SaveChangesAsync();
        return Ok(bloqueo);
    }

    [HttpDelete("bloqueos/{id}")]
    public async Task<IActionResult> EliminarBloqueo(int id)
    {
        var barberiaId = ObtenerBarberiaId();
        var bloqueo = await _context.Bloqueos.FirstOrDefaultAsync(b => b.Id == id && b.BarberiaId == barberiaId);
        if (bloqueo == null) return NotFound();

        _context.Bloqueos.Remove(bloqueo);
        await _context.SaveChangesAsync();
        return Ok(new { message = "Bloqueo eliminado y horario habilitado." });
    }

    // GESTIÓN DE REGLAS DE BOT DE WHATSAPP
    [HttpGet("bot/reglas")]
    public async Task<IActionResult> ObtenerReglasBot()
    {
        var barberiaId = ObtenerBarberiaId();
        var reglas = await _context.BotReglas
            .Where(r => r.BarberiaId == barberiaId)
            .OrderBy(r => r.Id)
            .ToListAsync();
        return Ok(reglas);
    }

    [HttpPost("bot/reglas")]
    public async Task<IActionResult> CrearReglaBot([FromBody] CrearBotReglaDto dto)
    {
        var barberiaId = ObtenerBarberiaId();
        if (string.IsNullOrWhiteSpace(dto.PalabrasClave) || string.IsNullOrWhiteSpace(dto.Respuesta))
        {
            return BadRequest(new { message = "Las palabras clave y la respuesta son obligatorias." });
        }

        var regla = new BotReglaRespuesta
        {
            BarberiaId = barberiaId,
            PalabrasClave = dto.PalabrasClave.Trim().ToLower(),
            Respuesta = dto.Respuesta.Trim(),
            Activo = true
        };

        _context.BotReglas.Add(regla);
        await _context.SaveChangesAsync();
        return Ok(regla);
    }

    [HttpDelete("bot/reglas/{id}")]
    public async Task<IActionResult> EliminarReglaBot(int id)
    {
        var barberiaId = ObtenerBarberiaId();
        var regla = await _context.BotReglas.FirstOrDefaultAsync(r => r.Id == id && r.BarberiaId == barberiaId);
        if (regla == null) return NotFound();

        _context.BotReglas.Remove(regla);
        await _context.SaveChangesAsync();
        return Ok(new { message = "Regla de bot eliminada." });
    }

    // ESTADO / QR DEL BOT DE WHATSAPP (proxy autenticado: el navegador nunca habla directo con el bot)
    private static readonly HttpClient _botHttp = new() { Timeout = TimeSpan.FromSeconds(8) };

    [HttpGet("bot/estado")]
    public async Task<IActionResult> ObtenerEstadoBot()
    {
        var botUrl = Environment.GetEnvironmentVariable("BARBERFLOW_BOT_URL") ?? "https://barberflow-bot.onrender.com";
        var botKey = Environment.GetEnvironmentVariable("BOT_API_KEY");
        if (string.IsNullOrWhiteSpace(botKey))
        {
            return StatusCode(503, new { message = "BOT_API_KEY no está configurada en el servidor." });
        }

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{botUrl.TrimEnd('/')}/api/status");
            req.Headers.Add(RequiereBotKeyAttribute.Header, botKey);
            using var resp = await _botHttp.SendAsync(req);
            if (!resp.IsSuccessStatusCode)
            {
                return StatusCode(502, new { message = "El servicio de WhatsApp no respondió correctamente." });
            }

            var json = await resp.Content.ReadAsStringAsync();
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;

            // El bot actual atiende una sola barbería: solo su dueño puede ver el QR.
            var slugBot = root.TryGetProperty("barberiaSlug", out var s) ? s.GetString() : null;
            var slugAdmin = User.FindFirst("BarberiaSlug")?.Value;
            if (string.IsNullOrEmpty(slugBot) || !string.Equals(slugBot, slugAdmin, StringComparison.OrdinalIgnoreCase))
            {
                return StatusCode(403, new { message = "El bot de WhatsApp no está asignado a tu barbería." });
            }

            return Content(json, "application/json");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Bot Estado Error]: {ex.Message}");
            return StatusCode(502, new { message = "No se pudo conectar con el servicio de WhatsApp." });
        }
    }
}
