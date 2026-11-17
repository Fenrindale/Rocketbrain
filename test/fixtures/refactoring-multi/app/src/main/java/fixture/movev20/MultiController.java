package fixture.movev20;

import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MultiController {
    private final JdbcTemplate jdbc;
    public MultiController(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    @GetMapping("/refactoring/move") public int move() { return MoveAcross.value(); }
    @GetMapping("/probe/refactoring") public Map<String, String> signature() { return Map.of("value", "value:3", "constructor", "ctor:4"); }
    @GetMapping("/probe/move-v20") public Map<String, Integer> members() {
        return Map.of("classValue", MoveAcross.value(), "memberValue", SourceMembers.add(20, 22), "fieldValue", SourceMembers.FIELD_VALUE);
    }
    @GetMapping("/probe/testing-state") public Map<String, Integer> state() {
        return Map.of("people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class),
            "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class),
            "rolledBackNames", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class));
    }
}
