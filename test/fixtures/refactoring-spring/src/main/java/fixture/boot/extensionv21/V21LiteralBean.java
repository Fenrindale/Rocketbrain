package fixture.boot.extensionv21;

import jakarta.annotation.PostConstruct;

public final class V21LiteralBean {
    private boolean initialized;

    @PostConstruct
    private void initializeV21Literal() { initialized = true; }

    public boolean initialized() { return initialized; }
    public String value() { return "v21-literal"; }
}
