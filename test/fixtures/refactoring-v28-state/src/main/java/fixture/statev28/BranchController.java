package fixture.statev28;

import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class BranchController {
    private final JdbcTemplate jdbc;

    public BranchController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/probe/branch-move")
    public Map<String, Integer> branchMove() {
        BranchOwner owner = new BranchOwner();
        RefTarget incoming = new RefTarget(5);
        return Map.of(
                "trueBranch", owner.choose(true, incoming, 1),
                "sameReference", owner.current(incoming, 1),
                "falseBranch", owner.choose(false, incoming, 1),
                "retainedElse", owner.reset(true, incoming, 1),
                "nullBranch", owner.reset(false, incoming, 1),
                "retainedNull", owner.current(incoming, 1),
                "incoming", incoming.current(),
                "people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class));
    }

    @GetMapping("/refactoring/move")
    public int ready() {
        return 42;
    }

    @GetMapping("/probe/testing-state")
    public Map<String, Integer> databaseState() {
        return Map.of("people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class),
                "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class),
                "rolledBackNames", jdbc.queryForObject(
                        "SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class));
    }
}
