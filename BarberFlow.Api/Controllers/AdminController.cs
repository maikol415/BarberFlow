using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using BarberFlow.Api.Data;
using BarberFlow.Api.DTOs;
using BarberFlow.Api.Models;

namespace BarberFlow.Api.Controllers;

[Authorize]
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
        var barberiaId = ObtenerBarberiaId();
        var barberia = await _context.Barberias
            .Include(b => b.Servicios)
            .Include(b => b.Miembros)
            .Include(b => b.Bloqueos)
            .FirstOrDefaultAsync(b => b.Id == barberiaId);

        if (barberia == null) return NotFound();

        return Ok(barberia);
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
        if (!string.IsNullOrWhiteSpace(dto.DiasLaborales)) barberia.DiasLaborales = dto.DiasLaborales;
        barberia.MostrarSelectorBarbero = dto.MostrarSelectorBarbero;

        await _context.SaveChangesAsync();
        return Ok(new { message = "Configuración actualizada con éxito.", barberia });
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
            var match = System.Text.RegularExpressions.Regex.Match(dto.ImageData, @"data:image/(?<type>.+?);base64,(?<data>.+)");
            if (!match.Success)
            {
                return BadRequest(new { message = "Formato de imagen inválido." });
            }

            var extension = match.Groups["type"].Value;
            if (extension == "jpeg") extension = "jpg";
            var base64Data = match.Groups["data"].Value;
            var bytes = Convert.FromBase64String(base64Data);

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

        _context.Servicios.Remove(servicio);
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

    [HttpDelete("miembros/{id}")]
    public async Task<IActionResult> EliminarMiembro(int id)
    {
        var barberiaId = ObtenerBarberiaId();
        var miembro = await _context.Miembros.FirstOrDefaultAsync(m => m.Id == id && m.BarberiaId == barberiaId);
        if (miembro == null) return NotFound();

        _context.Miembros.Remove(miembro);
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
}
