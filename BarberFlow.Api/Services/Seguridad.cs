using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.IdentityModel.Tokens;
using BarberFlow.Api.Models;

namespace BarberFlow.Api.Services;

public static class PoliticasAuth
{
    // Los tokens de barbero llevan "BarberiaId"; los de cliente llevan "ClienteId".
    // Así un token de cliente nunca puede entrar al panel de administración.
    public const string Barbero = "Barbero";
    public const string Cliente = "Cliente";
    public const string ClaimBarberiaId = "BarberiaId";
    public const string ClaimClienteId = "ClienteId";
    public const string ClaimClienteBarberiaId = "ClienteBarberiaId";
}

public class TokenService
{
    private readonly SymmetricSecurityKey _key;

    public TokenService(string jwtKey)
    {
        _key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey));
    }

    public SymmetricSecurityKey Key => _key;

    public string GenerarTokenBarbero(BarberoUser user, Barberia barberia)
    {
        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new Claim(ClaimTypes.Email, user.Email),
            new Claim(ClaimTypes.Name, user.NombreCompleto),
            new Claim(PoliticasAuth.ClaimBarberiaId, barberia.Id.ToString()),
            new Claim("BarberiaSlug", barberia.Slug)
        };
        return Firmar(claims, TimeSpan.FromDays(7));
    }

    public string GenerarTokenCliente(ClienteUsuario cliente)
    {
        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, cliente.Id.ToString()),
            new Claim(PoliticasAuth.ClaimClienteId, cliente.Id.ToString()),
            new Claim(PoliticasAuth.ClaimClienteBarberiaId, cliente.BarberiaId.ToString())
        };
        return Firmar(claims, TimeSpan.FromDays(30));
    }

    private string Firmar(IEnumerable<Claim> claims, TimeSpan duracion)
    {
        var token = new JwtSecurityToken(
            claims: claims,
            expires: DateTime.UtcNow.Add(duracion),
            signingCredentials: new SigningCredentials(_key, SecurityAlgorithms.HmacSha256)
        );
        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}

/// <summary>
/// Exige el encabezado X-Bot-Key igual a la variable de entorno BOT_API_KEY.
/// Si BOT_API_KEY no está configurada, el endpoint queda cerrado (503).
/// </summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public class RequiereBotKeyAttribute : Attribute, IAuthorizationFilter
{
    public const string Header = "X-Bot-Key";

    public void OnAuthorization(AuthorizationFilterContext context)
    {
        var esperada = Environment.GetEnvironmentVariable("BOT_API_KEY");
        if (string.IsNullOrWhiteSpace(esperada))
        {
            context.Result = new ObjectResult(new { message = "BOT_API_KEY no está configurada en el servidor." }) { StatusCode = 503 };
            return;
        }

        var recibida = context.HttpContext.Request.Headers[Header].ToString();
        var a = Encoding.UTF8.GetBytes(recibida);
        var b = Encoding.UTF8.GetBytes(esperada);
        if (a.Length != b.Length || !CryptographicOperations.FixedTimeEquals(a, b))
        {
            context.Result = new UnauthorizedObjectResult(new { message = "Clave del bot inválida." });
        }
    }
}

public static class TelefonoHelper
{
    public static string SoloDigitos(string? tel) =>
        new string((tel ?? string.Empty).Where(char.IsDigit).ToArray());

    /// <summary>
    /// Compara dos teléfonos. Si ambos traen indicativo de país (más de 10 dígitos) deben ser idénticos,
    /// para no confundir p. ej. +1 305… con +57 305…. Si alguno viene sin indicativo, se comparan los últimos 10 dígitos.
    /// </summary>
    public static bool MismoTelefono(string? a, string? b)
    {
        var da = SoloDigitos(a);
        var db = SoloDigitos(b);
        if (da.Length < 7 || db.Length < 7) return false;
        if (da == db) return true;
        if (da.Length > 10 && db.Length > 10) return false;
        if (da.Length < 10 || db.Length < 10) return false;
        return da[^10..] == db[^10..];
    }
}
