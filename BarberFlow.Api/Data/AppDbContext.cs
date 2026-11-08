using Microsoft.EntityFrameworkCore;
using BarberFlow.Api.Models;

namespace BarberFlow.Api.Data;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options)
    {
    }

    public DbSet<BarberoUser> Barberos => Set<BarberoUser>();
    public DbSet<Barberia> Barberias => Set<Barberia>();
    public DbSet<Servicio> Servicios => Set<Servicio>();
    public DbSet<MiembroEquipo> Miembros => Set<MiembroEquipo>();
    public DbSet<Cita> Citas => Set<Cita>();
    public DbSet<HorarioBloqueo> Bloqueos => Set<HorarioBloqueo>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<BarberoUser>()
            .HasIndex(u => u.Email)
            .IsUnique();

        modelBuilder.Entity<Barberia>()
            .HasIndex(b => b.Slug)
            .IsUnique();

        modelBuilder.Entity<Barberia>()
            .HasOne(b => b.BarberoUser)
            .WithOne(u => u.Barberia)
            .HasForeignKey<Barberia>(b => b.BarberoUserId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<Servicio>()
            .HasOne<Barberia>()
            .WithMany(b => b.Servicios)
            .HasForeignKey(s => s.BarberiaId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<MiembroEquipo>()
            .HasOne<Barberia>()
            .WithMany(b => b.Miembros)
            .HasForeignKey(m => m.BarberiaId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<Cita>()
            .HasOne<Barberia>()
            .WithMany(b => b.Citas)
            .HasForeignKey(c => c.BarberiaId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<HorarioBloqueo>()
            .HasOne<Barberia>()
            .WithMany(b => b.Bloqueos)
            .HasForeignKey(hb => hb.BarberiaId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
