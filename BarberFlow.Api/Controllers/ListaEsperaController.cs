using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using BarberFlow.Api.Data;
using BarberFlow.Api.Services;

namespace BarberFlow.Api.Controllers;

/// <summary>Lista de espera vista desde el panel del barbero.</summary>
[Authorize(Policy = PoliticasAuth.Barbero)]
[ApiController]
[Route("api/admin/lista-espera")]
public class ListaEsperaController : ControllerBase
{
    private readonly AppDbContext _context;
    public ListaEsperaController(AppDbContext context) => _context = context;

    private int BarberiaId() =>
        int.TryParse(User.FindFirst(PoliticasAuth.ClaimBarberiaId)?.Value, out var id) ? id : throw new UnauthorizedAccessException("Sesión inválida.");

    // Personas esperando turno de hoy en adelante (las que ya reservaron no se muestran)
    [HttpGet]
    public async Task<IActionResult> Listar()
    {
        var barberiaId = BarberiaId();
        var hoy = EstadosCitas.AhoraColombia().ToString("yyyy-MM-dd");
        var servicios = await _context.Servicios.Where(s => s.BarberiaId == barberiaId).ToDictionaryAsync(s => s.Id, s => s.Nombre);
        var miembros = await _context.Miembros.Where(m => m.BarberiaId == barberiaId).ToDictionaryAsync(m => m.Id, m => m.Nombre);
        var lista = (await _context.ListaEspera
                .Where(l => l.BarberiaId == barberiaId && string.Compare(l.Fecha, hoy) >= 0 && l.Estado != ListaEsperaAvisos.Reservo)
                .ToListAsync())
            .OrderBy(l => l.Fecha).ThenBy(l => l.CreadoUtc)
            .Select(l => new
            {
                l.Id,
                l.Fecha,
                l.NombreCliente,
                l.TelefonoCliente,
                l.Franja,
                FranjaTexto = ListaEsperaAvisos.TextoFranja(l.Franja),
                Servicio = servicios.GetValueOrDefault(l.ServicioId, "Servicio"),
                Barbero = l.MiembroEquipoId is int m ? miembros.GetValueOrDefault(m, "") : "",
                l.Estado,
                l.CreadoUtc
            });
        return Ok(lista);
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Quitar(int id)
    {
        var l = await _context.ListaEspera.FirstOrDefaultAsync(x => x.Id == id && x.BarberiaId == BarberiaId());
        if (l == null) return NotFound(new { message = "Ya no está en la lista." });
        _context.ListaEspera.Remove(l);
        await _context.SaveChangesAsync();
        return Ok(new { message = "Quitado de la lista de espera." });
    }
}
