package fixture.boot.signaturev20;

public final class SignatureConstructors {
    private final String value;

    public SignatureConstructors(String label, int count, int unused) {
        value = label + ":" + count;
    }

    public SignatureConstructors(String label) {
        value = "single:" + label;
    }

    public String value() {
        return value;
    }
}
