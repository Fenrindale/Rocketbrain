package fixture.boot;
import java.io.Serializable;
import java.util.Objects;
public class LicenseId implements Serializable {
    public String tenant;
    public String code;
    public LicenseId() {}
    public LicenseId(String tenant,String code){this.tenant=tenant;this.code=code;}
    @Override public boolean equals(Object other){return other instanceof LicenseId key&&Objects.equals(tenant,key.tenant)&&Objects.equals(code,key.code);}
    @Override public int hashCode(){return Objects.hash(tenant,code);}
}
