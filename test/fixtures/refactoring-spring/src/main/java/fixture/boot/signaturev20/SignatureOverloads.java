package fixture.boot.signaturev20;

public final class SignatureOverloads {
    public static String format(String label, int count, int unused) {
        return label + ":" + count;
    }

    public static String format(String label) {
        return "short:" + label;
    }
}
