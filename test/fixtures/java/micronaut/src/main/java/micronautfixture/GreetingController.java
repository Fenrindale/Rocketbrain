package micronautfixture;

import io.micronaut.context.annotation.Value;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;
import io.micronaut.scheduling.TaskExecutors;
import io.micronaut.scheduling.annotation.ExecuteOn;

@Controller("/greeting")
@ExecuteOn(TaskExecutors.BLOCKING)
public class GreetingController {
    private final GreetingConfiguration configuration;
    private final String suffix;

    public GreetingController(GreetingConfiguration configuration, @Value("${greeting.suffix:!}") String suffix) {
        this.configuration = configuration;
        this.suffix = suffix;
    }

    @Get(produces = "text/plain")
    public String greeting() {
        return (configuration.getMessage() + suffix + ";").repeat(configuration.getRepeatCount());
    }

    @Get(value = "/length", produces = "text/plain")
    public String length() {
        return String.valueOf(configuration.getMessage().length());
    }
}
