package earfixture.beans;

import earfixture.InventoryLocal;
import jakarta.ejb.Stateless;
import java.io.IOException;
import java.util.Properties;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

@Stateless
public class InventoryBean implements InventoryLocal {
    @Override
    public String counts() throws IOException {
        Properties settings = new Properties();
        try (var source = InventoryBean.class.getResourceAsStream("/wildfly-owned-database.properties")) {
            if (source == null) throw new IOException("Expected the owned Spring fixture database");
            settings.load(source);
        }
        String url = settings.getProperty("url");
        if (!url.matches("jdbc:(mysql|mariadb)://127\\.0\\.0\\.1:[0-9]{4,5}/rocketbrain_fixture(?:\\?[A-Za-z0-9=&]+)?")) {
            throw new IOException("Expected the local Spring fixture database");
        }
        String driver = url.startsWith("jdbc:mysql:") ? "com.mysql.cj.jdbc.Driver" : "org.mariadb.jdbc.Driver";
        var dataSource = new DriverManagerDataSource(url, settings.getProperty("username"), settings.getProperty("password"));
        dataSource.setDriverClassName(driver);
        var jdbc = new JdbcTemplate(dataSource);
        jdbc.setQueryTimeout(4);
        int people = jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class);
        int departments = jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department", Integer.class);
        int rolledBack = jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_department WHERE name = ?", Integer.class,
            "Rolled-back test department");
        return people + ":" + departments + ":" + rolledBack + ":" +
            (InventoryBean.class.getClassLoader() != InventoryLocal.class.getClassLoader());
    }
}
