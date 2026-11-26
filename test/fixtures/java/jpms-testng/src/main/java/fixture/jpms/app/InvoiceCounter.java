package fixture.jpms.app;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

public final class InvoiceCounter {
    private final JdbcTemplate jdbc;

    public InvoiceCounter(String url, String user, String password) {
        jdbc = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
    }

    public int count() {
        return jdbc.queryForObject("SELECT 42", Integer.class);
    }

    public String serverVersion() {
        return jdbc.queryForObject("SELECT VERSION()", String.class);
    }
}
