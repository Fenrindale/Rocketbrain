package fixture.movev21;
import java.util.Map;
import fixture.movev21.source.PackageFirst;
import fixture.movev21.source.PackageSecond;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
@RestController
public class MultiController {
    private final JdbcTemplate jdbc;
    public MultiController(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    @GetMapping("/probe/move-v21") public Map<String,Integer> moves() { return Map.of("instance", new InstanceSource().run(), "package", PackageFirst.value()+PackageSecond.value(), "dag", MoveDag.value(), "composite", MoveComposite.value()); }
    @GetMapping("/probe/refactoring") public Map<String,String> refactoring() { return Map.of("value", "value:3", "constructor", "ctor:4"); }
    @GetMapping("/refactoring/move") public int move() { return 42; }
    @GetMapping("/probe/testing-state") public Map<String,Integer> state() { return Map.of("people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class), "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class), "rolledBackNames", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class)); }
}
