package fixture.statev24;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
@RestController
public class StateController {
    private final JdbcTemplate jdbc;
    public StateController(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    @GetMapping("/probe/move-state-v24") public Map<String,Integer> moves() {
        FieldSource field = new FieldSource();
        ParameterSource parameter = new ParameterSource();
        return Map.of("fieldFirst", field.run(3), "fieldSecond", field.run(5), "fieldOtherOwner", new FieldSource(7).run(3), "parameterFirst", parameter.run(3), "parameterSecond", parameter.run(5), "parameterOtherOwner", new ParameterSource(9).run(3));
    }
    @GetMapping("/probe/refactoring") public Map<String,String> refactoring() { return Map.of("value", "value:3", "constructor", "ctor:4"); }
    @GetMapping("/refactoring/move") public int move() { return 42; }
    @GetMapping("/probe/testing-state") public Map<String,Integer> state() { return Map.of("people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class), "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class), "rolledBackNames", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class)); }
}
