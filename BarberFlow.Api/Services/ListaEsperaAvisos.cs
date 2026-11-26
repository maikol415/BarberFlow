using BarberFlow.Api.Controllers;
using BarberFlow.Api.Data;
using BarberFlow.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace BarberFlow.Api.Services;

/// <summary>
/// Lista de espera: cuando se libera un turno (cancelación, cambio de hora o el barbero quita un descanso),
/// se avisa por WhatsApp a las primeras personas anotadas para ese día y franja. La primera que reserva se lo queda.
/// </summary>
public static class ListaEsperaAvisos
{
    public const string Esperando = "Esperando";
    public const string Avisado = "Avisado";
    public const string Reservo = "Reservó";

    public static readonly string[] Franjas = { "todo", "manana", "tarde", "noche" };

    // A cuántas personas se les avisa por cada turno que se libera
    private const int AvisosPorTurno = 3;

    public static bool FranjaIncluye(string? franja, int? minutos) => minutos == null || franja switch
    {
        "manana" => minutos < 720,
        "tarde" => minutos >= 720 && minutos < 1080,
        "noche" => minutos >= 1080,
        _ => true
    };

    public static string TextoFranja(string? franja) => franja switch
    {
        "manana" => "en la mañana",
        "tarde" => "en la tarde",
        "noche" => "en la noche",
        _ => "a cualquier hora"
    };

    /// <summary>Se liberó un turno: avisar en segundo plano. hora = null si se liberó el día entero.</summary>
    public static void TurnoLiberado(int barberiaId, string fecha, string? hora, int? miembroEquipoId)
    {
        if (NotificacionesPush.Scopes == null) return;
        _ = Task.Run(async () =>
        {
            try { await AvisarAsync(barberiaId, fecha, hora, miembroEquipoId); }
            catch (Exception ex) { Console.WriteLine($"[Lista de espera] Error avisando: {ex.Message}"); }
        });
    }

    public static async Task<int> AvisarAsync(int barberiaId, string fecha, string? hora, int? miembroEquipoId)
    {
        using var scope = NotificacionesPush.Scopes!.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var barberia = await db.Barberias.FindAsync(barberiaId);
        if (barberia == null) return 0;

        // Turnos que ya pasaron (o están por empezar) no sirven
        var ahora = EstadosCitas.AhoraColombia();
        var hoy = ahora.ToString("yyyy-MM-dd");
        if (string.CompareOrdinal(fecha, hoy) < 0) return 0;
        int? minutos = string.IsNullOrWhiteSpace(hora) ? null : EstadosCitas.HoraAMinutos(hora);
        if (fecha == hoy && minutos != null && minutos <= ahora.Hour * 60 + ahora.Minute + 15) return 0;

        var anotados = (await db.ListaEspera
                .Where(l => l.BarberiaId == barberiaId && l.Fecha == fecha && l.Estado == Esperando)
                .OrderBy(l => l.CreadoUtc)
                .ToListAsync())
            .Where(l => FranjaIncluye(l.Franja, minutos))
            .Where(l => l.MiembroEquipoId == null || miembroEquipoId == null || l.MiembroEquipoId == miembroEquipoId)
            .Take(AvisosPorTurno)
            .ToList();
        if (anotados.Count == 0) return 0;

        var servicios = await db.Servicios.Where(s => s.BarberiaId == barberiaId).ToDictionaryAsync(s => s.Id, s => s.Nombre);
        var conBot = PublicController.BotAtiende(barberia);
        foreach (var l in anotados)
        {
            if (conBot)
            {
                PublicController.NotificarBot("/api/notificar-lista-espera", barberia, new
                {
                    barberiaSlug = barberia.Slug,
                    barberiaNombre = barberia.Nombre,
                    nombreCliente = l.NombreCliente,
                    telefonoCliente = l.TelefonoCliente,
                    servicioId = l.ServicioId,
                    servicio = servicios.GetValueOrDefault(l.ServicioId, ""),
                    fecha,
                    hora
                });
                l.Estado = Avisado;
                l.AvisadoUtc = DateTime.UtcNow;
            }
        }
        await db.SaveChangesAsync();

        // Al barbero: quién está esperando ese turno
        var nombres = string.Join(", ", anotados.Select(l => l.NombreCliente.Split(' ')[0]));
        var cuando = $"{NotificacionesPush.TextoFecha(fecha)}{(hora != null ? ", " + NotificacionesPush.TextoHora(hora) : "")}";
        NotificacionesPush.Avisar(barberiaId, NotificacionesPush.Cancelacion,
            $"🔔 Turno libre: {cuando}",
            conBot
                ? $"Le avisamos por WhatsApp a {nombres} (lista de espera). El primero que reserve se lo queda."
                : $"{nombres} {(anotados.Count == 1 ? "está" : "están")} en lista de espera para ese día. Escríbele desde tu agenda.",
            $"espera-{fecha}-{hora}");
        return anotados.Count;
    }
}
