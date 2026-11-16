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

            var botReglas = await _context.BotReglas
                .Where(r => r.BarberiaId == barberia.Id && r.Activo)
                .Select(r => new { r.Id, r.PalabrasClave, r.Respuesta })
                .ToListAsync();

            // Citas reservadas actualmente para no permitir sobreposiciones (incluyendo duración real del servicio)
            var citasOcupadas = await _context.Citas
                .Include(c => c.Servicio)
                .Where(c => c.BarberiaId == barberia.Id && c.Estado != "Cancelada" && c.Estado != "No Confirmada")
                .Select(c => new 
                { 
                    c.Fecha, 
                    c.Hora, 
                    c.MiembroEquipoId,
                    DuracionMinutos = c.Servicio != null ? c.Servicio.DuracionMinutos : 40
                })
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

        var servicio = barberia.Servicios.FirstOrDefault(s => s.Id == dto.ServicioId);
        if (servicio == null)
        {
            return BadRequest(new { message = "Servicio no válido." });
        }

        // Validación matemática de traslape con citas existentes según duración del servicio
        static int ConvertirHoraAMinutos(string hStr)
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

        var nuevoTurnoInicio = ConvertirHoraAMinutos(dto.Hora);
        var nuevoTurnoFin = nuevoTurnoInicio + servicio.DuracionMinutos;

        var citasDia = await _context.Citas
            .Include(c => c.Servicio)
            .Where(c => c.BarberiaId == barberia.Id && c.Fecha == dto.Fecha && c.Estado != "Cancelada" && c.Estado != "No Confirmada")
            .Where(c => dto.MiembroEquipoId == null || c.MiembroEquipoId == null || c.MiembroEquipoId == dto.MiembroEquipoId)
            .ToListAsync();

        var hayTraslapeCita = citasDia.Any(c =>
        {
            if (dto.ReagendarCitaId.HasValue && c.Id == dto.ReagendarCitaId.Value) return false;
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
            Estado = "Confirmada"
        };

        // Si es un reagendamiento, cancelar automáticamente la cita anterior
        if (dto.ReagendarCitaId.HasValue)
        {
            var citaAnterior = await _context.Citas.FindAsync(dto.ReagendarCitaId.Value);
            if (citaAnterior != null && citaAnterior.BarberiaId == barberia.Id)
            {
                citaAnterior.Estado = "Cancelada";
            }
        }

        _context.Citas.Add(cita);
        await _context.SaveChangesAsync();

        // 🚀 DISPARAR NOTIFICACIÓN AUTOMÁTICA AL BOT DE WHATSAPP (SEGUNDO PLANO)
        _ = Task.Run(async () =>
        {
            try
            {
                var botUrl = Environment.GetEnvironmentVariable("BARBERFLOW_BOT_URL") ?? "https://barberflow-bot.onrender.com";
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
                var notifPayload = new
                {
                    citaId = cita.Id,
                    codigoReserva = cita.CodigoReserva,
                    barberiaSlug = barberia.Slug,
                    barberiaNombre = barberia.Nombre,
                    barberiaDireccion = barberia.Direccion,
                    barberiaTelefono = barberia.TelefonoWhatsApp,
                    nombreCliente = cita.NombreCliente,
                    telefonoCliente = cita.TelefonoCliente,
                    servicio = servicio.Nombre,
                    fecha = cita.Fecha,
                    hora = cita.Hora,
                    total = cita.Total
                };
                var jsonContent = new StringContent(
                    System.Text.Json.JsonSerializer.Serialize(notifPayload),
                    System.Text.Encoding.UTF8,
                    "application/json"
                );
                await http.PostAsync($"{botUrl}/api/notificar-cita", jsonContent);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Bot Notificar Cita Error]: {ex.Message}");
            }
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

    // 🌟 RESEÑA POST-CITA VERIFICADA (DESDE WHATSAPP BOT LINK)
    [HttpGet("cita-resena/{citaId}")]
    public async Task<IActionResult> ObtenerDatosResena(int citaId)
    {
        var cita = await _context.Citas
            .Include(c => c.Servicio)
            .FirstOrDefaultAsync(c => c.Id == citaId);

        if (cita == null) return NotFound(new { message = "Cita no encontrada." });

        var barberia = await _context.Barberias.FindAsync(cita.BarberiaId);
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        return Ok(new
        {
            cita.Id,
            cita.NombreCliente,
            cita.Fecha,
            cita.Hora,
            Servicio = cita.Servicio?.Nombre ?? "Servicio",
            BarberiaNombre = barberia.Nombre,
            BarberiaSlug = barberia.Slug
        });
    }

    [HttpPost("calificar-cita")]
    public async Task<IActionResult> CalificarCita([FromBody] ReseñaCitaDto dto)
    {
        var cita = await _context.Citas.FindAsync(dto.CitaId);
        if (cita == null) return NotFound(new { message = "Cita no encontrada." });

        if (dto.Estrellas < 1 || dto.Estrellas > 5)
        {
            return BadRequest(new { message = "La calificación debe ser de 1 a 5 estrellas." });
        }

        var val = new Valoracion
        {
            BarberiaId = cita.BarberiaId,
            NombreCliente = cita.NombreCliente,
            Estrellas = dto.Estrellas,
            Comentario = dto.Comentario?.Trim() ?? string.Empty,
            FechaUtc = DateTime.UtcNow
        };

        _context.Valoraciones.Add(val);
        await _context.SaveChangesAsync();

        return Ok(new { message = "¡Gracias por calificar tu servicio!" });
    }

    // 📱 CONSULTA Y GESTIÓN DE CITAS PARA EL BOT (CANCELAR / CITAS DEL DÍA)
    [HttpGet("bot/citas-cliente/{telefono}")]
    public async Task<IActionResult> ObtenerCitaClientePorTelefono(string telefono)
    {
        var cleanTel = new string(telefono.Where(char.IsDigit).ToArray());
        var ultimos10 = cleanTel.Length >= 10 ? cleanTel.Substring(cleanTel.Length - 10) : cleanTel;

        var cita = await _context.Citas
            .Include(c => c.Servicio)
            .Include(c => c.MiembroEquipo)
            .Where(c => c.Estado != "Cancelada" && 
                       (c.TelefonoCliente.Contains(cleanTel) || c.TelefonoCliente.Contains(ultimos10)))
            .OrderByDescending(c => c.Fecha)
            .ThenByDescending(c => c.Hora)
            .FirstOrDefaultAsync();

        if (cita == null) return NotFound(new { message = "No tienes citas activas para cancelar." });

        return Ok(new
        {
            cita.Id,
            cita.CodigoReserva,
            cita.NombreCliente,
            cita.TelefonoCliente,
            cita.Fecha,
            cita.Hora,
            cita.Total,
            Servicio = cita.Servicio?.Nombre ?? "Servicio",
            Barbero = cita.MiembroEquipo?.Nombre ?? "Master Barber"
        });
    }

    [HttpPost("bot/cancelar-cita/{id}")]
    public async Task<IActionResult> CancelarCitaBot(int id)
    {
        var cita = await _context.Citas
            .Include(c => c.Servicio)
            .FirstOrDefaultAsync(c => c.Id == id);

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

    [HttpGet("bot/resumen-diario/{slug}")]
    public async Task<IActionResult> ObtenerResumenDiario(string slug, [FromQuery] string? fecha)
    {
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == slug.ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        var fechaFiltro = string.IsNullOrWhiteSpace(fecha) 
            ? DateTime.UtcNow.ToString("yyyy-MM-dd") 
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
    [HttpPost("clientes/registro")]
    public async Task<IActionResult> RegistrarCliente([FromBody] ClienteRegisterDto dto)
    {
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == dto.BarberiaSlug.ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        var telLimpio = new string(dto.Telefono.Where(char.IsDigit).ToArray());
        if (string.IsNullOrWhiteSpace(telLimpio) || telLimpio.Length < 7)
        {
            return BadRequest(new { message = "Número de teléfono no válido." });
        }

        var ultimos10 = telLimpio.Length >= 10 ? telLimpio.Substring(telLimpio.Length - 10) : telLimpio;

        var existe = await _context.Clientes.AnyAsync(c => 
            c.BarberiaId == barberia.Id && (c.Telefono == telLimpio || c.Telefono.EndsWith(ultimos10)));
        if (existe)
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

        return Ok(new
        {
            cliente.Id,
            cliente.Nombre,
            cliente.Telefono,
            cliente.Genero,
            message = "Cuenta creada con éxito."
        });
    }

    [HttpPost("clientes/login")]
    public async Task<IActionResult> LoginCliente([FromBody] ClienteLoginDto dto)
    {
        var barberia = await _context.Barberias.FirstOrDefaultAsync(b => b.Slug == dto.BarberiaSlug.ToLower());
        if (barberia == null) return NotFound(new { message = "Barbería no encontrada." });

        var telLimpio = new string(dto.Telefono.Where(char.IsDigit).ToArray());
        var ultimos10 = telLimpio.Length >= 10 ? telLimpio.Substring(telLimpio.Length - 10) : telLimpio;

        var cliente = await _context.Clientes.FirstOrDefaultAsync(c => 
            c.BarberiaId == barberia.Id && (c.Telefono == telLimpio || c.Telefono.EndsWith(ultimos10)));

        if (cliente == null || !BCrypt.Net.BCrypt.Verify(dto.Password, cliente.PasswordHash))
        {
            return BadRequest(new { message = "Teléfono o contraseña incorrecta." });
        }

        return Ok(new
        {
            cliente.Id,
            cliente.Nombre,
            cliente.Telefono,
            cliente.Genero,
            message = "Bienvenido de nuevo."
        });
    }

    [HttpGet("clientes/{id}/citas")]
    public async Task<IActionResult> ObtenerCitasCliente(int id)
    {
        var cliente = await _context.Clientes.FindAsync(id);
        if (cliente == null) return NotFound(new { message = "Cliente no encontrado." });

        var clienteTelDigits = new string(cliente.Telefono.Where(char.IsDigit).ToArray());
        var clienteUltimos10 = clienteTelDigits.Length >= 10 ? clienteTelDigits.Substring(clienteTelDigits.Length - 10) : clienteTelDigits;

        var citas = await _context.Citas
            .Include(c => c.Servicio)
            .Include(c => c.MiembroEquipo)
            .Where(c => c.BarberiaId == cliente.BarberiaId && 
                       (c.TelefonoCliente.Contains(clienteTelDigits) || c.TelefonoCliente.Contains(clienteUltimos10)))
            .OrderByDescending(c => c.Fecha)
            .ThenByDescending(c => c.Hora)
            .Select(c => new
            {
                c.Id,
                c.CodigoReserva,
                c.Fecha,
                c.Hora,
                c.Total,
                c.Estado,
                Servicio = c.Servicio != null ? c.Servicio.Nombre : "Servicio",
                Barbero = c.MiembroEquipo != null ? c.MiembroEquipo.Nombre : "Master Barber"
            })
            .ToListAsync();

        return Ok(citas);
    }
}

public record ValoracionDto(string BarberiaSlug, string NombreCliente, int Estrellas, string? Comentario);
