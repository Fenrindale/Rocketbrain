package fixture.boot;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
public interface PersonRepository extends JpaRepository<Person,Long> {
    List<Person> findByDisplayName(String displayName);
    List<Person> findByAddress_City(String city);
    @Query("select p from Person p join p.department d where d.name = :departmentName")
    List<Person> byDepartment(@Param("departmentName") String departmentName);
}
