package fixtures.valid;
import org.springframework.stereotype.Component;
import org.springframework.context.annotation.Profile;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
@Component
@Profile("dev")
public class DevConsumer {
    public final Port dependency;
    public final String greeting;
    public DevConsumer(@Qualifier("blue") Port dependency, @Value("${app.greeting:Hello}") String greeting) { this.dependency = dependency; this.greeting = greeting; }
}
