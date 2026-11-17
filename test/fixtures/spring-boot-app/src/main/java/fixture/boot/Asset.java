package fixture.boot;
import jakarta.persistence.*;
@Entity
@Table(name="rb_spring_asset")
@Inheritance(strategy=InheritanceType.SINGLE_TABLE)
@DiscriminatorColumn(name="asset_type")
public abstract class Asset extends AuditBase {
    @Column(name="label") protected String label;
    public String getLabel() { return label; }
}
