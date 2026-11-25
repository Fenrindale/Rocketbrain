package fixture.boot;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;

@FeignClient(name = "fixtureEndpoint", url = "http://127.0.0.1:${fixture.endpoint.probe.port}", path = "/endpoint-fixture/")
public interface FixtureEndpointClient {
    @GetMapping(value = "/people/{id}", produces = "text/plain")
    String person(@PathVariable("id") int id);

    @RequestMapping(path = "/commands/echo", method = RequestMethod.POST)
    String echo();
}
