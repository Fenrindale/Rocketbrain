package fixture.dynamicv24.app;

import java.util.Map;
import fixture.dynamicv24.selected.V24BlueBean;
import fixture.dynamicv24.selected.V24GreenBean;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class V24ContractsController {
    private final JdbcTemplate jdbc;
    private final String selectedBlue;
    private final String selectedGreen;
    private final V24BlueBean blue;
    private final V24GreenBean green;
    private final V24BlueBean blueAlias;
    private final V24GreenBean greenAlias;

    public V24ContractsController(JdbcTemplate jdbc,
        @Qualifier("selectedBlue") String selectedBlue, @Qualifier("selectedGreen") String selectedGreen,
        V24BlueBean blue, V24GreenBean green,
        @Qualifier("finiteBlueAlias") V24BlueBean blueAlias,
        @Qualifier("finiteGreenAlias") V24GreenBean greenAlias) {
        this.jdbc = jdbc;
        this.selectedBlue = selectedBlue;
        this.selectedGreen = selectedGreen;
        this.blue = blue;
        this.green = green;
        this.blueAlias = blueAlias;
        this.greenAlias = greenAlias;
    }

    private int obsoleteFiniteV24Helper() { return 42; }

    @GetMapping("/refactoring/spring-contracts-v24")
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
