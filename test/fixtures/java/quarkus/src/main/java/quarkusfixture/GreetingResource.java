package quarkusfixture;

import io.quarkus.qute.Location;
import io.quarkus.qute.Template;
import io.quarkus.qute.TemplateInstance;
import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import org.eclipse.microprofile.config.inject.ConfigProperty;

@Path("/greeting")
public class GreetingResource {
    @Inject
    GreetingConfig config;

    @ConfigProperty(name = "greeting.suffix", defaultValue = "!")
    String suffix;

    @Inject
    @Location("greeting.html")
    Template greeting;

    @GET
    @Produces(MediaType.TEXT_PLAIN)
    public String greeting() {
        return (config.text() + suffix + ";").repeat(config.copies());
    }

    @GET
    @Path("/page")
    @Produces(MediaType.TEXT_HTML)
    public TemplateInstance page() {
        return greeting.data("message", config.text() + suffix);
    }
}
