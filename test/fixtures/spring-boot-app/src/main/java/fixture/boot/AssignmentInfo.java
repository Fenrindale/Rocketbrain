package fixture.boot;
import jakarta.persistence.*;
@Embeddable
public class AssignmentInfo {
    @ManyToOne(fetch=FetchType.LAZY) private Department department;
    protected AssignmentInfo() {}
    public AssignmentInfo(Department department) { this.department=department; }
    public Department getDepartment() { return department; }
}
