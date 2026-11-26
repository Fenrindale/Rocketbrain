package fixture.interceptor;

import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.WebApplicationException;

@Path("/fixture-arc/interceptor")
public class InterceptorResource {
    @Inject TracedService service;

    @GET @Path("/{action}")
    public String test(@PathParam("action") String action) {
        return switch (action) {
            case "plain" -> "plain";
            case "text" -> service.render("fixture-private-argument");
            case "number" -> service.render(7);
            case "blocked" -> service.blocked();
            case "foreign" -> service.foreign();
            case "failure" -> {
                try { yield service.failure(); }
                catch (IllegalArgumentException expected) { yield "caught"; }
            }
            default -> throw new WebApplicationException(404);
        };
    }
}
