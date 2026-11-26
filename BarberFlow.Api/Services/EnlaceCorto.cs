using System.Text.RegularExpressions;

namespace BarberFlow.Api.Services;

/// <summary>
/// Enlace corto de cada barbería: /barberia-jr en vez de /index.html?b=barberia-jr.
/// Una ruta de un solo tramo, sin punto, que no sea de la página ni de la API, muestra la página de reservas.
/// </summary>
public static class EnlaceCorto
{
    private static readonly HashSet<string> Reservados = new(StringComparer.OrdinalIgnoreCase)
    {
        "api", "admin", "cuenta", "login", "privacidad", "index", "uploads", "css", "js", "icons", "img",
        "ping", "sw", "manifest", "favicon", "robots", "sitemap", "registro", "panel", "app", "www", "static"
    };

    private static readonly Regex Formato = new("^[a-z0-9][a-z0-9-]{0,59}$", RegexOptions.Compiled);

    public static bool EsReservado(string slug) => Reservados.Contains(slug);

    /// <summary>¿Esta ruta es el enlace corto de una barbería? (p. ej. "/barberia-jr" o "/barberia-jr/")</summary>
    public static bool EsEnlaceDeBarberia(PathString ruta)
    {
        var valor = ruta.Value?.Trim('/') ?? "";
        if (valor.Length == 0 || valor.Contains('/')) return false;
        var slug = valor.ToLowerInvariant();
        return Formato.IsMatch(slug) && !EsReservado(slug);
    }
}
