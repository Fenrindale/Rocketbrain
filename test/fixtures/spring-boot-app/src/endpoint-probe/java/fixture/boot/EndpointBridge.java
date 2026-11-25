package fixture.boot;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class EndpointBridge {
    private final FixtureEndpointClient client;

    public EndpointBridge(FixtureEndpointClient client) { this.client = client; }

    @GetMapping("/probe/endpoint-routing")
    public Map<String, String> routing() { return Map.of("person", client.person(7), "echo", client.echo()); }
}
