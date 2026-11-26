package wildflyfixture;

import jakarta.ejb.Stateless;
import java.io.IOException;
import java.util.Properties;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

@Stateless
public class InventoryBean {
    public String counts() throws IOException {
        Properties fixture = new Properties();
        try (var data = InventoryBean.class.getResourceAsStream("/wildfly-owned-database.properties")) {
            if (data == null) throw new IOException("Expected a disposable proof database");
            fixture.load(data);
        }
        String url = fixture.getProperty("url");
        if (!url.matches("jdbc:(mysql|mariadb)://127\\.0\\.0\\.1:[0-9]{4,5}/rocketbrain_fixture(?:\\?[A-Za-z0-9=&]+)?")) {
            throw new IOException("Own a local proof database before running the fixture");
        }
        String driver = url.startsWith("jdbc:mysql:") ? "com.mysql.cj.jdbc.Driver" : "org.mariadb.jdbc.Driver";
        var dataSource = new DriverManagerDataSource(url, fixture.getProperty("username"), fixture.getProperty("password"));
        dataSource.setDriverClassName(driver);
        var jdbc = new JdbcTemplate(dataSource);
        jdbc.setQueryTimeout(4);
        long people = jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Long.class);
        long departments = jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Long.class);
        long rolledBack = jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department WHERE name = ?", Long.class,
            "Rolled-back test department");
        return people + ":" + departments + ":" + rolledBack;
    }
}
