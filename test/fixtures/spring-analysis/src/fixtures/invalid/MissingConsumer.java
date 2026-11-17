package fixtures.invalid;
import org.springframework.stereotype.Component;
import org.springframework.beans.factory.annotation.Autowired;
import fixtures.valid.Port;
@Component
public class MissingConsumer {
    @Autowired public Port missing;
}
