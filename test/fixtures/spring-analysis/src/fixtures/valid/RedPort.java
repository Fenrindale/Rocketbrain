package fixtures.valid;
import org.springframework.stereotype.Component;
import org.springframework.context.annotation.Primary;
import org.springframework.context.annotation.Profile;
@Component
@Primary
@Profile("prod")
public class RedPort implements Port {
    public String id() { return "red"; }
}
