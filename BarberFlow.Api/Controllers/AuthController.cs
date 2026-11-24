using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using BarberFlow.Api.Data;
using BarberFlow.Api.DTOs;
using BarberFlow.Api.Models;
using BarberFlow.Api.Services;

namespace BarberFlow.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class AuthController : ControllerBase
{
    private readonly AppDbContext _context;
    private readonly TokenService _tokens;

    public AuthController(AppDbContext context, TokenService tokens)
    {
        _context = context;
        _tokens = tokens;
    }

    private static bool EsEmailValido(string email)
    {
        // Validar formato completo de email, incluyendo dominio ej: @gmail.com, @hotmail.com, @outlook.com
        var regex = new Regex(@"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$");
        if (!regex.IsMatch(email)) return false;

        // Comprobación común: si escribieron "@mail.com" en vez de "@gmail.com"
        var dominio = email.Split('@').Last().ToLower();
        if (dominio == "mail.com" || dominio == "gmal.com" || dominio == "gmai.com")
        {
            return false;
        }

        return true;
    }

    [HttpPost("register")]
    public async Task<IActionResult> Register([FromBody] RegisterDto dto)
    {
        var emailLower = dto.Email.Trim().ToLowerInvariant();

        if (!EsEmailValido(emailLower))
        {
            return BadRequest(new { message = "El correo electrónico no es válido. Asegúrate de escribirlo correctamente (por ejemplo: tu_nombre@gmail.com)." });
        }

        if (await _context.Barberos.AnyAsync(u => u.Email == emailLower))
        {
            return BadRequest(new { message = "Este correo electrónico ya está registrado." });
        }

        var slugBase = GenerarSlug(dto.NombreBarberia);
        var slug = slugBase;
        int count = 1;
        while (await _context.Barberias.AnyAsync(b => b.Slug == slug))
        {
            slug = $"{slugBase}-{count++}";
        }

        var passwordHash = BCrypt.Net.BCrypt.HashPassword(dto.Password);

        var barbero = new BarberoUser
        {
            NombreCompleto = dto.NombreCompleto.Trim(),
            Email = emailLower,
            PasswordHash = passwordHash
        };

        var barberia = new Barberia
        {
            Nombre = dto.NombreBarberia.Trim(),
            Slug = slug,
            TelefonoWhatsApp = dto.TelefonoWhatsApp.Trim(),
            BarberoUser = barbero
        };

        // Servicios iniciales
        barberia.Servicios.Add(new Servicio { Categoria = "Cortes", Nombre = "Corte Clásico & Fade", Precio = 25000, DuracionMinutos = 40, Descripcion = "Degradado perfecto, lavado y peinado", Icono = "scissors" });
        barberia.Servicios.Add(new Servicio { Categoria = "Barba", Nombre = "Perfilado de Barba", Precio = 20000, DuracionMinutos = 30, Descripcion = "Toalla caliente, navaja tradicional y aceites", Icono = "smile" });
        barberia.Servicios.Add(new Servicio { Categoria = "Combos", Nombre = "Combo Corte + Barba", Precio = 40000, DuracionMinutos = 60, Descripcion = "Tratamiento completo", Icono = "crown" });

        // Miembro inicial
        barberia.Miembros.Add(new MiembroEquipo {
            Nombre = dto.NombreCompleto.Trim(),
            Rol = "Master Barber / Dueño",
            FotoUrl = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2364748B'><circle cx='12' cy='8' r='4'/><path d='M4 20c0-4 4-6 8-6s8 2 8 6'/></svg>"
        });

        _context.Barberos.Add(barbero);
        _context.Barberias.Add(barberia);
        await _context.SaveChangesAsync();

        var token = _tokens.GenerarTokenBarbero(barbero, barberia);
        return Ok(new AuthResponseDto(token, barbero.NombreCompleto, barbero.Email, barberia.Slug, barberia.Nombre));
    }

    [HttpPost("login")]
    public async Task<IActionResult> Login([FromBody] LoginDto dto)
    {
        var emailLower = dto.Email.Trim().ToLowerInvariant();
        var barbero = await _context.Barberos
            .Include(u => u.Barberia)
            .FirstOrDefaultAsync(u => u.Email == emailLower);

        if (barbero == null || !BCrypt.Net.BCrypt.Verify(dto.Password, barbero.PasswordHash))
        {
            return Unauthorized(new { message = "Correo electrónico o contraseña incorrectos." });
        }

        var barberia = barbero.Barberia!;
        var token = _tokens.GenerarTokenBarbero(barbero, barberia);
        return Ok(new AuthResponseDto(token, barbero.NombreCompleto, barbero.Email, barberia.Slug, barberia.Nombre));
    }

    // ----- Cambiar y recuperar la contraseña del barbero -----
    public record SolicitarRecuperacionDto(string? Email);
    public record ConfirmarRecuperacionDto(string? Email, string? Codigo, string? NuevaClave);
    public record CambiarClaveDto(string? ClaveActual, string? NuevaClave);

    private string IpCliente() =>
        Request.Headers["X-Forwarded-For"].ToString().Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault()
        ?? HttpContext.Connection.RemoteIpAddress?.ToString() ?? "?";

    // Paso 1: se envía un código al WhatsApp de la barbería. La respuesta es la misma exista o no el correo
    // (así nadie puede averiguar qué correos están registrados).
    [HttpPost("recuperar/solicitar")]
    public async Task<IActionResult> SolicitarRecuperacion([FromBody] SolicitarRecuperacionDto dto)
    {
        const string respuesta = "Si el correo está registrado, te enviamos un código de 6 dígitos al WhatsApp de tu barbería. Vence en 10 minutos.";
        if (!RecuperacionClave.PermitirIp($"{IpCliente()}|recuperar-barbero", 10))
            return StatusCode(429, new { message = "Demasiados intentos. Espera un rato e inténtalo de nuevo." });

        var email = (dto.Email ?? "").Trim().ToLowerInvariant();
        var barbero = await _context.Barberos.Include(u => u.Barberia).FirstOrDefaultAsync(u => u.Email == email);
        if (barbero?.Barberia == null || string.IsNullOrWhiteSpace(barbero.Barberia.TelefonoWhatsApp)
            || !RecuperacionClave.PuedeReenviar(barbero.CodigoRecuperacionEnviado))
            return Ok(new { message = respuesta });

        var codigo = RecuperacionClave.NuevoCodigo();
        barbero.CodigoRecuperacionHash = BCrypt.Net.BCrypt.HashPassword(codigo);
        barbero.CodigoRecuperacionVence = DateTime.UtcNow.AddMinutes(RecuperacionClave.MinutosVigencia);
        barbero.CodigoRecuperacionIntentos = 0;
        barbero.CodigoRecuperacionEnviado = DateTime.UtcNow;
        await _context.SaveChangesAsync();

        PublicController.NotificarBot("/api/enviar-codigo", barbero.Barberia, new
        {
            barberiaSlug = barbero.Barberia.Slug,
            barberiaNombre = barbero.Barberia.Nombre,
            telefono = barbero.Barberia.TelefonoWhatsApp,
            nombre = barbero.NombreCompleto,
            codigo,
            para = "barbero"
        });
        return Ok(new { message = respuesta });
    }

    // Paso 2: código + contraseña nueva. Si todo está bien, queda con la sesión abierta.
    [HttpPost("recuperar/confirmar")]
    public async Task<IActionResult> ConfirmarRecuperacion([FromBody] ConfirmarRecuperacionDto dto)
    {
        if (!RecuperacionClave.PermitirIp($"{IpCliente()}|confirmar-barbero", 30))
            return StatusCode(429, new { message = "Demasiados intentos. Espera un rato e inténtalo de nuevo." });
        if ((dto.NuevaClave ?? "").Length < 6)
            return BadRequest(new { message = "La contraseña nueva debe tener al menos 6 caracteres." });

        var email = (dto.Email ?? "").Trim().ToLowerInvariant();
        var barbero = await _context.Barberos.Include(u => u.Barberia).FirstOrDefaultAsync(u => u.Email == email);
        if (barbero?.Barberia == null) return BadRequest(new { message = "El código no es correcto. Revísalo e inténtalo de nuevo." });

        var error = RecuperacionClave.Verificar(dto.Codigo, barbero.CodigoRecuperacionHash, barbero.CodigoRecuperacionVence, barbero.CodigoRecuperacionIntentos);
        if (error != null)
        {
            if (barbero.CodigoRecuperacionHash != null) { barbero.CodigoRecuperacionIntentos++; await _context.SaveChangesAsync(); }
            return BadRequest(new { message = error });
        }

        barbero.PasswordHash = BCrypt.Net.BCrypt.HashPassword(dto.NuevaClave);
        barbero.CodigoRecuperacionHash = null;
        barbero.CodigoRecuperacionVence = null;
        barbero.CodigoRecuperacionIntentos = 0;
        await _context.SaveChangesAsync();

        var token = _tokens.GenerarTokenBarbero(barbero, barbero.Barberia);
        return Ok(new AuthResponseDto(token, barbero.NombreCompleto, barbero.Email, barbero.Barberia.Slug, barbero.Barberia.Nombre));
    }

    // Con la sesión abierta: contraseña actual + nueva
    [Authorize(Policy = PoliticasAuth.Barbero)]
    [HttpPost("cambiar-clave")]
    public async Task<IActionResult> CambiarClave([FromBody] CambiarClaveDto dto)
    {
        if (!int.TryParse(User.FindFirst(ClaimTypes.NameIdentifier)?.Value, out var id)) return Unauthorized();
        var barbero = await _context.Barberos.FindAsync(id);
        if (barbero == null) return Unauthorized();
        if (!BCrypt.Net.BCrypt.Verify(dto.ClaveActual ?? "", barbero.PasswordHash))
            return BadRequest(new { message = "La contraseña actual no es correcta." });
        if ((dto.NuevaClave ?? "").Length < 6)
            return BadRequest(new { message = "La contraseña nueva debe tener al menos 6 caracteres." });
        if (dto.NuevaClave == dto.ClaveActual)
            return BadRequest(new { message = "La contraseña nueva debe ser diferente a la actual." });

        barbero.PasswordHash = BCrypt.Net.BCrypt.HashPassword(dto.NuevaClave);
        await _context.SaveChangesAsync();
        return Ok(new { message = "Contraseña actualizada." });
    }

    private static string GenerarSlug(string phrase)
    {
        string str = new string(phrase.ToLowerInvariant()
            .Normalize(System.Text.NormalizationForm.FormD)
            .Where(c => System.Globalization.CharUnicodeInfo.GetUnicodeCategory(c) != System.Globalization.UnicodeCategory.NonSpacingMark)
            .ToArray());
        str = Regex.Replace(str, @"[^a-z0-9\s-]", "");
        str = Regex.Replace(str, @"\s+", " ").Trim();
        str = str.Substring(0, str.Length <= 45 ? str.Length : 45).Trim();
        str = Regex.Replace(str, @"\s", "-");
        return string.IsNullOrWhiteSpace(str) ? "barberia" : str;
    }
}
