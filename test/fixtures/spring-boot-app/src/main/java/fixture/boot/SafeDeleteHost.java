package fixture.boot;

public final class SafeDeleteHost {
    private static int unusedValue() { return 42; }
    private static int usedValue() { return 7; }
    public static void main(String[] args) { System.out.print(usedValue()); }
}
