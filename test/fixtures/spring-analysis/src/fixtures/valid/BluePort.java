package fixtures.valid;
import org.springframework.stereotype.Component;
import org.springframework.beans.factory.annotation.Qualifier;
@Component("bluePort")
@Qualifier("blue")
public class BluePort implements Port {
    public String id() { return "blue"; }
}
