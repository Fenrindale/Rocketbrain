package fixture.boot;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class LocalConversationEndpoint {
    private final JdbcTemplate database;

    public LocalConversationEndpoint(JdbcTemplate database) {
        this.database = database;
    }

    @GetMapping("/probe/workspace-conversation")
    String value() {
        Integer records = database.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class);
        if (records == null || records < 1) {
            throw new IllegalStateException("The fixture has no people");
        }
        return LocalConversationFacts.MARKER;
    }
}
