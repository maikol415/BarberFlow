using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace BarberFlow.Api.Services;

/// <summary>
/// Códigos de 6 dígitos para recuperar la contraseña (barbero) o la clave (cliente) por WhatsApp.
/// El código se guarda cifrado (BCrypt), vence en 10 minutos, admite 5 intentos y se puede pedir
/// de nuevo cada 60 segundos. Además hay un límite por IP para que no se use para molestar a nadie.
/// </summary>
public static class RecuperacionClave
{
    public const int MinutosVigencia = 10;
    public const int MaxIntentos = 5;
    private static readonly TimeSpan EsperaReenvio = TimeSpan.FromSeconds(60);
    private static readonly ConcurrentDictionary<string, (DateTime Desde, int Cuenta)> _porIp = new();

    public static string NuevoCodigo() => RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");

    public static bool PuedeReenviar(DateTime? ultimoEnvioUtc) =>
        ultimoEnvioUtc == null || DateTime.UtcNow - ultimoEnvioUtc.Value >= EsperaReenvio;

    /// <summary>Máximo <paramref name="maximo"/> solicitudes por hora para esa clave (IP + acción).</summary>
    public static bool PermitirIp(string clave, int maximo)
    {
        var ahora = DateTime.UtcNow;
        if (_porIp.Count > 5000)
            foreach (var viejo in _porIp.Where(k => ahora - k.Value.Desde > TimeSpan.FromHours(1)).Select(k => k.Key).ToList())
                _porIp.TryRemove(viejo, out _);
        var uso = _porIp.AddOrUpdate(clave, (ahora, 1),
            (_, v) => ahora - v.Desde > TimeSpan.FromHours(1) ? (ahora, 1) : (v.Desde, v.Cuenta + 1));
        return uso.Cuenta <= maximo;
    }

    /// <summary>Resultado de comprobar un código: null si es válido, o el mensaje para el usuario.</summary>
    public static string? Verificar(string? codigoIngresado, string? hashGuardado, DateTime? venceUtc, int intentos)
    {
        if (string.IsNullOrEmpty(hashGuardado) || venceUtc == null)
            return "Primero pide un código.";
        if (DateTime.UtcNow > venceUtc.Value)
            return "El código ya venció. Pide uno nuevo.";
        if (intentos >= MaxIntentos)
            return "Ese código ya no sirve por demasiados intentos. Pide uno nuevo.";
        var limpio = new string((codigoIngresado ?? "").Where(char.IsDigit).ToArray());
        if (limpio.Length != 6 || !BCrypt.Net.BCrypt.Verify(limpio, hashGuardado))
            return "El código no es correcto. Revísalo e inténtalo de nuevo.";
        return null;
    }
}
