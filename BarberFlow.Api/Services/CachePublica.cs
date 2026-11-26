using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Filters;

namespace BarberFlow.Api.Services;

/// <summary>
/// Caché corto (30 s) de la parte de la página pública que casi no cambia: datos de la barbería, servicios,
/// barberos, reglas del bot y reseñas. Las citas y los descansos (qué horas están libres) se consultan siempre.
/// Cualquier cambio que el barbero guarde en el panel borra el caché de su barbería al instante.
/// </summary>
public static class CachePublica
{
    private static readonly TimeSpan Duracion = TimeSpan.FromSeconds(30);
    private static readonly ConcurrentDictionary<string, (DateTime Expira, int BarberiaId, JsonObject Datos)> Entradas = new();

    public static bool Obtener(string slug, out int barberiaId, out JsonObject datos)
    {
        if (Entradas.TryGetValue(slug, out var e) && e.Expira > DateTime.UtcNow)
        {
            barberiaId = e.BarberiaId;
            datos = (JsonObject)e.Datos.DeepClone(); // copia: cada respuesta agrega sus citas y descansos
            return true;
        }
        barberiaId = 0;
        datos = null!;
        return false;
    }

    public static void Guardar(string slug, int barberiaId, JsonObject datos)
    {
        if (Entradas.Count > 500) Entradas.Clear(); // nunca crece sin límite
        Entradas[slug] = (DateTime.UtcNow + Duracion, barberiaId, (JsonObject)datos.DeepClone());
    }

    public static void Invalidar(int barberiaId)
    {
        foreach (var par in Entradas.Where(p => p.Value.BarberiaId == barberiaId).ToList())
            Entradas.TryRemove(par.Key, out _);
    }
}

/// <summary>Después de cualquier cambio en el panel (POST/PUT/PATCH/DELETE), la página pública se actualiza al instante.</summary>
[AttributeUsage(AttributeTargets.Class)]
public class InvalidaCachePublicaAttribute : Attribute, IAsyncActionFilter
{
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        await next();
        if (HttpMethods.IsGet(context.HttpContext.Request.Method)) return;
        var claim = context.HttpContext.User.FindFirst(PoliticasAuth.ClaimBarberiaId)?.Value
                    ?? context.HttpContext.User.FindFirst("BarberiaId")?.Value;
        if (int.TryParse(claim, out var id)) CachePublica.Invalidar(id);
    }
}
