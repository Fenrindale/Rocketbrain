package fixture.security;

import java.util.Map;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.actuate.audit.AuditEventRepository;
import org.springframework.boot.actuate.audit.InMemoryAuditEventRepository;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.web.server.context.WebServerInitializedEvent;
import org.springframework.context.annotation.Bean;
import org.springframework.context.event.EventListener;
import org.springframework.core.annotation.Order;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
public class SecurityFixtureApplication {
    private final JdbcClient jdbc;

    public SecurityFixtureApplication(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public static void main(String[] args) {
        SpringApplication.run(SecurityFixtureApplication.class, args);
    }

    @Bean
    AuditEventRepository auditEventRepository() {
        return new InMemoryAuditEventRepository();
    }

    @Bean
    UserDetailsService fixtureUsers(Environment environment) {
        var encoder = PasswordEncoderFactories.createDelegatingPasswordEncoder();
        return new InMemoryUserDetailsManager(
            User.withUsername(environment.getRequiredProperty("RB_SECURITY_OPERATOR"))
                .password(encoder.encode(environment.getRequiredProperty("RB_SECURITY_OPERATOR_PASSWORD")))
                .roles("OPS").build(),
            User.withUsername(environment.getRequiredProperty("RB_SECURITY_REVIEWER"))
                .password(encoder.encode(environment.getRequiredProperty("RB_SECURITY_REVIEWER_PASSWORD")))
                .roles("REVIEWER").build(),
            User.withUsername(environment.getRequiredProperty("RB_SECURITY_VIEWER"))
                .password(encoder.encode(environment.getRequiredProperty("RB_SECURITY_VIEWER_PASSWORD")))
                .roles("VIEWER").build());
    }

    @Bean
    @Order(1)
    SecurityFilterChain fixtureManagementChain(HttpSecurity http) throws Exception {
        return http.securityMatcher("/actuator/**")
            .authorizeHttpRequests(requests -> requests.anyRequest().hasRole("OPS"))
            .httpBasic(Customizer.withDefaults()).build();
    }

    @Bean
    @Order(2)
    SecurityFilterChain fixtureApplicationChain(HttpSecurity http) throws Exception {
        return http.authorizeHttpRequests(requests -> requests.requestMatchers("/ready").permitAll()
                .requestMatchers("/secure/db").hasRole("REVIEWER").anyRequest().denyAll())
            .httpBasic(Customizer.withDefaults()).build();
    }

    @GetMapping("/ready")
    Map<String, Boolean> ready() {
        return Map.of("ready", true);
    }

    @GetMapping("/secure/db")
    Map<String, Long> databaseSeedCount() {
        return Map.of("people", jdbc.sql("SELECT COUNT(*) FROM rb_spring_person").query(Long.class).single(),
            "departments", jdbc.sql("SELECT COUNT(*) FROM rb_spring_department").query(Long.class).single());
    }

    @EventListener
    void reportBoundPort(WebServerInitializedEvent event) {
        System.out.println("RocketbrainSecurityFixture listening on " + event.getWebServer().getPort());
    }
}
