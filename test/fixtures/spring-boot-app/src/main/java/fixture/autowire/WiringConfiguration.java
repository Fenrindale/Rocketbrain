package fixture.autowire;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

@Configuration(proxyBeanMethods = false)
public class WiringConfiguration {
    @Bean("fastMode")
    @Qualifier("fast-read")
    public Mode fast(JdbcTemplate database) {
        return () -> "fast:" + database.queryForObject("SELECT VERSION()", String.class);
    }

    @Bean(name = {"directMode", "legacyDirect"})
    public Mode direct(JdbcTemplate database) {
        return () -> "direct:" + database.queryForObject("SELECT VERSION()", String.class);
    }
}
