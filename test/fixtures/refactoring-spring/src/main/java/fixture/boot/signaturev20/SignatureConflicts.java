package fixture.boot.signaturev20;

public final class SignatureConflicts {
    public static String collision(String label, int unused) { return label; }
    public static String collision(String label) { return label; }
    public static String collisionCaller() { return collision("keep", 0); }

    public static String rebound(Object label, int unused) { return "object"; }
    public static String rebound(String label) { return "string"; }
    public static String reboundCaller() { return rebound("keep", 0); }
}
