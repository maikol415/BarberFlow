using System.Text.RegularExpressions;
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
