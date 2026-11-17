package fixture.boot;
import jakarta.persistence.*;
@Entity @Table(name="rb_v5_warehouse")
public class Warehouse extends AuditBase {
    @Column(name="label",length=80) private String label;
    @ManyToOne(fetch=FetchType.LAZY)
    @JoinColumns({
        @JoinColumn(name="region_country",referencedColumnName="country_code"),
        @JoinColumn(name="region_code",referencedColumnName="region_code")
    })
    private Region region;
    protected Warehouse() {}
    public Warehouse(String label,Region region){this.label=label;this.region=region;}
    public String getLabel(){return label;}
    public Region getRegion(){return region;}
}
