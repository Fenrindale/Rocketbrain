package fixture.reactive;

import java.sql.DriverManager;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.core.annotation.Order;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PostAuthorize;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.config.annotation.method.configuration.EnableReactiveMethodSecurity;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.SecurityWebFiltersOrder;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.core.userdetails.MapReactiveUserDetailsService;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.security.web.server.util.matcher.ServerWebExchangeMatchers;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

@SpringBootApplication
@EnableWebFluxSecurity
@EnableReactiveMethodSecurity
public class ReactiveSecurityFixture {
    public static void main(String[] args) { SpringApplication.run(ReactiveSecurityFixture.class, args); }

    @Bean
    MapReactiveUserDetailsService users() {
        return new MapReactiveUserDetailsService(
            User.withUsername(System.getenv("RB_OPS")).password("{noop}" + System.getenv("RB_OPS_PASSWORD")).roles("OPS").build(),
            User.withUsername(System.getenv("RB_VIEWER")).password("{noop}" + System.getenv("RB_VIEWER_PASSWORD")).roles("VIEWER").build());
    }

    @Bean @Order(1)
    SecurityWebFilterChain special(ServerHttpSecurity http) {
        return http.securityMatcher(exchange -> ServerWebExchangeMatchers.pathMatchers("/special/**").matches(exchange)
                .publishOn(Schedulers.parallel()))
            .authorizeExchange(exchanges -> exchanges.anyExchange().denyAll()).build();
    }

    @Bean @Order(2)
    SecurityWebFilterChain application(ServerHttpSecurity http) {
        return http.csrf(ServerHttpSecurity.CsrfSpec::disable)
            .httpBasic(spec -> {})
            .addFilterBefore(new HopFilter(), SecurityWebFiltersOrder.AUTHORIZATION)
            .addFilterAfter(new HopFilter(), SecurityWebFiltersOrder.AUTHORIZATION)
            .authorizeExchange(exchanges -> exchanges.pathMatchers("/ready").permitAll()
                .pathMatchers("/rb/web-denied").hasRole("OPS").anyExchange().authenticated())
            .build();
    }

    static final class HopFilter implements WebFilter {
        @Override public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
            return Mono.just(exchange).publishOn(Schedulers.parallel()).flatMap(chain::filter);
        }
    }
}

@RestController
class Requests {
    private final Permissions permissions;
    Requests(Permissions permissions) { this.permissions = permissions; }

    @GetMapping("/ready") ResponseEntity<Map<String, Boolean>> ready() { return ResponseEntity.ok(Map.of("ready", true)); }
    @GetMapping("/rb/web-denied") ResponseEntity<Integer> webDenied() { return ResponseEntity.ok(42); }

    @GetMapping("/rb/pre")
    Mono<ResponseEntity<Map<String, Object>>> before(@RequestParam("private") String probe) {
        return permissions.before(probe).map(ResponseEntity::ok);
    }

    @PostMapping("/rb/post")
    Mono<ResponseEntity<Map<String, Object>>> after() { return permissions.after().map(ResponseEntity::ok); }

    @GetMapping("/rb/counters")
    Map<String, Integer> counters() { return permissions.counters(); }
}

@Service
class Permissions {
    final AtomicInteger beforeReads = new AtomicInteger(), afterReads = new AtomicInteger();

    @PreAuthorize("hasRole('OPS')")
    public Mono<Map<String, Object>> before(String probe) { return read(beforeReads); }

    @PostAuthorize("hasRole('OPS')")
    public Mono<Map<String, Object>> after() { return read(afterReads); }

    public Map<String, Integer> counters() { return Map.of("before", beforeReads.get(), "after", afterReads.get()); }

    private Mono<Map<String, Object>> read(AtomicInteger counter) {
        Thread caller = Thread.currentThread();
        return Mono.fromCallable(() -> {
            counter.incrementAndGet();
            String url = System.getenv("RB_JDBC_URL");
            int value = 42;
            if (url != null) {
                try (var connection = DriverManager.getConnection(url, System.getenv("RB_JDBC_USER"), System.getenv("RB_JDBC_PASSWORD"));
                     var statement = connection.prepareStatement("SELECT 42");
                     var rows = statement.executeQuery()) {
                    if (!rows.next()) throw new IllegalStateException("Expected one JDBC probe row");
                    value = rows.getInt(1);
                }
            }
            return Map.<String, Object>of("value", value, "jdbc", url != null, "schedulerChanged", caller != Thread.currentThread());
        }).subscribeOn(Schedulers.boundedElastic());
    }
}
