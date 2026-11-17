package fixture.boot.signaturev20;

public class SignatureBase implements SignatureContract {
    @Override
    public String combine(String label, int count, int unused) {
        return label + ":" + count;
    }
}
