package fixture.conditionsv25.app;

import java.util.Map;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ConditionRoutesController {
    private final JdbcTemplate jdbc;
    private final Map<String, Object> conditions;

    public ConditionRoutesController(
        JdbcTemplate jdbc,
        @Qualifier("conditionalBlue") String conditionalBlue,
        @Qualifier("conditionalGreen") Optional<String> conditionalGreen,
        @Qualifier("profilePresent") String profilePresent,
        @Qualifier("profileAbsent") Optional<String> profileAbsent,
        @Qualifier("expressionPresent") String expressionPresent,
        @Qualifier("expressionAbsent") Optional<String> expressionAbsent,
        @Qualifier("classPresent") String classPresent,
        @Qualifier("classMissing") Optional<String> classMissing,
        @Qualifier("namedBean") String namedBean
    ) {
        this.jdbc = jdbc;
        this.conditions = Map.of("conditionalBlue", conditionalBlue, "conditionalGreen", conditionalGreen.isPresent(),
            "profilePresent", profilePresent, "profileAbsent", profileAbsent.isPresent(),
            "expressionPresent", expressionPresent, "expressionAbsent", expressionAbsent.isPresent(),
            "classPresent", classPresent, "classMissing", classMissing.isPresent(), "namedBean", namedBean);
    }

    private int obsoleteConditionV25Helper() { return 42; }

    @GetMapping("/refactoring/spring-conditions-v25")
    public Map<String, Object> conditions() { return conditions; }

    @GetMapping("/probe/testing-state")
    public Map<String, Integer> state() {
        return Map.of("people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class),
            "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class),
            "rolledBackNames", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class));
    }

    @GetMapping("/probe/refactoring")
    public Map<String, String> refactoring() { return Map.of("value", "conditions:42", "constructor", "ctor:42"); }

    @GetMapping("/refactoring/move")
    public int move() { return 42; }
}
