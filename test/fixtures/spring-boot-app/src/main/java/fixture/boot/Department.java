package fixture.boot;
import jakarta.persistence.*;
import java.util.List;
import java.util.ArrayList;
@Entity(name="Department")
@Table(name="rb_spring_department")
public class Department extends AuditBase {
    @Column(name="name", nullable=false, length=80) private String name;
    @OneToMany(mappedBy="department", fetch=FetchType.LAZY) private List<Person> people = new ArrayList<>();
    protected Department() {}
    public Department(String name) { this.name=name; }
    public String getName() { return name; }
    public List<Person> getPeople() { return people; }
}
