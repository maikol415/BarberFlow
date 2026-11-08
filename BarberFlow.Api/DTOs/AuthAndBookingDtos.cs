using System.ComponentModel.DataAnnotations;

namespace BarberFlow.Api.DTOs;

public record RegisterDto(
    [Required] string NombreCompleto,
    [Required][EmailAddress] string Email,
    [Required][MinLength(6)] string Password,
    [Required] string NombreBarberia,
    [Required] string TelefonoWhatsApp
);

public record LoginDto(
    [Required][EmailAddress] string Email,
    [Required] string Password
);

public record AuthResponseDto(
    string Token,
    string NombreBarbero,
    string Email,
    string BarberiaSlug,
    string NombreBarberia
);

public record UpdateBarberiaDto(
    string Nombre,
    string Descripcion,
    string Direccion,
    string TelefonoWhatsApp,
    string HorarioTexto,
    string LogoUrl,
    string HoraApertura,
    string HoraCierre,
    int IntervaloMinutos,
    string DiasLaborales,
    bool MostrarSelectorBarbero
);

public record ServicioDto(
    int Id,
    string Categoria,
    string Nombre,
    decimal Precio,
    int DuracionMinutos,
    string Descripcion,
    string Icono,
    bool Activo
);

public record MiembroDto(
    int Id,
    string Nombre,
    string Rol,
    string FotoUrl,
    bool Activo
);

public record CrearCitaPublicaDto(
    [Required] string BarberiaSlug,
    [Required] int ServicioId,
    int? MiembroEquipoId,
    [Required] string NombreCliente,
    [Required] string TelefonoCliente,
    [Required] string Fecha,
    [Required] string Hora
);

public record CambiarEstadoCitaDto(
    string Estado
);

public record BloqueoDto(
    int Id,
    [Required] string Fecha,
    string? Hora,
    string? Motivo
);

public record UploadImageDto(
    [Required] string ImageData
);
