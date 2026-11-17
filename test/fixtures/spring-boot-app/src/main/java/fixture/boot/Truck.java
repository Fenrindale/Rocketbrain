package fixture.boot;
import jakarta.persistence.*;
@Entity @Table(name="rb_v5_truck") @PrimaryKeyJoinColumn(name="vehicle_id")
public class Truck extends Vehicle {
    @Column(name="payload_kg") private int payloadKg;
    protected Truck() {}
    public Truck(String name,int payloadKg){this.name=name;this.payloadKg=payloadKg;}
    public int getPayloadKg(){return payloadKg;}
}
