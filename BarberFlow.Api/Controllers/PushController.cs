using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using BarberFlow.Api.Data;
using BarberFlow.Api.Models;
using BarberFlow.Api.Services;

namespace BarberFlow.Api.Controllers;

public record SuscripcionPushDto(string Endpoint, string? P256dh, string? Auth, string? Dispositivo);
public record PreferenciasPushDto(string Endpoint, bool AvisarNuevas, bool AvisarCancelaciones, bool ResumenMatutino, string? HoraResumen);
public record EndpointPushDto(string Endpoint);

/// <summary>Notificaciones push del panel: cada celular del barbero se suscribe y elige qué avisos quiere.</summary>
[Authorize(Policy = PoliticasAuth.Barbero)]
[ApiController]
[Route("api/admin/push")]
public class PushController : ControllerBase
{
    private static readonly string[] HorasResumen = { "05:30", "06:00", "06:30", "07:00", "07:30", "08:00", "08:30", "09:00", "10:00" };
    private readonly AppDbContext _context;

    public PushController(AppDbContext context) => _context = context;

    private int BarberiaId() =>
        int.TryParse(User.FindFirst(PoliticasAuth.ClaimBarberiaId)?.Value, out var id) ? id : throw new UnauthorizedAccessException("Sesión inválida.");

    private static object Preferencias(SuscripcionPush s) => new
    {
        suscrito = true,
        s.AvisarNuevas,
        s.AvisarCancelaciones,
        s.ResumenMatutino,
        s.HoraResumen
    };

    [HttpGet("clave")]
    public async Task<IActionResult> ClavePublica() => Ok(new { clavePublica = (await NotificacionesPush.VapidAsync(_context)).Publica });

    // Preferencias de ESTE celular (se identifica por su endpoint)
    [HttpPost("estado")]
    public async Task<IActionResult> Estado([FromBody] EndpointPushDto dto)
    {
        var s = await _context.SuscripcionesPush.FirstOrDefaultAsync(x => x.Endpoint == dto.Endpoint && x.BarberiaId == BarberiaId());
        return Ok(s == null ? new { suscrito = false } : Preferencias(s));
    }

    [HttpPost("suscribir")]
    public async Task<IActionResult> Suscribir([FromBody] SuscripcionPushDto dto)
    {
        if (!NotificacionesPush.EndpointValido(dto.Endpoint) || string.IsNullOrWhiteSpace(dto.P256dh) || string.IsNullOrWhiteSpace(dto.Auth)
            || dto.P256dh.Length > 200 || dto.Auth.Length > 100)
            return BadRequest(new { message = "Este navegador no entregó una suscripción válida. Prueba con Chrome en Android." });

        var barberiaId = BarberiaId();
        var s = await _context.SuscripcionesPush.FirstOrDefaultAsync(x => x.Endpoint == dto.Endpoint);
        if (s == null)
        {
            // Máximo 10 celulares por barbería
            if (await _context.SuscripcionesPush.CountAsync(x => x.BarberiaId == barberiaId) >= 10)
                return BadRequest(new { message = "Ya hay 10 celulares con notificaciones. Desactívalas en alguno que ya no uses." });
            s = new SuscripcionPush { Endpoint = dto.Endpoint };
            _context.SuscripcionesPush.Add(s);
        }
        s.BarberiaId = barberiaId; // si el celular cambió de cuenta, pasa a la nueva
        s.P256dh = dto.P256dh;
        s.Auth = dto.Auth;
        s.FallandoDesdeUtc = null; // el celular volvió a registrarse: se da por bueno
        var dispositivo = (dto.Dispositivo ?? "").Trim();
        s.Dispositivo = dispositivo.Length > 80 ? dispositivo[..80] : dispositivo;
        await _context.SaveChangesAsync();
        return Ok(Preferencias(s));
    }

    [HttpPut("preferencias")]
    public async Task<IActionResult> GuardarPreferencias([FromBody] PreferenciasPushDto dto)
    {
        var s = await _context.SuscripcionesPush.FirstOrDefaultAsync(x => x.Endpoint == dto.Endpoint && x.BarberiaId == BarberiaId());
        if (s == null) return NotFound(new { message = "Este celular no tiene las notificaciones activadas." });
        if (dto.HoraResumen != null && !HorasResumen.Contains(dto.HoraResumen))
            return BadRequest(new { message = "Elige una hora válida para el resumen." });

        // Si cambia la hora a una más tarde que la de ahora, el resumen de hoy todavía puede llegar
        if (dto.HoraResumen != null && dto.HoraResumen != s.HoraResumen) s.UltimoResumen = "";
        s.AvisarNuevas = dto.AvisarNuevas;
        s.AvisarCancelaciones = dto.AvisarCancelaciones;
        s.ResumenMatutino = dto.ResumenMatutino;
        s.HoraResumen = dto.HoraResumen ?? s.HoraResumen;
        await _context.SaveChangesAsync();
        return Ok(Preferencias(s));
    }

    [HttpPost("desuscribir")]
    public async Task<IActionResult> Desuscribir([FromBody] EndpointPushDto dto)
    {
        var s = await _context.SuscripcionesPush.FirstOrDefaultAsync(x => x.Endpoint == dto.Endpoint && x.BarberiaId == BarberiaId());
        if (s != null)
        {
            _context.SuscripcionesPush.Remove(s);
            await _context.SaveChangesAsync();
        }
        return Ok(new { suscrito = false });
    }

    [HttpPost("probar")]
    public async Task<IActionResult> Probar([FromBody] EndpointPushDto dto)
    {
        var barberiaId = BarberiaId();
        var s = await _context.SuscripcionesPush.FirstOrDefaultAsync(x => x.Endpoint == dto.Endpoint && x.BarberiaId == barberiaId);
        if (s == null) return NotFound(new { message = "Este celular no tiene las notificaciones activadas." });

        var (enviadas, _, _) = await NotificacionesPush.EnviarAsync(barberiaId, NotificacionesPush.Prueba,
            "🔔 ¡Funciona!", "Así te llegarán los avisos de citas nuevas, cancelaciones y el resumen de la mañana.",
            "prueba", new[] { s.Id });
        return enviadas > 0
            ? Ok(new { message = "Enviada. Debería llegarte en unos segundos." })
            : BadRequest(new { message = "No se pudo enviar. Desactiva y vuelve a activar las notificaciones." });
    }

    // Vista previa del resumen de la mañana de hoy (para mostrarla en el panel)
    [HttpGet("resumen-hoy")]
    public async Task<IActionResult> ResumenHoy()
    {
        var r = await ResumenMatutinoService.ArmarResumenAsync(_context, BarberiaId(), EstadosCitas.AhoraColombia());
        return Ok(r == null ? new { titulo = "", cuerpo = "Hoy no atiendes, así que no se envía resumen." } : new { titulo = r.Value.Titulo, cuerpo = r.Value.Cuerpo });
    }
}
