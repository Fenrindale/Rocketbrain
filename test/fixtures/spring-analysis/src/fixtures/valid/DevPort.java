package fixtures.valid;
import org.springframework.stereotype.Component;
import org.springframework.context.annotation.Profile;
@Component
@Profile("dev & !prod")
public class DevPort implements Port {
    public String id() { return "dev"; }
}
