package fixture.interceptor;

import jakarta.enterprise.context.ApplicationScoped;

@ApplicationScoped @Audited(value = "standard", note = "fixture-private-service")
public class TracedService {
    @Detailed
    public String render(String input) {
        return "string:" + input.length();
    }

    public String render(int input) {
        return "int:" + input;
    }

    @Audited("halt") @Detailed
    public String blocked() {
        throw new AssertionError("The target must not be called");
    }

    @Audited("external")
    public String foreign() {
        return "target";
    }

    public String failure() {
        throw new IllegalArgumentException("fixture-private-failure");
    }
}
