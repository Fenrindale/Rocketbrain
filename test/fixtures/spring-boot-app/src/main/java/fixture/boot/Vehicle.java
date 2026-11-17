package fixture.boot;
import jakarta.persistence.*;
@Entity @Table(name="rb_v5_vehicle") @Inheritance(strategy=InheritanceType.JOINED)
public abstract class Vehicle extends AuditBase {
    @Column(name="vehicle_name",length=80) protected String name;
    public String getName(){return name;}
}
