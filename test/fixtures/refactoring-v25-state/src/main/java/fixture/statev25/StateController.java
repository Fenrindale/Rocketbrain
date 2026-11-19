package fixture.statev25;

import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class StateController {
    private final JdbcTemplate jdbc;

    public StateController(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @GetMapping("/probe/move-state-v25")
    public Map<String, Integer> moveReferences() {
        FieldSource field = new FieldSource();
        ParameterSource parameter = new ParameterSource();
        return Map.of("sharedFirst", field.runShared(3), "sharedSecond", field.runShared(1),
                "distinctSameOwner", field.runDistinct(2), "distinctNewOwner", new FieldSource(4).runDistinct(3),
                "parameterFirst", parameter.run(3), "parameterSecond", parameter.run(2),
                "parameterNewOwner", new ParameterSource().run(3));
    }

    @GetMapping("/probe/refactoring")
    public Map<String, String> refactoring() { return Map.of("value", "value:3", "constructor", "ctor:4"); }

    @GetMapping("/refactoring/move")
    public int move() { return 42; }

    @GetMapping("/probe/testing-state")
    public Map<String, Integer> state() {
        return Map.of("people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class),
                "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class),
                "rolledBackNames", jdbc.queryForObject(
                        "SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class));
    }
}
