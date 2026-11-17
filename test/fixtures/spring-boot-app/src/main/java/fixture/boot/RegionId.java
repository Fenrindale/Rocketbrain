package fixture.boot;
import jakarta.persistence.*;
import java.io.Serializable;
import java.util.Objects;
@Embeddable
public class RegionId implements Serializable {
    @Column(name="country_code",length=2) private String countryCode;
    @Column(name="region_code",length=8) private String regionCode;
    protected RegionId() {}
    public RegionId(String countryCode,String regionCode){this.countryCode=countryCode;this.regionCode=regionCode;}
    public String getCountryCode(){return countryCode;}
    public String getRegionCode(){return regionCode;}
    @Override public boolean equals(Object other){return other instanceof RegionId key&&Objects.equals(countryCode,key.countryCode)&&Objects.equals(regionCode,key.regionCode);}
    @Override public int hashCode(){return Objects.hash(countryCode,regionCode);}
}
