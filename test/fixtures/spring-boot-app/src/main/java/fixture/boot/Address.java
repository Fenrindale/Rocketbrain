package fixture.boot;
import jakarta.persistence.*;
@Embeddable
public class Address {
    @Column(name="city", length=80) private String city;
    @Column(name="postal_code", length=20) private String postalCode;
    protected Address() {}
    public Address(String city, String postalCode) { this.city=city; this.postalCode=postalCode; }
    public String getCity() { return city; }
    public String getPostalCode() { return postalCode; }
}
