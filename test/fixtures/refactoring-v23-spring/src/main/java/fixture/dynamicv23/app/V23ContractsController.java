package fixture.dynamicv23.app;

import java.util.Map;
import fixture.dynamicv23.selected.V23BlueBean;
import fixture.dynamicv23.selected.V23GreenBean;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class V23ContractsController {
    private final JdbcTemplate jdbc;
    private final String selectedBlue;
    private final String selectedGreen;
    private final V23BlueBean blue;
    private final V23GreenBean green;
    private final V23BlueBean blueAlias;
    private final V23GreenBean greenAlias;

    public V23ContractsController(JdbcTemplate jdbc,
        @Qualifier("selectedBlue") String selectedBlue, @Qualifier("selectedGreen") String selectedGreen,
        V23BlueBean blue, V23GreenBean green,
        @Qualifier("finiteBlueAlias") V23BlueBean blueAlias,
        @Qualifier("finiteGreenAlias") V23GreenBean greenAlias) {
        this.jdbc = jdbc;
        this.selectedBlue = selectedBlue;
        this.selectedGreen = selectedGreen;
        this.blue = blue;
        this.green = green;
        this.blueAlias = blueAlias;
        this.greenAlias = greenAlias;
    }

    private int obsoleteFiniteV23Helper() { return 42; }

    @GetMapping("/refactoring/spring-contracts-v23")
    public Map<String, Object> contracts() {
        return Map.of("selectedBlue", selectedBlue, "selectedGreen", selectedGreen,
            "blue", blue.value(), "green", green.value(),
            "aliases", blue == blueAlias && green == greenAlias);
    }

    @GetMapping("/probe/testing-state")
    public Map<String, Integer> state() {
        return Map.of("people", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class),
            "departments", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class),
            "rolledBackNames", jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department WHERE name = 'Rolled-back test department'", Integer.class));
    }

    @GetMapping("/probe/refactoring")
    public Map<String, String> refactoring() { return Map.of("value", "finite:42", "constructor", "ctor:42"); }

    @GetMapping("/refactoring/move")
    public int move() { return 42; }
}
