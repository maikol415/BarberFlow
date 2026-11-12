using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using BarberFlow.Api.Data;
using BarberFlow.Api.DTOs;
using BarberFlow.Api.Models;

namespace BarberFlow.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class PublicController : ControllerBase
{
    private readonly AppDbContext _context;

    public PublicController(AppDbContext context)
    {
        _context = context;
    }

    [HttpGet("barberia/{slug}")]
    public async Task<IActionResult> ObtenerBarberia(string slug)
    {
        try
        {
            var barberia = await _context.Barberias
                .Include(b => b.Servicios.Where(s => s.Activo))
                .Include(b => b.Miembros.Where(m => m.Activo))
                .Include(b => b.Bloqueos)
                .FirstOrDefaultAsync(b => b.Slug == slug.ToLower());

            if (barberia == null)
            {
                return NotFound(new { message = "Barbería no encontrada." });
            }

            // Citas reservadas actualmente para no permitir sobreposiciones
            var citasOcupadas = await _context.Citas
                .Where(c => c.BarberiaId == barberia.Id && c.Estado != "Cancelada" && c.Estado != "No Confirmada")
                .Select(c => new { c.Fecha, c.Hora, c.MiembroEquipoId })
                .ToListAsync();

            // Conteo real de agendamientos históricos en el sistema
            var totalAgendamientosReales = await _context.Citas
                .CountAsync(c => c.BarberiaId == barberia.Id);

            int totalValoraciones = 0;
            double calificacion = 5.0;
            object ultimasValoraciones = new List<object>();

            try
            {
                var valoraciones = await _context.Valoraciones
                    .Where(v => v.BarberiaId == barberia.Id)
                    .OrderByDescending(v => v.FechaUtc)
                    .ToListAsync();

                totalValoraciones = valoraciones.Count;
                calificacion = totalValoraciones > 0 
                    ? Math.Round(valoraciones.Average(v => v.Estrellas), 1) 
                    : 5.0;

                ultimasValoraciones = valoraciones.Take(4).Select(v => new
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
                barberia.LogoUrl,
                barberia.HorarioTexto,
                barberia.HoraApertura,
                barberia.HoraCierre,
                barberia.IntervaloMinutos,
                barberia.DiasLaborales,
                barberia.MostrarSelectorBarbero,
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
                    m.FotoUrl
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
            return StatusCode(500, new { message = "Error obteniendo barberia", error = ex.Message, details = ex.ToString() });
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

        var bloqueoDia = barberia.Bloqueos.Any(b => b.Fecha == dto.Fecha && (string.IsNullOrEmpty(b.Hora) || b.Hora == "TODO_EL_DIA"));
        if (bloqueoDia)
        {
            return BadRequest(new { message = "El profesional o la barbería no tiene horarios disponibles para este día. Intenta otro día." });
        }

        var bloqueoHora = barberia.Bloqueos.Any(b => b.Fecha == dto.Fecha && b.Hora == dto.Hora);
        if (bloqueoHora)
        {
            return BadRequest(new { message = "Este horario ha sido bloqueado por la barbería." });
        }

        var citaExistente = await _context.Citas.AnyAsync(c =>
            c.BarberiaId == barberia.Id &&
            c.Fecha == dto.Fecha &&
            c.Hora == dto.Hora &&
            c.Estado != "Cancelada" &&
            c.Estado != "No Confirmada" &&
            (dto.MiembroEquipoId == null || c.MiembroEquipoId == null || c.MiembroEquipoId == dto.MiembroEquipoId)
        );

        if (citaExistente)
        {
            return BadRequest(new { message = "Ese horario ya fue reservado. Por favor elige otro horario." });
        }

        var servicio = barberia.Servicios.FirstOrDefault(s => s.Id == dto.ServicioId);
        if (servicio == null)
        {
            return BadRequest(new { message = "Servicio no válido." });
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
            Estado = "Confirmada"
        };

        _context.Citas.Add(cita);
        await _context.SaveChangesAsync();

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

    [HttpPost("valoraciones")]
    public async Task<IActionResult> EnviarValoracion([FromBody] ValoracionDto dto)
    {
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == dto.BarberiaSlug.ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        if (dto.Estrellas < 1 || dto.Estrellas > 5)
        {
            return BadRequest(new { message = "La valoración debe ser de 1 a 5 estrellas." });
        }

        var val = new Valoracion
        {
            BarberiaId = barberia.Id,
            NombreCliente = string.IsNullOrWhiteSpace(dto.NombreCliente) ? "Cliente" : dto.NombreCliente.Trim(),
            Estrellas = dto.Estrellas,
            Comentario = dto.Comentario?.Trim() ?? string.Empty
        };

        _context.Valoraciones.Add(val);
        await _context.SaveChangesAsync();

        return Ok(new { message = "¡Gracias por tu valoración!" });
    }
}

public record ValoracionDto(string BarberiaSlug, string NombreCliente, int Estrellas, string? Comentario);
