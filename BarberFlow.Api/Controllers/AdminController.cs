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
[InvalidaCachePublica] // lo que el barbero guarda se ve al instante en su página
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
                barberia.PortadaPosicion,
                HorarioSemanal = HorarioSemanal.DeBarberia(barberia),
                barberia.DiasMaximoReserva,
                barberia.HorasLimiteCancelar,
                barberia.HorarioTexto,
                barberia.HoraApertura,
                barberia.HoraCierre,
                barberia.IntervaloMinutos,
                barberia.MinutosAnticipacion,
                barberia.RecordatoriosActivos,
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

    public record BotActivoDto(bool Activo);

    // Encender / apagar el bot al instante desde el interruptor del panel
    [HttpPut("bot/activo")]
    public async Task<IActionResult> CambiarBotActivo([FromBody] BotActivoDto dto)
    {
        var barberia = await _context.Barberias.FindAsync(ObtenerBarberiaId());
        if (barberia == null) return NotFound();
        barberia.BotActivo = dto.Activo;
        await _context.SaveChangesAsync();
        return Ok(new { barberia.BotActivo });
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
            // Solo se revisa si cambió (un logo antiguo grande no debe impedir guardar lo demás)
            if (barberia.LogoUrl != dto.LogoUrl.Trim() && !ImagenValida(dto.LogoUrl.Trim())) return BadRequest(new { message = "La foto de perfil no es válida o es demasiado grande." });
            if (barberia.LogoUrl != dto.LogoUrl.Trim()) barberia.ReaccionesLogo = ""; // logo nuevo: reacciones desde cero
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
            var valida = portada == "" || System.Text.RegularExpressions.Regex.IsMatch(portada, "^preset:[a-z]{3,20}$") || portada.Length <= 900_000 &&
                (portada.StartsWith("data:image/jpeg;base64,") || portada.StartsWith("data:image/png;base64,") ||
                 portada.StartsWith("data:image/webp;base64,") || portada.StartsWith("https://") || portada.StartsWith("/uploads/"));
            if (!valida) return BadRequest(new { message = "La imagen de portada no es válida o es demasiado grande." });
            if (barberia.PortadaUrl != portada) barberia.ReaccionesPortada = ""; // portada nueva: reacciones desde cero
            if (dto.PortadaPosicion != null && System.Text.RegularExpressions.Regex.IsMatch(dto.PortadaPosicion, @"^(100|\d{1,2}) (100|\d{1,2})( (1\d\d|2\d\d|300))?$"))
                barberia.PortadaPosicion = dto.PortadaPosicion;
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
        if (dto.RecordatoriosActivos.HasValue) barberia.RecordatoriosActivos = dto.RecordatoriosActivos.Value;
        if (dto.HorasRecordatorio is 1 or 2 or 3 or 6 or 12 or 24) barberia.HorasRecordatorio = dto.HorasRecordatorio.Value;
        if (dto.HorasRecordatorios != null)
        {
            // Solo valores permitidos, sin repetir, del más lejano al más cercano: "48,24,2"
            var permitidas = new[] { 48, 24, 12, 6, 3, 2, 1 };
            var elegidas = dto.HorasRecordatorios.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(h => int.TryParse(h, out var n) ? n : 0)
                .Where(permitidas.Contains).Distinct().OrderByDescending(h => h).ToList();
            if (elegidas.Count == 0) return BadRequest(new { message = "Elige al menos un momento para el recordatorio, o apaga los recordatorios." });
            barberia.HorasRecordatorios = string.Join(",", elegidas);
        }
        if (dto.PedirOpinionActivo.HasValue) barberia.PedirOpinionActivo = dto.PedirOpinionActivo.Value;
        if (dto.MinutosPausaBot is 30 or 60 or 120 or 240 or 480 or 1440) barberia.MinutosPausaBot = dto.MinutosPausaBot.Value;
        if (dto.DiasMaximoReserva is 7 or 14 or 30 or 60 or 90) barberia.DiasMaximoReserva = dto.DiasMaximoReserva.Value;
        if (dto.HorasLimiteCancelar is 0 or 1 or 2 or 3 or 6 or 12 or 24) barberia.HorasLimiteCancelar = dto.HorasLimiteCancelar.Value;
        if (!string.IsNullOrWhiteSpace(dto.HorarioSemanal))
        {
            var (json, error) = HorarioSemanal.Normalizar(dto.HorarioSemanal);
            if (error != null) return BadRequest(new { message = error });
            barberia.HorarioSemanal = json!;
            // Los campos antiguos quedan como resumen (los usan el bot y otras pantallas)
            var (apertura, cierre, dias) = HorarioSemanal.Resumen(HorarioSemanal.Leer(json)!);
            barberia.HoraApertura = apertura;
            barberia.HoraCierre = cierre;
            barberia.DiasLaborales = dias;
        }
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
        // Datos personales que no tienen borrado en cascada en la base: se borran a mano
        var clientes = await _context.Clientes.Where(c => c.BarberiaId == barberiaId).ToListAsync();
        _context.Clientes.RemoveRange(clientes);
        _context.BotReglas.RemoveRange(await _context.BotReglas.Where(r => r.BarberiaId == barberiaId).ToListAsync());
        _context.ListaEspera.RemoveRange(await _context.ListaEspera.Where(l => l.BarberiaId == barberiaId).ToListAsync());
        _context.SuscripcionesPush.RemoveRange(await _context.SuscripcionesPush.Where(s => s.BarberiaId == barberiaId).ToListAsync());
        _context.Valoraciones.RemoveRange(await _context.Valoraciones.Where(v => v.BarberiaId == barberiaId).ToListAsync());
        _context.Bloqueos.RemoveRange(await _context.Bloqueos.Where(b => b.BarberiaId == barberiaId).ToListAsync());
        _context.Citas.RemoveRange(await _context.Citas.Where(c => c.BarberiaId == barberiaId).ToListAsync());
        foreach (var c in clientes) VersionesSesion.Olvidar("c", c.Id);
        if (user != null) VersionesSesion.Olvidar("b", user.Id);
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

        var hoy = EstadosCitas.AhoraColombia().Date;
        if (filtro == "semana")
        {
            var lunes = hoy.AddDays(-(((int)hoy.DayOfWeek + 6) % 7));
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
                Barbero = c.MiembroEquipo != null ? c.MiembroEquipo.Nombre : "" // sin barbero asignado
            })
            .ToListAsync();

        return Ok(citas);
    }

    // Imagen guardada en la base: data:image (máx. ~900 KB) o enlace https / subida propia (no "//otro-sitio")
    internal static bool ImagenValida(string valor) =>
        valor.Length <= 900_000 &&
        (valor.StartsWith("data:image/jpeg;base64,") || valor.StartsWith("data:image/png;base64,") ||
         valor.StartsWith("data:image/webp;base64,") || (valor.StartsWith("data:image/svg+xml;utf8,") && valor.Length < 3000 && !valor.Contains("script", StringComparison.OrdinalIgnoreCase) && !valor.Contains("on", StringComparison.Ordinal) ) ||
         valor.StartsWith("https://") || valor.StartsWith("/uploads/"));

    private static readonly string[] EstadosValidos =
        { EstadosCitas.Pendiente, EstadosCitas.Confirmada, EstadosCitas.NoConfirmada, EstadosCitas.Completada, EstadosCitas.Cancelada };

    [HttpPatch("citas/{id}/estado")]
    public async Task<IActionResult> CambiarEstadoCita(int id, [FromBody] CambiarEstadoCitaDto dto)
    {
        if (!EstadosValidos.Contains(dto.Estado)) return BadRequest(new { message = "Estado no válido." });
        var barberiaId = ObtenerBarberiaId();
        var cita = await _context.Citas
            .Include(c => c.Servicio)
            .Include(c => c.MiembroEquipo)
            .FirstOrDefaultAsync(c => c.Id == id && c.BarberiaId == barberiaId);

        if (cita == null) return NotFound(new { message = "Cita no encontrada." });

        var estabaActiva = cita.Estado == EstadosCitas.Pendiente || cita.Estado == EstadosCitas.Confirmada;
        cita.Estado = dto.Estado;
        await _context.SaveChangesAsync();
        if (estabaActiva && dto.Estado == EstadosCitas.Cancelada)
            ListaEsperaAvisos.TurnoLiberado(barberiaId, cita.Fecha, cita.Hora, cita.MiembroEquipoId);

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
        if (cita.Estado == EstadosCitas.Pendiente || cita.Estado == EstadosCitas.Confirmada)
            ListaEsperaAvisos.TurnoLiberado(barberiaId, cita.Fecha, cita.Hora, cita.MiembroEquipoId);

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
            FotoUrl = string.IsNullOrWhiteSpace(dto.FotoUrl) || !ImagenValida(dto.FotoUrl.Trim()) ? defaultAvatar : dto.FotoUrl.Trim(),
            Activo = true
        };
        _context.Miembros.Add(miembro);
        await _context.SaveChangesAsync();
        return Ok(miembro);
    }

    // Horario propio de un barbero (null o vacío = usa el horario de la barbería)
    [HttpPut("miembros/{id}/horario")]
    public async Task<IActionResult> GuardarHorarioMiembro(int id, [FromBody] HorarioMiembroDto dto)
    {
        var barberiaId = ObtenerBarberiaId();
        var miembro = await _context.Miembros.FirstOrDefaultAsync(m => m.Id == id && m.BarberiaId == barberiaId);
        if (miembro == null) return NotFound(new { message = "Barbero no encontrado." });
        if (string.IsNullOrWhiteSpace(dto.HorarioSemanal))
        {
            miembro.HorarioSemanal = "";
        }
        else
        {
            var (json, error) = HorarioSemanal.Normalizar(dto.HorarioSemanal);
            if (error != null) return BadRequest(new { message = error });
            miembro.HorarioSemanal = json!;
        }
        await _context.SaveChangesAsync();
        return Ok(new { message = string.IsNullOrEmpty(miembro.HorarioSemanal) ? "Ahora usa el horario de la barbería." : "Horario guardado." });
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
            if (miembro.FotoUrl == dto.FotoUrl || ImagenValida((dto.FotoUrl ?? "").Trim())) miembro.FotoUrl = dto.FotoUrl;
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
        var barberia = await _context.Barberias.FindAsync(ObtenerBarberiaId());
        if (barberia == null) return NotFound();

        var formato = System.Globalization.CultureInfo.InvariantCulture;
        if (!DateTime.TryParseExact(dto.Fecha, "yyyy-MM-dd", formato, System.Globalization.DateTimeStyles.None, out var desde))
            return BadRequest(new { message = "La fecha no es válida." });
        var hasta = desde;
        if (!string.IsNullOrWhiteSpace(dto.FechaHasta))
        {
            if (!DateTime.TryParseExact(dto.FechaHasta, "yyyy-MM-dd", formato, System.Globalization.DateTimeStyles.None, out hasta) || hasta < desde)
                return BadRequest(new { message = "La fecha final debe ser igual o posterior a la inicial." });
            if ((hasta - desde).TotalDays >= 60)
                return BadRequest(new { message = "Puedes bloquear máximo 60 días seguidos." });
        }

        var hora = string.IsNullOrWhiteSpace(dto.Hora) ? "TODO_EL_DIA" : dto.Hora.Trim();
        var motivo = string.IsNullOrWhiteSpace(dto.Motivo) ? "Descanso / No disponible" : dto.Motivo.Trim();
        if (motivo.Length > 80) motivo = motivo[..80];
        var esDiaCompleto = hora == "TODO_EL_DIA";

        var fechas = Enumerable.Range(0, (hasta - desde).Days + 1).Select(i => desde.AddDays(i).ToString("yyyy-MM-dd")).ToList();
        var diasYaCerrados = esDiaCompleto
            ? await _context.Bloqueos
                .Where(b => b.BarberiaId == barberia.Id && fechas.Contains(b.Fecha) && (b.Hora == null || b.Hora == "" || b.Hora == "TODO_EL_DIA"))
                .Select(b => b.Fecha).ToListAsync()
            : new List<string>();

        var creados = fechas.Where(f => !diasYaCerrados.Contains(f))
            .Select(f => new HorarioBloqueo { BarberiaId = barberia.Id, Fecha = f, Hora = hora, Motivo = motivo })
            .ToList();
        _context.Bloqueos.AddRange(creados);
        await _context.SaveChangesAsync();

        // Citas activas que quedan dentro del bloqueo: el panel ofrece avisarles para que reagenden
        int ini, fin;
        if (esDiaCompleto) { ini = 0; fin = 24 * 60; }
        else if (hora.Contains('-'))
        {
            var partes = hora.Split('-');
            ini = EstadosCitas.HoraAMinutos(partes[0]);
            fin = EstadosCitas.HoraAMinutos(partes[1]);
        }
        else { ini = EstadosCitas.HoraAMinutos(hora); fin = ini + barberia.IntervaloMinutos; }

        var ahora = EstadosCitas.AhoraColombia();
        var citas = await _context.Citas.Include(c => c.Servicio).Include(c => c.MiembroEquipo)
            .Where(c => c.BarberiaId == barberia.Id && fechas.Contains(c.Fecha)
                        && (c.Estado == EstadosCitas.Pendiente || c.Estado == EstadosCitas.Confirmada))
            .ToListAsync();
        var afectadas = citas
            .Where(c =>
            {
                var ci = EstadosCitas.HoraAMinutos(c.Hora);
                var cf = ci + (c.Servicio?.DuracionMinutos ?? barberia.IntervaloMinutos);
                var inicio = EstadosCitas.InicioCita(c.Fecha, c.Hora);
                return ci < fin && cf > ini && inicio != null && inicio.Value > ahora;
            })
            .OrderBy(c => c.Fecha).ThenBy(c => EstadosCitas.HoraAMinutos(c.Hora))
            .Select(c => new { c.Id, c.NombreCliente, c.Fecha, c.Hora, Servicio = c.Servicio?.Nombre ?? "", Barbero = c.MiembroEquipo != null ? c.MiembroEquipo.Nombre : "" })
            .ToList();

        return Ok(new { bloqueos = creados, citasAfectadas = afectadas, avisoPorWhatsApp = PublicController.BotAtiende(barberia) });
    }

    // ----- Agendar en local: ¿la hora elegida se cruza? ¿qué citas habría que correr? -----
    public record SimularCitaLocalDto(string Fecha, string Hora, int ServicioId, int? MiembroEquipoId);

    [HttpPost("citas/simular-local")]
    public async Task<IActionResult> SimularCitaLocal([FromBody] SimularCitaLocalDto dto)
    {
        var barberia = await _context.Barberias.AsNoTracking()
            .Include(b => b.Servicios)
            .Include(b => b.Miembros)
            .FirstOrDefaultAsync(b => b.Id == ObtenerBarberiaId());
        if (barberia == null) return NotFound();
        var servicio = barberia.Servicios.FirstOrDefault(s => s.Id == dto.ServicioId);
        if (servicio == null) return BadRequest(new { message = "Servicio no válido." });

        var inicio = EstadosCitas.HoraAMinutos(dto.Hora);
        var fin = inicio + servicio.DuracionMinutos;
        var citas = await _context.Citas.AsNoTracking().Include(c => c.Servicio).Include(c => c.MiembroEquipo)
            .Where(c => c.BarberiaId == barberia.Id && c.Fecha == dto.Fecha && c.Estado != EstadosCitas.Cancelada && c.Estado != EstadosCitas.NoConfirmada)
            .ToListAsync();

        var miembros = barberia.Miembros.Where(m => m.Activo).ToList();
        var varios = barberia.MostrarSelectorBarbero && miembros.Count > 1;
        bool Cruza(Cita c)
        {
            var ci = EstadosCitas.HoraAMinutos(c.Hora);
            var cf = ci + (c.Servicio?.DuracionMinutos ?? barberia.IntervaloMinutos);
            return inicio < cf && fin > ci;
        }
        List<Cita> AgendaDe(int? miembroId) => varios && miembroId != null
            ? citas.Where(c => c.MiembroEquipoId == null || c.MiembroEquipoId == miembroId).ToList()
            : citas;

        // "Cualquiera": basta con que un barbero esté libre (se le asigna a él)
        if (varios && dto.MiembroEquipoId == null)
        {
            var hayLibre = miembros.Any(m => !AgendaDe(m.Id).Any(Cruza));
            return Ok(new { choca = !hayLibre, todosOcupados = !hayLibre });
        }

        var agenda = AgendaDe(varios ? dto.MiembroEquipoId : null);
        var choques = agenda.Where(Cruza).OrderBy(c => EstadosCitas.HoraAMinutos(c.Hora)).ToList();
        if (choques.Count == 0) return Ok(new { choca = false });

        var (cambios, bloqueante) = CorrimientoCitas.Planear(agenda, inicio, fin, barberia.IntervaloMinutos);
        return Ok(new
        {
            choca = true,
            conQuien = choques.Select(c => new { c.NombreCliente, c.Hora, Barbero = c.MiembroEquipo != null ? c.MiembroEquipo.Nombre : "" }),
            bloqueante = bloqueante == null ? null : new { bloqueante.NombreCliente, bloqueante.Hora },
            cambios = cambios.Select(cm => new { cm.Cita.NombreCliente, cm.HoraAnterior, cm.HoraNueva }),
            horaCierre = barberia.HoraCierre
        });
    }

    // Imprevisto: el barbero no podrá atender estas citas. Se cancelan y el bot le escribe a cada cliente
    // con el motivo y el enlace para elegir otra hora (el barbero también puede escribirle personalmente).
    [HttpPost("citas/avisar-imprevisto")]
    public async Task<IActionResult> AvisarImprevisto([FromBody] AvisarImprevistoDto dto)
    {
        var barberia = await _context.Barberias.FindAsync(ObtenerBarberiaId());
        if (barberia == null) return NotFound();
        var ids = (dto.CitaIds ?? new List<int>()).Distinct().Take(200).ToList();
        if (ids.Count == 0) return BadRequest(new { message = "No hay citas para avisar." });

        var citas = await _context.Citas.Include(c => c.Servicio)
            .Where(c => c.BarberiaId == barberia.Id && ids.Contains(c.Id)
                        && (c.Estado == EstadosCitas.Pendiente || c.Estado == EstadosCitas.Confirmada))
            .ToListAsync();
        // ¿El bot puede escribirles ahora mismo? (atiende esta barbería y WhatsApp está conectado)
        var botListo = await BotConectadoAsync(barberia);
        foreach (var c in citas) c.Estado = EstadosCitas.Cancelada;
        await _context.SaveChangesAsync();

        var motivo = (dto.Motivo ?? "").Trim();
        if (motivo.Length > 80) motivo = motivo[..80];
        if (botListo) PublicController.NotificarBot("/api/notificar-imprevisto", barberia, new
        {
            barberiaSlug = barberia.Slug,
            barberiaNombre = barberia.Nombre,
            motivo,
            citas = citas.Select(c => new
            {
                id = c.Id,
                nombreCliente = c.NombreCliente,
                telefonoCliente = c.TelefonoCliente,
                servicio = c.Servicio?.Nombre ?? "",
                fecha = c.Fecha,
                hora = c.Hora
            })
        });

        return Ok(new
        {
            canceladas = citas.Count,
            avisoPorWhatsApp = botListo,
            // Para avisar a mano si el bot no está conectado
            clientes = citas.Select(c => new { c.NombreCliente, c.TelefonoCliente, c.Fecha, c.Hora, Servicio = c.Servicio?.Nombre ?? "" })
        });
    }

    // El bot atiende esta barbería y su WhatsApp está conectado en este momento
    private static async Task<bool> BotConectadoAsync(Barberia barberia)
    {
        if (!PublicController.BotAtiende(barberia)) return false;
        var botKey = Environment.GetEnvironmentVariable("BOT_API_KEY");
        if (string.IsNullOrWhiteSpace(botKey)) return false;
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, PublicController.UrlBot("/api/status", barberia.Slug));
            req.Headers.Add(RequiereBotKeyAttribute.Header, botKey);
            using var resp = await _botHttp.SendAsync(req);
            if (!resp.IsSuccessStatusCode) return false;
            using var doc = System.Text.Json.JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
            return doc.RootElement.TryGetProperty("conectado", out var c) && c.ValueKind == System.Text.Json.JsonValueKind.True
                && doc.RootElement.TryGetProperty("barberiaSlug", out var s) && string.Equals(s.GetString(), barberia.Slug, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Bot estado] No respondió: {ex.Message}");
            return false;
        }
    }

    [HttpDelete("bloqueos/{id}")]
    public async Task<IActionResult> EliminarBloqueo(int id)
    {
        var barberiaId = ObtenerBarberiaId();
        var bloqueo = await _context.Bloqueos.FirstOrDefaultAsync(b => b.Id == id && b.BarberiaId == barberiaId);
        if (bloqueo == null) return NotFound();

        _context.Bloqueos.Remove(bloqueo);
        await _context.SaveChangesAsync();
        // Se abrieron horas: avisar a la lista de espera de ese día
        var horaLibre = string.IsNullOrEmpty(bloqueo.Hora) || bloqueo.Hora == "TODO_EL_DIA" ? null : bloqueo.Hora.Split('-')[0];
        ListaEsperaAvisos.TurnoLiberado(barberiaId, bloqueo.Fecha, horaLibre, null);
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

    // Desvincular el WhatsApp actual del bot y generar un QR nuevo (p. ej. pasar del número de prueba al real)
    [HttpPost("bot/reiniciar")]
    public async Task<IActionResult> ReiniciarBot()
    {
        var botKey = Environment.GetEnvironmentVariable("BOT_API_KEY");
        if (string.IsNullOrWhiteSpace(botKey)) return StatusCode(503, new { message = "BOT_API_KEY no está configurada en el servidor." });
        var barberia = await _context.Barberias.FindAsync(ObtenerBarberiaId());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        try
        {
            // Cada barbería solo puede desvincular SU propio WhatsApp (el gestor del bot separa por slug)
            using var req = new HttpRequestMessage(HttpMethod.Post, PublicController.UrlBot("/api/reset", barberia.Slug));
            req.Headers.Add(RequiereBotKeyAttribute.Header, botKey);
            using var resp = await _botHttp.SendAsync(req);
            if (resp.IsSuccessStatusCode && barberia.BotWhatsApp)
            {
                barberia.BotWhatsApp = false; // vuelve a quedar marcada cuando escaneen el QR nuevo
                await _context.SaveChangesAsync();
            }
            return resp.IsSuccessStatusCode
                ? Ok(new { message = "WhatsApp desvinculado. En unos segundos aparece un QR nuevo." })
                : StatusCode((int)resp.StatusCode == 409 ? 409 : 502, new { message = (int)resp.StatusCode == 409
                    ? "El servicio de WhatsApp ya atiende el máximo de barberías. Escríbenos para habilitar la tuya."
                    : "El servicio de WhatsApp no pudo reiniciarse." });
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Bot Reiniciar Error]: {ex.Message}");
            return StatusCode(502, new { message = "No se pudo conectar con el servicio de WhatsApp." });
        }
    }

    public record ProbarBotDto(string? Texto, bool Reiniciar = false);

    // Chat de prueba del panel: el bot responde como si el barbero fuera un cliente, sin enviar nada por WhatsApp
    [HttpPost("bot/probar")]
    public async Task<IActionResult> ProbarBot([FromBody] ProbarBotDto dto)
    {
        var botKey = Environment.GetEnvironmentVariable("BOT_API_KEY");
        if (string.IsNullOrWhiteSpace(botKey)) return StatusCode(503, new { message = "BOT_API_KEY no está configurada en el servidor." });
        var slugAdmin = User.FindFirst("BarberiaSlug")?.Value ?? "";
        var texto = (dto.Texto ?? "").Trim();
        if (texto.Length > 500) texto = texto[..500];

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, PublicController.UrlBot("/api/probar", slugAdmin))
            {
                Content = JsonContent.Create(new { slug = slugAdmin, texto, reiniciar = dto.Reiniciar })
            };
            req.Headers.Add(RequiereBotKeyAttribute.Header, botKey);
            using var resp = await _botHttp.SendAsync(req);
            if (resp.StatusCode == System.Net.HttpStatusCode.Forbidden)
                return StatusCode(403, new { message = "El bot de WhatsApp no está asignado a tu barbería." });
            if (resp.StatusCode == System.Net.HttpStatusCode.Conflict)
                return StatusCode(409, new { message = "El servicio de WhatsApp ya atiende el máximo de barberías. Escríbenos para habilitar la tuya." });
            if (!resp.IsSuccessStatusCode)
                return StatusCode(502, new { message = "El bot no pudo responder la prueba." });
            return Content(await resp.Content.ReadAsStringAsync(), "application/json");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Bot Probar Error]: {ex.Message}");
            return StatusCode(502, new { message = "No se pudo conectar con el bot. Si está dormido, espera unos segundos y vuelve a intentar." });
        }
    }

    [HttpGet("bot/estado")]
    public async Task<IActionResult> ObtenerEstadoBot()
    {
        var botKey = Environment.GetEnvironmentVariable("BOT_API_KEY");
        if (string.IsNullOrWhiteSpace(botKey))
        {
            return StatusCode(503, new { message = "BOT_API_KEY no está configurada en el servidor." });
        }
        var barberia = await _context.Barberias.FindAsync(ObtenerBarberiaId());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        try
        {
            async Task<(System.Net.HttpStatusCode Codigo, string Json)> Pedir(HttpMethod metodo, string ruta)
            {
                using var req = new HttpRequestMessage(metodo, PublicController.UrlBot(ruta, barberia.Slug));
                req.Headers.Add(RequiereBotKeyAttribute.Header, botKey);
                using var resp = await _botHttp.SendAsync(req);
                return (resp.StatusCode, await resp.Content.ReadAsStringAsync());
            }

            var (codigo, json) = await Pedir(HttpMethod.Get, "/api/status");
            if ((int)codigo >= 300)
            {
                return StatusCode(502, new { message = "El servicio de WhatsApp no respondió correctamente." });
            }
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;

            // Esta barbería todavía no tiene su bot encendido: se enciende para mostrarle su QR
            if (root.TryGetProperty("sinSesion", out var sinSesion) && sinSesion.ValueKind == System.Text.Json.JsonValueKind.True)
            {
                var (codVincular, jsonVincular) = await Pedir(HttpMethod.Post, "/api/vincular");
                if (codVincular == System.Net.HttpStatusCode.Conflict)
                    return StatusCode(409, new { message = "El servicio de WhatsApp ya atiende el máximo de barberías. Escríbenos para habilitar la tuya." });
                return Ok(new { barberiaSlug = barberia.Slug, conectado = false, estado = "Preparando tu código QR...", qr = "" });
            }

            // El servicio responde por otra barbería (bot antiguo de una sola barbería)
            var slugBot = root.TryGetProperty("barberiaSlug", out var s) ? s.GetString() : null;
            if (!string.Equals(slugBot, barberia.Slug, StringComparison.OrdinalIgnoreCase))
            {
                return StatusCode(403, new { message = "El bot de WhatsApp no está asignado a tu barbería." });
            }

            // Quedó vinculado: desde ahora los avisos de esta barbería salen por su WhatsApp
            var conectado = root.TryGetProperty("conectado", out var c) && c.ValueKind == System.Text.Json.JsonValueKind.True;
            if (conectado && !barberia.BotWhatsApp)
            {
                barberia.BotWhatsApp = true;
                await _context.SaveChangesAsync();
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
