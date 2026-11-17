package fixture.boot;
import jakarta.persistence.*;
@Entity(name="Person")
@Table(name="rb_spring_person")
public class Person extends AuditBase {
    @Column(name="display_name", nullable=false, length=100) private String displayName;
    @Embedded private Address address;
    @ManyToOne(fetch=FetchType.LAZY, optional=false)
    @JoinColumn(name="department_id", nullable=false) private Department department;
    @Transient private String runtimeOnly;
    protected Person() {}
    public Person(String displayName, Address address, Department department) { this.displayName=displayName; this.address=address; this.department=department; }
    public String getDisplayName() { return displayName; }
    public Address getAddress() { return address; }
    public Department getDepartment() { return department; }
}
