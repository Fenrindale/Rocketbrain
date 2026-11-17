package fixture.boot;
import jakarta.persistence.*;
@Entity @Table(name="rb_v5_license") @IdClass(LicenseId.class)
public class License {
    @Id @Column(name="tenant_key",length=20) private String tenant;
    @Id @Column(name="license_code",length=20) private String code;
    @Column(name="license_label",length=80) private String label;
    protected License() {}
    public License(String tenant,String code,String label){this.tenant=tenant;this.code=code;this.label=label;}
    public String getTenant(){return tenant;}
    public String getCode(){return code;}
    public String getLabel(){return label;}
}
