package fixture.boot;
import jakarta.persistence.*;
@Entity @Table(name="rb_v5_region")
public class Region {
    @EmbeddedId private RegionId id;
    @Column(name="region_name",length=80) private String name;
    protected Region() {}
    public Region(RegionId id,String name){this.id=id;this.name=name;}
    public RegionId getId(){return id;}
    public String getName(){return name;}
}
