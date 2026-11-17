package fixture.boot.signaturev20;

public final class SignatureChild extends SignatureBase {
    @Override
    public String combine(String label, int count, int unused) {
        return label + ":" + count;
    }
}
