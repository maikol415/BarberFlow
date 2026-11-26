using System.Security.Cryptography;
using System.Text;

namespace BarberFlow.Api.Services;

/// <summary>
/// IP real del visitante (para los límites de intentos).
/// - Directo a Render: es el ÚLTIMO valor de X-Forwarded-For (los anteriores los puede inventar quien hace la petición).
/// - Entrando por el dominio corto de Cloudflare (barberflow.pages.dev): Render ve la IP de Cloudflare, así que
///   el intermediario manda la IP real en X-BF-Ip junto con una clave compartida (PROXY_CLAVE). Solo si la clave
///   coincide se cree en esa IP; si no, cualquiera podría inventarla para saltarse los límites.
/// </summary>
public static class IpVisitante
{
    private static readonly byte[]? ClaveProxy = LeerClave();

    private static byte[]? LeerClave()
    {
        var clave = Environment.GetEnvironmentVariable("PROXY_CLAVE");
        return string.IsNullOrWhiteSpace(clave) || clave.Trim().Length < 16 ? null : Encoding.UTF8.GetBytes(clave.Trim());
    }

    public static string De(HttpContext contexto)
    {
        var headers = contexto.Request.Headers;
        if (ClaveProxy != null)
        {
            var enviada = Encoding.UTF8.GetBytes(headers["X-BF-Proxy"].ToString());
            var ipProxy = headers["X-BF-Ip"].ToString().Trim();
            if (ipProxy.Length is > 0 and <= 64 && CryptographicOperations.FixedTimeEquals(enviada, ClaveProxy))
                return ipProxy;
        }
        return headers["X-Forwarded-For"].ToString()
                   .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault()
               ?? contexto.Connection.RemoteIpAddress?.ToString() ?? "?";
    }
}
