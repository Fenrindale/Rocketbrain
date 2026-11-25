package fixture.autowire;

import org.springframework.stereotype.Component;

@Component
public class WiringConsumer {
    private final Mode mode;

    public WiringConsumer(Mode mode) {
        this.mode = mode;
    }

    public String result() {
        return mode.read();
    }
}
