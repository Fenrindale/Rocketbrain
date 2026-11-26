package fixture.boot;

import java.util.List;
import java.util.Map;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

interface FetchGraphRepository extends JpaRepository<PerformanceOwner,Long> {
    String QUERY = "select o from PerformanceOwner o where o.id > :floor order by o.id";
    String GRAPH = "PerformanceOwner.withItems";

    @EntityGraph(value=GRAPH, type=EntityGraph.EntityGraphType.FETCH)
    @Query(QUERY)
    List<PerformanceOwner> withNamedFetch(@Param("floor") long floor);

    @EntityGraph(value=GRAPH, type=EntityGraph.EntityGraphType.LOAD)
    @Query(QUERY)
    List<PerformanceOwner> withNamedLoad(@Param("floor") long floor);

    @EntityGraph(value="ignored.dynamic.name", attributePaths={"items"})
    @Query(QUERY)
    List<PerformanceOwner> withDynamic(@Param("floor") long floor);
}

@RestController
public class FetchGraphProbe {
    private final FetchGraphRepository repository;

    FetchGraphProbe(FetchGraphRepository repository) { this.repository = repository; }

    @GetMapping("/probe/hibernate-fetch/graph-fetch")
    @Transactional(readOnly=true)
    Map<String,Integer> fetch() { return count(repository.withNamedFetch(1L)); }

    @GetMapping("/probe/hibernate-fetch/graph-load")
    @Transactional(readOnly=true)
    Map<String,Integer> load() { return count(repository.withNamedLoad(1L)); }

    @GetMapping("/probe/hibernate-fetch/graph-dynamic")
    @Transactional(readOnly=true)
    Map<String,Integer> dynamic() { return count(repository.withDynamic(1L)); }

    private static Map<String,Integer> count(List<PerformanceOwner> owners) {
        return Map.of("owners", owners.size(), "items", owners.stream().mapToInt(owner -> owner.items.size()).sum());
    }
}
