using Microsoft.EntityFrameworkCore;
using BarberFlow.Api.Data;

namespace BarberFlow.Api.Services;

/// <summary>
/// Estados de una cita y sus cambios automáticos:
/// - "Pendiente": el bot le pidió al cliente confirmar y aún no responde (ocupa el horario).
/// - "Confirmada": confirmada por el cliente, o creada sin bot que pida confirmación.
/// - "No Confirmada": llegó la hora y el cliente nunca confirmó (libera el horario).
/// - "Completada": la cita confirmada ya terminó.
/// - "Cancelada": cancelada por el cliente o el barbero.
/// </summary>
public static class EstadosCitas
{
    public const string Pendiente = "Pendiente";
    public const string Confirmada = "Confirmada";
    public const string NoConfirmada = "No Confirmada";
    public const string Completada = "Completada";
    public const string Cancelada = "Cancelada";

    // Minutos después del final de la cita para darla por completada
    private const int MargenCompletarMinutos = 15;

    public static DateTime AhoraColombia() => DateTime.UtcNow.AddHours(-5);

    public static int HoraAMinutos(string? hora)
    {
        var t = (hora ?? "").ToLowerInvariant().Trim();
        var m = System.Text.RegularExpressions.Regex.Match(t, @"(\d{1,2}):(\d{2})");
        if (!m.Success) return 0;
        var h = int.Parse(m.Groups[1].Value);
        if (t.Contains("pm") && h < 12) h += 12;
        if (t.Contains("am") && h == 12) h = 0;
        return h * 60 + int.Parse(m.Groups[2].Value);
    }

    /// <summary>Momento de inicio de la cita en hora de Colombia, o null si la fecha no es válida.</summary>
    public static DateTime? InicioCita(string? fecha, string? hora)
    {
        if (!DateTime.TryParseExact(fecha, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out var dia)) return null;
        return dia.AddMinutes(HoraAMinutos(hora));
    }

    /// <summary>
    /// Aplica los cambios automáticos: confirmadas que ya terminaron → Completada;
    /// pendientes cuya hora ya llegó → No Confirmada. Devuelve cuántas citas cambiaron.
    /// </summary>
    public static async Task<int> AplicarAsync(AppDbContext db, int? barberiaId = null)
    {
        var ahora = AhoraColombia();
        var hoy = ahora.ToString("yyyy-MM-dd");

        var query = db.Citas.Include(c => c.Servicio)
            .Where(c => (c.Estado == Pendiente || c.Estado == Confirmada) && string.Compare(c.Fecha, hoy) <= 0);
        if (barberiaId.HasValue) query = query.Where(c => c.BarberiaId == barberiaId.Value);

        var candidatas = (await query.ToListAsync())
            .Where(c => string.CompareOrdinal(c.Fecha, hoy) <= 0)
            .ToList();

        var cambios = 0;
        foreach (var cita in candidatas)
        {
            var inicio = InicioCita(cita.Fecha, cita.Hora);
            if (inicio == null) continue;
            var duracion = cita.Servicio?.DuracionMinutos ?? 40;

            if (cita.Estado == Pendiente && ahora >= inicio.Value)
            {
                cita.Estado = NoConfirmada;
                cambios++;
            }
            else if (cita.Estado == Confirmada && ahora >= inicio.Value.AddMinutes(duracion + MargenCompletarMinutos))
            {
                cita.Estado = Completada;
                cambios++;
            }
        }

        if (cambios > 0) await db.SaveChangesAsync();
        return cambios;
    }
}

/// <summary>Revisa los estados de todas las citas cada 5 minutos mientras la API está encendida.</summary>
public class AutomatizacionCitasService : BackgroundService
{
    private readonly IServiceScopeFactory _scopes;
    public AutomatizacionCitasService(IServiceScopeFactory scopes) => _scopes = scopes;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = _scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var cambios = await EstadosCitas.AplicarAsync(db);
                if (cambios > 0) Console.WriteLine($"[Automatización] {cambios} cita(s) actualizadas automáticamente.");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Automatización] Error: {ex.Message}");
            }
            await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken);
        }
    }
}
