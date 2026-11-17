package fixture.boot.signaturev20;

final class SignatureExternal implements java.util.function.IntUnaryOperator {
    @Override public int applyAsInt(int value) { return value; }
}

interface SignatureDiamondA { String diamond(String label); }
interface SignatureDiamondB { String diamond(String label); }
final class SignatureDiamond implements SignatureDiamondA, SignatureDiamondB {
    @Override public String diamond(String label) { return label; }
}
