package fixture.boot;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
public interface TypedPersonRepository extends JpaRepository<Person,Long> {
    @Query("select p.displayName from #{#entityName} p where p.displayName = :#{#filter.name} order by p.displayName")
    List<String> byFilter(@Param("filter") NameFilter filter);
    @Query("select p.displayName from #{#entityName} p where p.displayName = :#{#filter?.name ?: 'Alex'} order by p.displayName")
    List<String> bySafeFilter(@Param("filter") NameFilter filter);
    @Query("select p.displayName from Person p where p.address.city = ?#{[0].city} order by p.displayName")
    List<String> byIndexed(NameFilter filter);
    @Query("select p.displayName from Person p where p.id >= :#{#minimum + 1} order by p.displayName")
    List<String> above(@Param("minimum") Long minimum);
    @Query("select p.displayName from Person p where p.address.city = :#{#filter.city != null ? #filter.city : 'Seoul'} order by p.displayName")
    List<String> byFallback(@Param("filter") NameFilter filter);
    @Query("select p.displayName from Person p where p.id = :id")
    List<String> byTypedId(@Param("id") Long id);
    @Query("select p.displayName from Person p where lower(p.displayName) = :#{#filter.name.toLowerCase()} order by p.displayName")
    List<String> byLower(@Param("filter") NameFilter filter);
}
