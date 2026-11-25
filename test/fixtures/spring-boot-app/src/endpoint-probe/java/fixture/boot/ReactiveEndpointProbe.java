package fixture.boot;

import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.openfeign.EnableFeignClients;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.MediaType;
import org.springframework.http.server.reactive.ReactorHttpHandlerAdapter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.reactive.function.server.RequestPredicates;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;
import reactor.netty.DisposableServer;
import reactor.netty.http.server.HttpServer;

@Configuration(proxyBeanMethods = false)
@EnableFeignClients(clients = FixtureEndpointClient.class)
public class ReactiveEndpointProbe {
    @Bean
    RouterFunction<ServerResponse> endpointProbeRoutes(JdbcTemplate jdbc) {
        return RouterFunctions.route()
            .path("/endpoint-fixture", api -> api
                .GET("/people/{id}", RequestPredicates.accept(MediaType.TEXT_PLAIN), request ->
                    Mono.fromCallable(() -> jdbc.queryForObject("SELECT VERSION()", String.class))
                        .subscribeOn(Schedulers.boundedElastic())
                        .flatMap(version -> ServerResponse.ok().contentType(MediaType.TEXT_PLAIN)
                            .bodyValue("GET:" + request.pathVariable("id") + ":" + version)))
                .nest(RequestPredicates.path("/commands"), commands -> commands
                    .POST("/echo", request -> ServerResponse.ok().contentType(MediaType.TEXT_PLAIN).bodyValue("POST:echo"))))
            .add(RouterFunctions.route(RequestPredicates.GET("/endpoint-static"), request ->
                ServerResponse.ok().contentType(MediaType.TEXT_PLAIN).bodyValue("static")))
            .GET(dynamicProbePath(), request -> ServerResponse.ok().contentType(MediaType.TEXT_PLAIN).bodyValue("dynamic"))
            .build();
    }

    private String dynamicProbePath() { return "/endpoint-computed"; }

    @Bean(destroyMethod = "disposeNow")
    DisposableServer endpointProbeServer(RouterFunction<ServerResponse> endpointProbeRoutes,
            @Value("${fixture.endpoint.probe.port}") int port) {
        var adapter = new ReactorHttpHandlerAdapter(RouterFunctions.toHttpHandler(endpointProbeRoutes));
        return HttpServer.create().host("127.0.0.1").port(port).handle(adapter).bindNow(Duration.ofSeconds(10));
    }
}
