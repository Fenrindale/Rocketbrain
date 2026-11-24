package fixture.statev27;

import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class StateController {
    private final JdbcTemplate jdbc;

    public StateController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/probe/move-state-v27")
    public Map<String, Integer> moveReferences() {
        MutableOwner owner = new MutableOwner();
        IncomingOwner borrower = new IncomingOwner();
        RefTarget first = new RefTarget(10);
        RefTarget second = new RefTarget(20);
        return Map.ofEntries(
                Map.entry("incomingAlias", owner.runIncoming(first, 2)),
                Map.entry("retainedAcrossCalls", owner.runCurrent(second, 1)),
                Map.entry("ownedRebind", owner.runOwned(first, 3)),
                Map.entry("allocationRebind", owner.runNew(1)),
                Map.entry("clear", owner.runClear(2)),
                Map.entry("retainedNull", owner.runCurrent(null, 1)),
                Map.entry("borrowed", borrower.runBorrowed(first, second, 2)),
                Map.entry("borrowedAlias", borrower.runAliased(first, 1)),
                Map.entry("borrowedNull", borrower.runBorrowed(null, first, 4)),
                Map.entry("externalFirst", first.current()),
                Map.entry("externalSecond", second.current()));
    }

    @GetMapping("/probe/refactoring")
    public Map<String, String> refactoring() {
        return Map.of("value", "value:3", "constructor", "ctor:4");
    }

    @GetMapping("/refactoring/move")
    public int move() {
        return 42;
    }

    @GetMapping("/probe/testing-state")
    public Map<String, Integer> state() {
        return Map.of("people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class),
                "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class),
                "rolledBackNames", jdbc.queryForObject(
                        "SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class));
    }
}
