using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using BarberFlow.Api.Data;
using BarberFlow.Api.DTOs;
using BarberFlow.Api.Models;

namespace BarberFlow.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class AuthController : ControllerBase
{
    private readonly AppDbContext _context;
    private readonly IConfiguration _config;

    public AuthController(AppDbContext context, IConfiguration config)
    {
        _context = context;
        _config = config;
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
        barberia.Servicios.Add(new Servicio { Nombre = "Corte Clásico & Fade", Precio = 25000, DuracionMinutos = 40, Descripcion = "Degradado perfecto, lavado y peinado", Icono = "scissors" });
        barberia.Servicios.Add(new Servicio { Nombre = "Perfilado de Barba", Precio = 20000, DuracionMinutos = 30, Descripcion = "Toalla caliente, navaja tradicional y aceites", Icono = "smile" });
        barberia.Servicios.Add(new Servicio { Nombre = "Combo Corte + Barba", Precio = 40000, DuracionMinutos = 60, Descripcion = "Tratamiento completo", Icono = "crown" });

        // Miembro inicial
        barberia.Miembros.Add(new MiembroEquipo { 
            Nombre = dto.NombreCompleto.Trim(), 
            Rol = "Master Barber / Dueño",
            FotoUrl = "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=80&h=80&q=80"
        });

        _context.Barberos.Add(barbero);
        _context.Barberias.Add(barberia);
        await _context.SaveChangesAsync();

        var token = GenerarJwtToken(barbero, barberia);
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
        var token = GenerarJwtToken(barbero, barberia);
        return Ok(new AuthResponseDto(token, barbero.NombreCompleto, barbero.Email, barberia.Slug, barberia.Nombre));
    }

    private string GenerarJwtToken(BarberoUser user, Barberia barberia)
    {
        var secretKey = _config["Jwt:Key"] ?? "ClaveSecretaSuperSeguraParaBarberFlow2026!DebeTenerMasDe32Caracteres";
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secretKey));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new Claim(ClaimTypes.Email, user.Email),
            new Claim(ClaimTypes.Name, user.NombreCompleto),
            new Claim("BarberiaId", barberia.Id.ToString()),
            new Claim("BarberiaSlug", barberia.Slug)
        };

        var token = new JwtSecurityToken(
            claims: claims,
            expires: DateTime.UtcNow.AddDays(7),
            signingCredentials: creds
        );

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static string GenerarSlug(string phrase)
    {
        string str = phrase.ToLowerInvariant();
        str = Regex.Replace(str, @"[^a-z0-9\s-]", "");
        str = Regex.Replace(str, @"\s+", " ").Trim();
        str = str.Substring(0, str.Length <= 45 ? str.Length : 45).Trim();
        str = Regex.Replace(str, @"\s", "-");
        return string.IsNullOrWhiteSpace(str) ? "barberia" : str;
    }
}
