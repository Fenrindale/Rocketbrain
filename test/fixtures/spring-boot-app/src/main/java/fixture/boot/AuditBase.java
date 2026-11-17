package fixture.boot;
import jakarta.persistence.*;
import java.time.LocalDateTime;
@MappedSuperclass
public abstract class AuditBase {
    @Id @GeneratedValue(strategy=GenerationType.IDENTITY)
    @Column(name="id") protected Long id;
    @Version @Column(name="version") protected long version;
    @Column(name="created_at", nullable=false) protected LocalDateTime createdAt = LocalDateTime.of(2026,11,12,0,0);
    public Long getId() { return id; }
    public long getVersion() { return version; }
}
