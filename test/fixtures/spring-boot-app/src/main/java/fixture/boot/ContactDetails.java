package fixture.boot;
import jakarta.persistence.*;
@Embeddable
public class ContactDetails {
    @Embedded private Address address;
    @Column(name="phone_number",length=30) private String phoneNumber;
    protected ContactDetails() {}
    public ContactDetails(Address address,String phoneNumber) { this.address=address;this.phoneNumber=phoneNumber; }
    public Address getAddress() { return address; }
    public String getPhoneNumber() { return phoneNumber; }
}
