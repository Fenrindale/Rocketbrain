package fixture.conditionsv27.app;

import java.util.Map;
import java.util.Optional;
import fixture.conditionsv27.conditions.FixedChoice;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@FixedChoice
public class ConditionRoutesController {
    private final JdbcTemplate jdbc;
    private final Map<String, Object> conditions;

    public ConditionRoutesController(
        JdbcTemplate jdbc,
        @Qualifier("blueChoice") String blueChoice,
        @Qualifier("greenChoice") Optional<String> greenChoice,
        @Qualifier("fallbackChoice") String fallbackChoice,
        @Qualifier("ternaryTrue") String ternaryTrue,
        @Qualifier("ternaryFalse") Optional<String> ternaryFalse,
        @Qualifier("bothProperties") String bothProperties,
        @Qualifier("rejectedProperty") Optional<String> rejectedProperty,
        @Qualifier("expectedFalse") String expectedFalse,
        @Qualifier("defaultMissing") String defaultMissing,
        @Qualifier("flagOverride") String flagOverride,
        @Qualifier("flagDenied") Optional<String> flagDenied,
        @Qualifier("flagDefault") String flagDefault
    ) {
        this.jdbc = jdbc;
        this.conditions = Map.ofEntries(
            Map.entry("blueChoice", blueChoice), Map.entry("greenChoiceAbsent", greenChoice.isEmpty()),
            Map.entry("fallbackChoice", fallbackChoice), Map.entry("ternaryTrue", ternaryTrue),
            Map.entry("ternaryFalse", ternaryFalse.isPresent()), Map.entry("bothProperties", bothProperties),
            Map.entry("rejectedProperty", rejectedProperty.isPresent()), Map.entry("expectedFalse", expectedFalse),
            Map.entry("defaultMissing", defaultMissing), Map.entry("flagOverride", flagOverride),
            Map.entry("flagDenied", flagDenied.isPresent()), Map.entry("flagDefault", flagDefault));
    }

    private int obsoleteConditionV27Helper() { return 42; }

    @GetMapping("/refactoring/spring-conditions-v27")
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
