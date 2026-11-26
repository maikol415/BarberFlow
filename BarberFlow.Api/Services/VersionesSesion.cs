using System.Collections.Concurrent;
using System.Security.Claims;
using BarberFlow.Api.Data;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;

namespace BarberFlow.Api.Services;

/// <summary>
/// "Versión de sesión" de cada barbero y cliente. Cada token lleva su versión (claim "sv").
/// Al cambiar o recuperar la contraseña la versión sube, y los tokens anteriores dejan de servir:
/// si alguien tenía la sesión abierta en otro celular, queda cerrada. Una cuenta borrada tampoco entra.
/// </summary>
public static class VersionesSesion
{
    public const string Claim = "sv";
    private static readonly TimeSpan Duracion = TimeSpan.FromMinutes(10);
    private static readonly ConcurrentDictionary<string, (int Version, DateTime Expira)> Cache = new();

    public static void Fijar(string tipo, int id, int version) =>
        Cache[$"{tipo}:{id}"] = (version, DateTime.UtcNow + Duracion);

    public static void Olvidar(string tipo, int id) => Cache.TryRemove($"{tipo}:{id}", out _);

    /// <summary>Versión vigente; -1 si la cuenta ya no existe.</summary>
    private static async Task<int> ObtenerAsync(string tipo, int id, AppDbContext db)
    {
        if (Cache.TryGetValue($"{tipo}:{id}", out var e) && e.Expira > DateTime.UtcNow) return e.Version;
        int? version = tipo == "b"
            ? await db.Barberos.Where(u => u.Id == id).Select(u => (int?)u.SesionVersion).FirstOrDefaultAsync()
            : await db.Clientes.Where(c => c.Id == id).Select(c => (int?)c.SesionVersion).FirstOrDefaultAsync();
        var v = version ?? -1;
        if (Cache.Count > 20000) Cache.Clear();
        Fijar(tipo, id, v);
        return v;
    }

    /// <summary>Se ejecuta en cada petición con token: rechaza las sesiones de una versión anterior.</summary>
    public static async Task ValidarAsync(TokenValidatedContext ctx)
    {
        var p = ctx.Principal;
        if (p == null) return;
        var tipo = p.HasClaim(c => c.Type == PoliticasAuth.ClaimClienteId) ? "c"
                 : p.HasClaim(c => c.Type == PoliticasAuth.ClaimBarberiaId) ? "b" : null;
        if (tipo == null || !int.TryParse(p.FindFirst(ClaimTypes.NameIdentifier)?.Value, out var id)) return;
        var enToken = int.TryParse(p.FindFirst(Claim)?.Value, out var v) ? v : 0; // tokens viejos (sin "sv") = versión 0
        var db = ctx.HttpContext.RequestServices.GetRequiredService<AppDbContext>();
        if (await ObtenerAsync(tipo, id, db) != enToken) ctx.Fail("La sesión se cerró porque la contraseña cambió.");
    }
}
