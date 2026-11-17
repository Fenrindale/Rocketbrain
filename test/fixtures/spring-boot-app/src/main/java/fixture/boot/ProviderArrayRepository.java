package fixture.boot;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
public interface ProviderArrayRepository extends JpaRepository<Person,Long> {
    @Query("select p.displayName from Person p where p.id in :ids order by p.id")
    List<String> byIds(@Param("ids") Long[] ids);
}
