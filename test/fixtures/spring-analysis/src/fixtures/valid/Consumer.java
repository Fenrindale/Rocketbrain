package fixtures.valid;
import java.util.List;
import org.springframework.stereotype.Component;
import org.springframework.context.annotation.Profile;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
@Component
@Profile("prod")
public class Consumer {
    @Autowired @Qualifier("blue") public Port blue;
    @Autowired public Port preferred;
    @Autowired public List<Port> all;
    @Value("${app.greeting:Hello}") public String greeting;
    @Autowired(required = false) public UnknownThing optionalUnknown;
}
