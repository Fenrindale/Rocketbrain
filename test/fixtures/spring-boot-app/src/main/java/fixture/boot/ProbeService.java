package fixture.boot;
import java.util.Map;
import java.util.LinkedHashMap;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import jakarta.persistence.EntityManager;
import org.hibernate.Hibernate;
@Service
public class ProbeService {
    private final PersonRepository people;
    private final EntityManager em;
    public ProbeService(PersonRepository people, EntityManager em) { this.people=people; this.em=em; }
    @Transactional(readOnly=true)
    public Map<String,Object> probe() {
        Map<String,Object> result = new LinkedHashMap<>();
        Person person = people.findByDisplayName("Alex").getFirst();
        // DEBUG_GATE: entity loaded inside the real transaction before lazy association access.
        result.put("derivedCount", people.findByAddress_City("Seoul").size());
        result.put("jpqlCount", people.byDepartment("Engineering").size());
        result.put("lazyBefore", Hibernate.isInitialized(person.getDepartment()));
        result.put("department", person.getDepartment().getName());
        result.put("lazyAfter", Hibernate.isInitialized(person.getDepartment()));
        result.put("embeddedCity", person.getAddress().getCity());
        return result;
    }
    public Map<String,Object> invalidQuery() {
        try { em.createQuery("select p from Person p where p.missingProperty = :value",Person.class).setParameter("value","bad").getResultList(); }
        catch (RuntimeException error) { return Map.of("invalidJpqlError",error.getClass().getSimpleName()); }
        return Map.of("invalidJpqlError","not detected");
    }
    public Map<String,Object> lazyOutside() {
        Person person = people.findByDisplayName("Alex").getFirst();
        try { return Map.of("department", person.getDepartment().getName()); }
        catch(RuntimeException error) { return Map.of("error", error.getClass().getSimpleName()); }
    }
}
