package fixtures.invalid;
import org.springframework.stereotype.Component;
import org.springframework.beans.factory.annotation.Autowired;
@Component
public class AmbiguousConsumer {
    @Autowired public String dependency;
}
